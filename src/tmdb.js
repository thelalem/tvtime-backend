const { Agent, fetch } = require('undici');
const { config } = require('./config');
const { readThrough } = require('./persistent-cache');
const { takeOmdbCall } = require('./omdb-budget');

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

// The cause of those stalls. Node's built-in fetch keeps idle sockets for as
// long as the server's Keep-Alive hint allows (up to 10 minutes), but a
// NAT or load balancer between here and the provider forgets an idle
// connection well before that and drops its packets without a reset. The next
// request written to that socket just hangs, and so can the retry if it
// draws another socket that sat idle just as long. Closing sockets after
// 10 s idle means a request after a quiet spell pays one TLS handshake
// (~100 ms) instead of a timeout; bursts still reuse connections.
const providerAgent = new Agent({
  keepAliveTimeout: 10 * 1000,
  keepAliveMaxTimeout: 10 * 1000,
});

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
// A TMDB id keeps its IMDb id for good.
const imdbIdCacheTtlMs = 90 * 24 * 60 * 60 * 1000;
// Episode ratings keep moving while a season is airing and barely move after.
const airingSeasonRatingsTtlMs = 6 * 60 * 60 * 1000;
const finishedSeasonRatingsTtlMs = 30 * 24 * 60 * 60 * 1000;
const episodeRatingsCacheTtlMs = 6 * 60 * 60 * 1000;
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
      dispatcher: providerAgent,
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

// One mixed, relevance-ordered list of shows and movies. TMDB also returns people here; they are
// not something the app can open, so they are dropped. Each result keeps TMDB's `media_type`
// ('tv' or 'movie'), which is the tag the app shows. Within TMDB's own order, a title that is
// exactly what was typed comes first, then titles that start with it, then titles that contain
// it, then the rest, so the closest match wins whichever kind it is.
async function searchMulti(query) {
  const data = await tmdbGet('/search/multi', { query });
  const typed = String(query).trim().toLowerCase();
  const results = (Array.isArray(data.results) ? data.results : [])
    .filter((item) => item && (item.media_type === 'tv' || item.media_type === 'movie'));
  const closeness = (item) => {
    const title = String(item.title || item.name || '').trim().toLowerCase();
    if (title === typed) return 0;
    if (title.startsWith(typed)) return 1;
    return title.includes(typed) ? 2 : 3;
  };
  // Array.prototype.sort is stable, so equal closeness keeps TMDB's order.
  return { ...data, results: results.sort((a, b) => closeness(a) - closeness(b)) };
}

// A movie's full record: details, credits, trailers, streaming providers and external ids in one
// request (movies use `credits`; the `aggregate_credits` shows use does not exist for them).
async function getMovie(movieId) {
  return cachedProviderRead(
    `movie-full:${movieId}`,
    () => tmdbGet(`/movie/${movieId}`, {
      append_to_response: 'credits,videos,watch/providers,external_ids',
    }),
    { ttlMs: showCacheTtlMs },
  );
}

async function getMovieRecommendations(movieId) {
  return cachedProviderRead(
    `movie-recommendations:${movieId}`,
    () => tmdbGet(`/movie/${movieId}/recommendations`),
    { ttlMs: recommendationsCacheTtlMs },
  );
}

// A collection (a movie series such as "Dune Collection") with all its parts and their release
// dates, including ones not out yet. Slow-moving, so cached for hours.
async function getCollection(collectionId) {
  return cachedProviderRead(
    `collection:${collectionId}`,
    () => tmdbGet(`/collection/${collectionId}`),
    { ttlMs: recommendationsCacheTtlMs },
  );
}

async function getMovieSimilar(movieId) {
  return cachedProviderRead(
    `movie-similar:${movieId}`,
    () => tmdbGet(`/movie/${movieId}/similar`),
    { ttlMs: recommendationsCacheTtlMs },
  );
}

