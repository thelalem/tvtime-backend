// The stats page (FEATURE_PLAN.md section 17): `GET /me/stats`. The rules are in stats-logic.js; this file loads a
// user's watch history, finds each show's episode runtime, and caches the answer for a minute. `loadStats(uid)` is
// what the social page (section 19) will call for another person, so the numbers match on both sides.
const { pool } = require('./db');
const { readThrough } = require('./persistent-cache');
const { getTvSeason, getTvShowClassificationData } = require('./tmdb');
const { computeStats } = require('./stats-logic');

const DAY_MS = 24 * 60 * 60 * 1000;
const RUNTIME_TTL_MS = 30 * DAY_MS;
const RUNTIME_LOOKUP_BUDGET_MS = 8000;
const RUNTIME_CONCURRENCY = 6;
const CACHE_MS = 60 * 1000;

const cache = new Map(); // uid -> { at, data }

// The median of a list of numbers (the middle one, or the mean of the two middle ones).
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// A show's usual episode length in minutes: TMDB's `episode_run_time` when it has one. Many shows have none (the field
// is deprecated), and the length of the latest episode is no stand-in (a series finale can run twice as long), so then
// it is the median of the first season's episode lengths. `null` when neither exists (the 42-minute fallback applies),
// `undefined` when the lookup failed and should be tried again next time.
async function showRuntime(showId) {
  try {
    // v2: the first version used the last episode's length, which finales skewed; those answers must not be reused.
    return await readThrough(`runtime:tv:v2:${showId}`, RUNTIME_TTL_MS, async () => {
      const data = await getTvShowClassificationData(showId);
      const list = data && data.episode_run_time;
      if (Array.isArray(list) && list.length && Number.isFinite(list[0]) && list[0] > 0) return list[0];
      const seasons = ((data && data.seasons) || [])
        .filter((season) => Number.isInteger(season.season_number) && season.season_number > 0 && season.episode_count > 0)
        .sort((a, b) => a.season_number - b.season_number);
      if (!seasons.length) return null;
      const season = await getTvSeason(showId, seasons[0].season_number);
      const lengths = ((season && season.episodes) || [])
        .map((episode) => episode.runtime)
        .filter((runtime) => Number.isFinite(runtime) && runtime > 0);
      return lengths.length ? median(lengths) : null;
    }, { emptyTtlMs: DAY_MS });
  } catch (error) {
    return undefined;
  }
}

// Runtimes for every show id, a few at a time and only for as long as the budget lasts: a first look at a big library
// would otherwise wait on hundreds of TMDB calls. What is found is cached, so the next look is complete.
async function runtimesFor(showIds) {
  const result = new Map();
  const queue = [...showIds];
  const deadline = Date.now() + RUNTIME_LOOKUP_BUDGET_MS;
  const workers = Array.from({ length: Math.min(RUNTIME_CONCURRENCY, queue.length) }, async () => {
    while (queue.length && Date.now() < deadline) {
      const id = queue.shift();
      result.set(id, await showRuntime(id));
    }
  });
  await Promise.all(workers);
  return result;
}

async function loadStats(uid, now = new Date()) {
  const cached = cache.get(uid);
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.data;

  const [user, progress, movies] = await Promise.all([
    pool.query('SELECT timezone FROM app_users WHERE firebase_uid = $1', [uid]),
    pool.query(
      `SELECT series_id, show_name, poster_path, watched_episodes, watched_episode_dates, rewatches
       FROM show_progress WHERE firebase_uid = $1`,
      [uid],
    ),
    pool.query(
      `SELECT movie_id, movie->>'title' AS title, (movie->>'runtime')::int AS runtime,
              to_char(watched_on, 'YYYY-MM-DD') AS "watchedOn"
       FROM movie_watchlist WHERE firebase_uid = $1 AND watched_on IS NOT NULL`,
      [uid],
    ),
  ]);

  const runtimes = await runtimesFor(progress.rows.map((row) => Number(row.series_id)));
  let unknownRuntimes = 0;
  const shows = progress.rows.map((row) => {
    const showId = Number(row.series_id);
    const runtime = runtimes.get(showId);
    if (runtime === undefined) unknownRuntimes += 1;
    return {
      showId,
      name: row.show_name || 'Unknown show',
      posterPath: row.poster_path || null,
      runtime: runtime === undefined ? null : runtime,
      watched: Array.isArray(row.watched_episodes) ? row.watched_episodes.map(String) : [],
      dates: row.watched_episode_dates && typeof row.watched_episode_dates === 'object' ? row.watched_episode_dates : {},
      rewatches: row.rewatches && typeof row.rewatches === 'object' ? row.rewatches : {},
    };
  });

  const data = {
    ...computeStats({
      shows,
      movies: movies.rows.map((row) => ({
        movieId: Number(row.movie_id), title: row.title || 'Movie', watchedOn: row.watchedOn, runtime: row.runtime,
      })),
      timezone: (user.rows[0] && user.rows[0].timezone) || 'UTC',
      now,
    }),
    // Some shows had no runtime yet (TMDB was slow): their episodes counted 42 minutes for now.
    approximate: unknownRuntimes > 0,
    generatedAt: now.toISOString(),
  };
  // An unfinished answer is not kept, so the next request finishes the runtimes.
  if (!data.approximate) cache.set(uid, { at: now.getTime(), data });
  return data;
}

function registerStatsRoutes(router) {
  router.get('/me/stats', async (request, response, next) => {
    try {
      response.json(await loadStats(request.user.uid));
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { loadStats, registerStatsRoutes };
