const { config } = require('./config');

// TMDB rate-limits per IP, and a classification pass reads one show plus every
// one of its seasons. Uncapped, a single pull-to-refresh fired hundreds of
// parallel requests; the 429s surfaced as hard 502s, so `refreshClassification`
// threw before its UPDATE and the whole batch stayed stale.
//
// Hundreds at once is the problem, not a dozen: measured against the live API,
// 15 reads take ~3.5s at a cap of 6 and ~0.3s at 12, with no 429 even at 20.
// Kept at 12 so the background classification sweep sharing this limiter still
// has room.
const tmdbConcurrency = 12;

// TVMaze publishes an allowance of 20 calls per 10 seconds per IP and warns
// that search endpoints are the first to trip it — `/singlesearch/shows` is a
// search. Staying inside the published window is far cheaper than discovering
// it: a 429 costs a full round trip and then a backoff. Kept under 20 for
// headroom against other traffic from the same host.
const tvMazeConcurrency = 3;
const tvMazeMaxPerWindow = 18;
const tvMazeWindowMs = 10 * 1000;

// Per attempt. These providers answer in well under a second, so a request that
// is still silent after this long is on a connection that went dead while it sat
// idle in the keep-alive pool (the same failure the app had after backgrounding)
// rather than a slow answer. Waiting the old 15 s turned each such stall into a
// 15 s page load; abandoning it quickly lets the retry below open a fresh
// socket, which succeeds straight away.
const requestTimeoutMs = 4000;

const maxAttempts = 3;
const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

// Provider responses are shared by every user tracking the same show, so one
// cache in front of all of them collapses both duplicate reads inside a single
// request and the same read across users.
const providerCacheMaxEntries = 2000;
const providerCache = new Map();

// Aired episode lists barely move. TVMaze's own load balancers cache a show
// for up to 24 hours and everything else for an hour, so holding its answers
// locally for a while is in line with how it expects to be read.
const showCacheTtlMs = 30 * 60 * 1000;
const imdbRatingCacheTtlMs = 7 * 24 * 60 * 60 * 1000;
const recommendationsCacheTtlMs = 6 * 60 * 60 * 1000;
const tvMazeShowCacheTtlMs = 24 * 60 * 60 * 1000;
const tvMazeEpisodesCacheTtlMs = 6 * 60 * 60 * 1000;

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
      signal: AbortSignal.timeout(requestTimeoutMs),
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

// Runs `load` once a slot frees up, so bursts queue instead of being
// rate-limited. The slot passes straight to the next waiter on release.
//
// A limiter given `maxPerWindow` also holds a caller back until fewer than
// that many calls have started within `windowMs`. The reservation is taken
// synchronously with the check so concurrent waiters cannot overshoot the
// window between them.
function createRequestLimiter({ concurrency, maxPerWindow = 0, windowMs = 0 }) {
  let active = 0;
  const queue = [];
  const startedAt = [];

  async function acquire() {
    if (active < concurrency) active += 1;
    else await new Promise((resolve) => queue.push(resolve));
    if (!maxPerWindow) return;
    for (;;) {
      const now = Date.now();
      while (startedAt.length && startedAt[0] <= now - windowMs) startedAt.shift();
      if (startedAt.length < maxPerWindow) {
        startedAt.push(now);
        return;
      }
      await delay(startedAt[0] + windowMs - now);
    }
  }

  function release() {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  }

  return async function withSlot(load) {
    await acquire();
    try {
      return await load();
    } finally {
      release();
    }
  };
}

const withTmdbSlot = createRequestLimiter({ concurrency: tmdbConcurrency });
const withTvMazeSlot = createRequestLimiter({
  concurrency: tvMazeConcurrency,
  maxPerWindow: tvMazeMaxPerWindow,
  windowMs: tvMazeWindowMs,
});

