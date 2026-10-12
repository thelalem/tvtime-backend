const { config } = require('./config');

// TMDB rate-limits per IP, and a classification pass reads one show plus every
// one of its seasons. Uncapped, a single pull-to-refresh fired hundreds of
// parallel requests; the 429s surfaced as hard 502s, so `refreshClassification`
// threw before its UPDATE and the whole batch stayed stale.
const tmdbConcurrency = 6;
const tmdbMaxAttempts = 3;
const tmdbRetryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

// Aired episode lists barely move, so classification reads share a short cache.
// It also collapses duplicate reads within one sweep: every user tracking the
// same show would otherwise re-fetch all of its seasons.
const classificationCacheTtlMs = 30 * 60 * 1000;
const classificationCacheMaxEntries = 500;
const classificationCache = new Map();

let tmdbActive = 0;
const tmdbQueue = [];

function providerError(message, status, cause) {
  const error = new Error(message);
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}, unavailableMessage = 'Provider is unavailable') {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    throw providerError(
      cause.name === 'TimeoutError' ? 'Provider timed out' : unavailableMessage,
      cause.name === 'TimeoutError' ? 504 : 502,
      cause,
    );
  }

  if (!response.ok) {
    // Keep the upstream status on the error so callers can tell a retryable
    // 429 from a permanent 404 — both used to arrive as an opaque 502.
    const error = providerError('Provider request failed', 502);
    error.providerStatus = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.retryAfterMs = Math.min(retryAfter * 1000, 10000);
    }
    throw error;
  }
  return response.json();
}

// Runs `load` once a TMDB slot frees up, so bursts queue instead of being
// rate-limited. The slot passes straight to the next waiter on release.
async function withTmdbSlot(load) {
  if (tmdbActive < tmdbConcurrency) {
    tmdbActive += 1;
  } else {
    await new Promise((resolve) => tmdbQueue.push(resolve));
  }

  try {
    return await load();
  } finally {
    const next = tmdbQueue.shift();
    if (next) next();
    else tmdbActive -= 1;
  }
}

function requireTmdb() {
  if (!config.tmdbAccessToken) {
    throw providerError('TV metadata provider is not configured', 503);
  }
}