// The full show record: details, ratings and every season lookup all start from
// it, and it used to be fetched from TMDB again each time.
async function getTvShow(showId) {
  return cachedProviderRead(
    `show-full:${showId}`,
    () => tmdbGet(`/tv/${showId}`, {
      append_to_response: 'aggregate_credits,videos,watch/providers,external_ids',
    }),
    { ttlMs: showCacheTtlMs },
  );
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

// TMDB's looser "similar" list (shared keywords and genres). Weaker than the
// recommendations above, so it only fills in behind them.
async function getTvSimilar(showId) {
  return cachedProviderRead(
    `similar:${showId}`,
    () => tmdbGet(`/tv/${showId}/similar`),
    { ttlMs: recommendationsCacheTtlMs },
  );
}

async function getDiscovery(kind, query = {}) {
  const paths = {
    popular: '/tv/popular',
    top_rated: '/tv/top_rated',
    trending: '/trending/tv/week',
    discover: '/discover/tv',
    movie_popular: '/movie/popular',
    movie_trending: '/trending/movie/week',
    movie_discover: '/discover/movie',
  };
  if (!paths[kind]) throw providerError('Unknown discovery feed', 400);
  return tmdbGet(paths[kind], query);
}

async function getOmdbSeasonRatings(imdbId, seasonNumber, ttlMs = airingSeasonRatingsTtlMs) {
  if (!config.omdbApiKey) {
    return { ratings: {}, configured: false };
  }
  return readThrough(
    `omdb:season:${imdbId}:${seasonNumber}`,
    ttlMs,
    () => fetchOmdbSeasonRatings(imdbId, seasonNumber),
  );
}

// OMDb's free tier allows a fixed number of calls a day. Once it says no, every
// further call also says no (and counts), so stop asking for a while. Callers
// see an error flagged `omdbQuota` and fall back to TMDB's rating.
let omdbBlockedUntil = 0;
const omdbBlockMs = 30 * 60 * 1000;

function omdbQuotaError() {
  // 503, not a success with no ratings: the app saves a successful answer on
  // the device, and an empty one would hide IMDb ratings there for a day. A
  // failure is not saved and the app falls back to TMDB's ratings.
  const error = providerError('OMDb is over its request limit', 503);
  error.omdbQuota = true;
  return error;
}

// `forList`: a rating for a list of shows, which may spend only the lists'
// share of the day's calls (omdb-budget.js); a show page or its episode ratings
// may spend the whole day's.
async function omdbGet(url, { forList = false } = {}) {
  if (Date.now() < omdbBlockedUntil) throw omdbQuotaError();
  const limit = forList ? config.omdbListBudget : config.omdbDailyBudget;
  if (!await takeOmdbCall(limit)) {
    const error = providerError('OMDb daily budget used', 503);
    error.omdbQuota = true;
    throw error;
  }
  let data;
  try {
    data = await requestJson(url, {}, 'OMDb is unavailable');
  } catch (error) {
    // OMDb answers 401 when the daily limit is used up.
    if (error.providerStatus === 401) {
      omdbBlockedUntil = Date.now() + omdbBlockMs;
      throw omdbQuotaError();
    }
    throw error;
  }
  if (data && data.Response === 'False' && /limit/i.test(String(data.Error))) {
    omdbBlockedUntil = Date.now() + omdbBlockMs;
    throw omdbQuotaError();
  }
  return data;
}

async function fetchOmdbSeasonRatings(imdbId, seasonNumber) {
  const url = new URL(config.omdbBaseUrl);
  url.searchParams.set('apikey', config.omdbApiKey);
  url.searchParams.set('i', imdbId);
  url.searchParams.set('Season', String(seasonNumber));
  // A quota error throws, which keeps it out of the cache: it is not "this
  // season has no ratings", and must be asked again once the quota resets.
  const data = await omdbGet(url);
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
async function getShowImdbRating(showId, knownImdbId, kind = 'tv', { forList = false } = {}) {
  if (!config.omdbApiKey) return null;
  // A TMDB movie id and a show id are different things that can be the same number, so the
  // cache keys say which. The show keys keep their original spelling.
  const isMovie = kind === 'movie';
  return cachedProviderRead(
    isMovie ? `imdb-movie-rating:${showId}` : `imdb-show-rating:${showId}`,
    async () => {
      const imdbId = knownImdbId || await readThrough(
        isMovie ? `imdbid:movie:${showId}` : `imdbid:${showId}`,
        imdbIdCacheTtlMs,
        async () => {
          const ids = await tmdbGet(`/${isMovie ? 'movie' : 'tv'}/${showId}/external_ids`);
          return (ids && ids.imdb_id) || null;
        },
      );
      if (!imdbId) return null;
      return readThrough(`omdb:show:${imdbId}`, imdbRatingCacheTtlMs, async () => {
        const url = new URL(config.omdbBaseUrl);
        url.searchParams.set('apikey', config.omdbApiKey);
        url.searchParams.set('i', imdbId);
        const data = await omdbGet(url, { forList });
        const rating = Number.parseFloat(data && data.imdbRating);
        return data && data.Response !== 'False' && Number.isFinite(rating) && rating > 0
          ? rating
          : null;
      });
    },
    { ttlMs: imdbRatingCacheTtlMs },
  );
}

// How long a response will wait for IMDb before settling for the TMDB rating.
// The lookup is not cancelled: it keeps running and fills the cache, so the next
// request gets the IMDb value instantly. Without this one slow OMDb call held a
// whole page of 20 shows for up to the provider's 15 s timeout.
const imdbRatingWaitMs = 2000;

function imdbRatingWithin(showId, knownImdbId, kind = 'tv', options = {}) {
  const lookup = getShowImdbRating(showId, knownImdbId, kind, options).catch(() => null);
  return Promise.race([
    lookup,
    delay(imdbRatingWaitMs).then(() => null),
  ]);
}

// Replaces `vote_average` on each show of a TMDB list response with its IMDb
// rating, so every client shows IMDb without knowing about it. The TMDB value
// is kept as `tmdb_vote_average`; a show IMDb has no rating for keeps TMDB's.
async function withImdbRatings(list, defaultKind = 'tv') {
  if (!config.omdbApiKey || !list || !Array.isArray(list.results)) return list;
  const results = await Promise.all(list.results.map(async (show) => {
    if (!show || !Number.isInteger(show.id)) return show;
    // A result that says what it is (the mixed search) wins over the list's default.
    const kind = show.media_type === 'movie' || show.media_type === 'tv'
      ? show.media_type
      : defaultKind;
    const rating = await imdbRatingWithin(show.id, undefined, kind, { forList: true });
    return rating == null
      ? show
      : { ...show, tmdb_vote_average: show.vote_average, vote_average: rating };
  }));
  return { ...list, results };
}

// Same for one full show response, which already carries its IMDb id.
async function withImdbRating(show, kind = 'tv') {
  if (!show || !Number.isInteger(show.id)) return show;
  const imdbId = (show.external_ids && show.external_ids.imdb_id) || show.imdb_id;
  const rating = await imdbRatingWithin(show.id, imdbId, kind);
  return rating == null
    ? show
    : { ...show, tmdb_vote_average: show.vote_average, vote_average: rating };
}

async function getImdbRatings(showId) {
  // The assembled answer is cached too, so repeat opens of the About page do no
  // work at all. The per-season OMDb reads underneath it are cached in the
  // database, which is what lets a restart (or the first open after a redeploy)
  // avoid asking OMDb again.
  return cachedProviderRead(
    `imdb-episode-ratings:${showId}`,
    () => loadImdbRatings(showId),
    { ttlMs: episodeRatingsCacheTtlMs },
  );
}

async function loadImdbRatings(showId) {
  const show = await getTvShow(showId);
  const imdbId = show.external_ids && show.external_ids.imdb_id;
  if (!imdbId) return { imdbId: null, ratings: {}, configured: Boolean(config.omdbApiKey) };

  const seasons = (Array.isArray(show.seasons) ? show.seasons : [])
    .filter((season) => Number(season.season_number) > 0);
  const latest = seasons.reduce((max, season) => Math.max(max, Number(season.season_number)), 0);
  const status = String(show.status || '').toLowerCase();
  const isOver = status === 'ended' || status === 'canceled' || status === 'cancelled';
  const results = await Promise.all(
    seasons.map((season) => getOmdbSeasonRatings(
      imdbId,
      season.season_number,
      !isOver && Number(season.season_number) === latest
        ? airingSeasonRatingsTtlMs
        : finishedSeasonRatingsTtlMs,
    )),
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
        // Only TVMaze saying it has no such show is an answer worth caching. A
        // timeout or an outage (502/504) used to be cached as "no show" too, so
        // one bad minute hid air times and networks for a day.
        if (error.providerStatus === 404) return null;
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
        // As for the show: only a real "no episodes" is cached.
        if (error.providerStatus === 404) return [];
        throw error;
      }
    },
    { forceRefresh, ttlMs: tvMazeEpisodesCacheTtlMs },
  );
}

module.exports = {
  getDiscovery,
  getImdbRatings,
  getCollection,
  getMovie,
  getMovieRecommendations,
  getMovieSimilar,
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvRecommendations,
  getTvSeason,
  getTvShow,
  getTvSimilar,
  getTvShowClassificationData,
  searchMulti,
  searchTv,
  withImdbRating,
  withImdbRatings,
};