/// Sends through `limiter`, retrying the statuses that mean "try again".
async function providerGet(url, { limiter, options, unavailableMessage }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await limiter(() => requestJson(url, options, unavailableMessage));
    } catch (error) {
      const status = error.providerStatus ?? error.status;
      if (attempt >= maxAttempts || !retryableStatuses.has(status)) throw error;
      // Backs off outside the slot, so waiting never blocks the queue.
      await delay(error.retryAfterMs ?? attempt * 500);
    }
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
  // Built once, outside the retry loop: `tmdbUrl` validates configuration, and
  // a missing token is permanent, not a transient provider fault to retry.
  const url = tmdbUrl(path, query);
  return providerGet(url, {
    limiter: withTmdbSlot,
    options: tmdbOptions(),
    unavailableMessage: 'TV metadata provider is unavailable',
  });
}

// Serves `load` from cache, collapsing concurrent reads of the same key into
// one request. Results are shared by reference — callers must not mutate them.
function cachedProviderRead(key, load, { forceRefresh = false, ttlMs }) {
  if (forceRefresh) providerCache.delete(key);
  const entry = providerCache.get(key);
  if (entry) {
    if (entry.pending) return entry.pending;
    if (entry.expiresAt > Date.now()) return Promise.resolve(entry.value);
  }

  const pending = load()
    .then((value) => {
      providerCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      pruneProviderCache();
      return value;
    })
    .catch((error) => {
      // Never cache a failure: the next pull-to-refresh must be free to retry.
      providerCache.delete(key);
      throw error;
    });
  providerCache.set(key, { pending });
  return pending;
}