function tmdbUrl(path, query = {}) {
  requireTmdb();
  const url = new URL(`${config.tmdbBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function tmdbOptions() {
  return {
    headers: {
      Authorization: `Bearer ${config.tmdbAccessToken}`,
      accept: 'application/json',
    },
  };
}

async function tmdbGet(path, query) {
  // Built once, outside the loop: `tmdbUrl` validates configuration, and a
  // missing token is permanent, not a transient provider fault to retry.
  const url = tmdbUrl(path, query);
  const options = tmdbOptions();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withTmdbSlot(
        () => requestJson(url, options, 'TV metadata provider is unavailable'),
      );
    } catch (error) {
      const status = error.providerStatus ?? error.status;
      if (attempt >= tmdbMaxAttempts || !tmdbRetryableStatuses.has(status)) {
        throw error;
      }
      // Backs off outside the slot, so waiting never blocks the queue.
      await delay(error.retryAfterMs ?? attempt * 500);
    }
  }
}

// Serves `load` from cache, collapsing concurrent reads of the same key into
// one request. Results are shared by reference — callers must not mutate them.
function cachedClassificationRead(key, load, { forceRefresh = false } = {}) {
  if (forceRefresh) classificationCache.delete(key);
  const entry = classificationCache.get(key);
  if (entry) {
    if (entry.pending) return entry.pending;
    if (entry.expiresAt > Date.now()) return Promise.resolve(entry.value);
  }

  const pending = load()
    .then((value) => {
      classificationCache.set(key, {
        value,
        expiresAt: Date.now() + classificationCacheTtlMs,
      });
      pruneClassificationCache();
      return value;
    })
    .catch((error) => {
      // Never cache a failure: the next pull-to-refresh must be free to retry.
      classificationCache.delete(key);
      throw error;
    });
  classificationCache.set(key, { pending });
  return pending;
}

function pruneClassificationCache() {
  if (classificationCache.size <= classificationCacheMaxEntries) return;
  const now = Date.now();
  for (const [key, entry] of classificationCache) {
    if (!entry.pending && entry.expiresAt <= now) classificationCache.delete(key);
  }
  // Still over budget, so drop entries oldest-first (Map iterates in insertion
  // order). In-flight reads stay — something is already awaiting them.
  for (const [key, entry] of classificationCache) {
    if (classificationCache.size <= classificationCacheMaxEntries) break;
    if (!entry.pending) classificationCache.delete(key);
  }
}

async function searchTv(query) {
  return tmdbGet('/search/tv', { query });
}

async function getTvShow(showId) {
  return tmdbGet(`/tv/${showId}`, {
    append_to_response: 'aggregate_credits,videos,watch/providers,external_ids',
  });
}

async function getTvShowClassificationData(showId, { forceRefresh = false } = {}) {
  return cachedClassificationRead(
    `show:${showId}`,
    () => tmdbGet(`/tv/${showId}`),
    { forceRefresh },
  );
}

async function getTvSeason(showId, seasonNumber, { forceRefresh = false } = {}) {
  return cachedClassificationRead(
    `season:${showId}:${seasonNumber}`,
    () => tmdbGet(`/tv/${showId}/season/${seasonNumber}`),
    { forceRefresh },
  );
}

async function getDiscovery(kind, query = {}) {
  const paths = {
    popular: '/tv/popular',
    top_rated: '/tv/top_rated',
    trending: '/trending/tv/week',
    discover: '/discover/tv',
  };
  if (!paths[kind]) throw providerError('Unknown discovery feed', 400);
  return tmdbGet(paths[kind], query);
}

async function getOmdbSeasonRatings(imdbId, seasonNumber) {
  if (!config.omdbApiKey) {
    return { ratings: {}, configured: false };
  }

  const url = new URL(config.omdbBaseUrl);
  url.searchParams.set('apikey', config.omdbApiKey);
  url.searchParams.set('i', imdbId);
  url.searchParams.set('Season', String(seasonNumber));
  const data = await requestJson(url, {}, 'OMDb is unavailable');
  if (data.Response === 'False' || !Array.isArray(data.Episodes)) {
    return { ratings: {}, configured: true };
  }

  const ratings = {};
  for (const episode of data.Episodes) {
    const episodeNumber = Number.parseInt(episode.Episode, 10);
    const rating = Number.parseFloat(episode.imdbRating);
    if (Number.isInteger(episodeNumber) && Number.isFinite(rating) && rating > 0) {
      ratings[`${seasonNumber}_${episodeNumber}`] = rating;
    }
  }
  return { ratings, configured: true };
}

async function getImdbRatings(showId) {
  const show = await getTvShow(showId);
  const imdbId = show.external_ids && show.external_ids.imdb_id;
  if (!imdbId) return { imdbId: null, ratings: {}, configured: Boolean(config.omdbApiKey) };

  const seasons = Array.isArray(show.seasons) ? show.seasons : [];
  const results = await Promise.all(
    seasons
      .filter((season) => Number(season.season_number) > 0)
      .map((season) => getOmdbSeasonRatings(imdbId, season.season_number)),
  );
  return {
    imdbId,
    configured: Boolean(config.omdbApiKey),
    ratings: Object.assign({}, ...results.map((result) => result.ratings)),
  };
}

async function getTvMazeShow(name) {
  const url = new URL(`${config.tvMazeBaseUrl.replace(/\/$/, '')}/singlesearch/shows`);
  url.searchParams.set('q', name);
  try {
    return await requestJson(url, {}, 'TVMaze is unavailable');
  } catch (error) {
    if (error.status === 502 || error.status === 504) return null;
    throw error;
  }
}

async function getTvMazeEpisodes(name) {
  const show = await getTvMazeShow(name);
  if (!show || !show.id) return [];
  const url = `${config.tvMazeBaseUrl.replace(/\/$/, '')}/shows/${show.id}/episodes?specials=0`;
  try {
    const episodes = await requestJson(url, {}, 'TVMaze is unavailable');
    return Array.isArray(episodes) ? episodes : [];
  } catch (error) {
    if (error.status === 502 || error.status === 504) return [];
    throw error;
  }
}

module.exports = {
  getDiscovery,
  getImdbRatings,
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvSeason,
  getTvShow,
  getTvShowClassificationData,
  searchTv,
};