function pruneProviderCache() {
  if (providerCache.size <= providerCacheMaxEntries) return;
  const now = Date.now();
  for (const [key, entry] of providerCache) {
    if (!entry.pending && entry.expiresAt <= now) providerCache.delete(key);
  }
  // Still over budget, so drop entries oldest-first (Map iterates in insertion
  // order). In-flight reads stay — something is already awaiting them.
  for (const [key, entry] of providerCache) {
    if (providerCache.size <= providerCacheMaxEntries) break;
    if (!entry.pending) providerCache.delete(key);
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
  return cachedProviderRead(
    `show:${showId}`,
    () => tmdbGet(`/tv/${showId}`),
    { forceRefresh, ttlMs: showCacheTtlMs },
  );
}

async function getTvSeason(showId, seasonNumber, { forceRefresh = false } = {}) {
  return cachedProviderRead(
    `season:${showId}:${seasonNumber}`,
    () => tmdbGet(`/tv/${showId}/season/${seasonNumber}`),
    { forceRefresh, ttlMs: showCacheTtlMs },
  );
}

// What viewers of this show go on to watch. Slow-moving, so cached for hours.
async function getTvRecommendations(showId) {
  return cachedProviderRead(
    `recommendations:${showId}`,
    () => tmdbGet(`/tv/${showId}/recommendations`),
    { ttlMs: recommendationsCacheTtlMs },
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

// The show-level IMDb rating (e.g. 8.7), or null when IMDb has none. One cache
// entry per show covers both lookups it takes (TMDB external ids, then OMDb),
// and a "no rating" answer is cached too so unrated shows are not re-asked.
// Failures are not cached: OMDb being down or over quota just means the caller
// falls back to the TMDB rating for now.
async function getShowImdbRating(showId, knownImdbId) {
  if (!config.omdbApiKey) return null;
  return cachedProviderRead(
    `imdb-show-rating:${showId}`,
    async () => {
      let imdbId = knownImdbId;
      if (!imdbId) {
        const ids = await tmdbGet(`/tv/${showId}/external_ids`);
        imdbId = ids && ids.imdb_id;
      }
      if (!imdbId) return null;
      const url = new URL(config.omdbBaseUrl);
      url.searchParams.set('apikey', config.omdbApiKey);
      url.searchParams.set('i', imdbId);
      const data = await requestJson(url, {}, 'OMDb is unavailable');
      const rating = Number.parseFloat(data && data.imdbRating);
      return data && data.Response !== 'False' && Number.isFinite(rating) && rating > 0
        ? rating
        : null;
    },
    { ttlMs: imdbRatingCacheTtlMs },
  );
}

// How long a response will wait for IMDb before settling for the TMDB rating.
// The lookup is not cancelled: it keeps running and fills the cache, so the next
// request gets the IMDb value instantly. Without this one slow OMDb call held a
// whole page of 20 shows for up to the provider's 15 s timeout.
const imdbRatingWaitMs = 2000;

function imdbRatingWithin(showId, knownImdbId) {
  const lookup = getShowImdbRating(showId, knownImdbId).catch(() => null);
  return Promise.race([
    lookup,
    delay(imdbRatingWaitMs).then(() => null),
  ]);
}

// Replaces `vote_average` on each show of a TMDB list response with its IMDb
// rating, so every client shows IMDb without knowing about it. The TMDB value
// is kept as `tmdb_vote_average`; a show IMDb has no rating for keeps TMDB's.
async function withImdbRatings(list) {
  if (!config.omdbApiKey || !list || !Array.isArray(list.results)) return list;
  const results = await Promise.all(list.results.map(async (show) => {
    if (!show || !Number.isInteger(show.id)) return show;
    const rating = await imdbRatingWithin(show.id);
    return rating == null
      ? show
      : { ...show, tmdb_vote_average: show.vote_average, vote_average: rating };
  }));
  return { ...list, results };
}

// Same for one full show response, which already carries its IMDb id.
async function withImdbRating(show) {
  if (!show || !Number.isInteger(show.id)) return show;
  const imdbId = show.external_ids && show.external_ids.imdb_id;
  const rating = await imdbRatingWithin(show.id, imdbId);
  return rating == null
    ? show
    : { ...show, tmdb_vote_average: show.vote_average, vote_average: rating };
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

/// Resolves a show name to its TVMaze entry, or null when TVMaze has nothing.
///
/// Cached, which also makes the second lookup free: a show's airtime and its
/// episode list are both wanted, and each used to run its own `/singlesearch`.
async function getTvMazeShow(name, { forceRefresh = false } = {}) {
  const query = typeof name === 'string' ? name.trim() : '';
  if (!query) return null;
  return cachedProviderRead(
    `tvmaze:show:${query.toLowerCase()}`,
    async () => {
      const url = new URL(`${config.tvMazeBaseUrl.replace(/\/$/, '')}/singlesearch/shows`);
      url.searchParams.set('q', query);
      try {
        return await providerGet(url, {
          limiter: withTvMazeSlot,
          unavailableMessage: 'TVMaze is unavailable',
        });
      } catch (error) {
        if (error.status === 502 || error.status === 504) return null;
        throw error;
      }
    },
    { forceRefresh, ttlMs: tvMazeShowCacheTtlMs },
  );
}

async function getTvMazeEpisodes(name, { forceRefresh = false } = {}) {
  const show = await getTvMazeShow(name, { forceRefresh });
  if (!show || !show.id) return [];
  return cachedProviderRead(
    `tvmaze:episodes:${show.id}`,
    async () => {
      const url = `${config.tvMazeBaseUrl.replace(/\/$/, '')}/shows/${show.id}/episodes?specials=0`;
      try {
        const episodes = await providerGet(url, {
          limiter: withTvMazeSlot,
          unavailableMessage: 'TVMaze is unavailable',
        });
        return Array.isArray(episodes) ? episodes : [];
      } catch (error) {
        if (error.status === 502 || error.status === 504) return [];
        throw error;
      }
    },
    { forceRefresh, ttlMs: tvMazeEpisodesCacheTtlMs },
  );
}

module.exports = {
  getDiscovery,
  getImdbRatings,
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvRecommendations,
  getTvSeason,
  getTvShow,
  getTvShowClassificationData,
  searchTv,
  withImdbRating,
  withImdbRatings,
};
