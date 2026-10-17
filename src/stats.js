// The stats page (FEATURE_PLAN.md section 17): `GET /me/stats`. The rules are in stats-logic.js; this file loads a
// user's watch history, finds what TMDB knows about each show (episode length, genres, networks), and caches the
// answer for a minute. `loadStats(uid)` is what the social page (section 19) will call for another person, so the
// numbers match on both sides.
const { pool } = require('./db');
const { readThrough } = require('./persistent-cache');
const { getTvSeason, getTvShowClassificationData } = require('./tmdb');
const { computeStats } = require('./stats-logic');

const DAY_MS = 24 * 60 * 60 * 1000;
const FACTS_TTL_MS = 30 * DAY_MS;
// Shorter than the app's request limit (about 6 seconds), so a first look at a big library answers in time with what it has
// (`approximate`) and the app asks again, instead of the app giving up on a request that is still running.
const FACTS_LOOKUP_BUDGET_MS = 3500;
const FACTS_CONCURRENCY = 6;
const CACHE_MS = 60 * 1000;

const cache = new Map(); // uid -> { at, data }

// The median of a list of numbers (the middle one, or the mean of the two middle ones).
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const names = (list) => (Array.isArray(list) ? list.map((item) => item && item.name).filter(Boolean) : []);

// What TMDB says about a show for the stats: `{ runtime, genres, networks }`.
// - runtime: TMDB's `episode_run_time` when it has one. Many shows have none (the field is deprecated), and the length
//   of the latest episode is no stand-in (a series finale can run twice as long), so then it is the median of the first
//   season's episode lengths; `null` when neither exists (the 42-minute fallback applies).
// - genres and networks: their names.
// `undefined` when the lookup failed and should be tried again next time.
async function showFacts(showId) {
  try {
    // v1 of `facts`: it supersedes the runtime-only `runtime:tv:v2` entries, which had no genres.
    return await readThrough(`facts:tv:v1:${showId}`, FACTS_TTL_MS, async () => {
      const data = await getTvShowClassificationData(showId);
      const list = data && data.episode_run_time;
      let runtime = Array.isArray(list) && list.length && Number.isFinite(list[0]) && list[0] > 0 ? list[0] : null;
      if (runtime === null) {
        const seasons = ((data && data.seasons) || [])
          .filter((season) => Number.isInteger(season.season_number) && season.season_number > 0 && season.episode_count > 0)
          .sort((a, b) => a.season_number - b.season_number);
        if (seasons.length) {
          const season = await getTvSeason(showId, seasons[0].season_number);
          const lengths = ((season && season.episodes) || [])
            .map((episode) => episode.runtime)
            .filter((value) => Number.isFinite(value) && value > 0);
          if (lengths.length) runtime = median(lengths);
        }
      }
      return { runtime, genres: names(data && data.genres), networks: names(data && data.networks) };
    }, { emptyTtlMs: DAY_MS });
  } catch (error) {
    return undefined;
  }
}

// Facts for every show id, a few at a time and only for as long as the budget lasts: a first look at a big library would
// otherwise wait on hundreds of TMDB calls. What is found is cached, so the next look is complete.
async function factsFor(showIds) {
  const result = new Map();
  const queue = [...showIds];
  const deadline = Date.now() + FACTS_LOOKUP_BUDGET_MS;
  const workers = Array.from({ length: Math.min(FACTS_CONCURRENCY, queue.length) }, async () => {
    while (queue.length && Date.now() < deadline) {
      const id = queue.shift();
      result.set(id, await showFacts(id));
    }
  });
  await Promise.all(workers);
  return result;
}

async function loadStats(uid, now = new Date()) {
  const cached = cache.get(uid);
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.data;

  const [user, progress, movies, states, library, ratings] = await Promise.all([
    pool.query('SELECT timezone FROM app_users WHERE firebase_uid = $1', [uid]),
    pool.query(
      `SELECT series_id, show_name, poster_path, watched_episodes, watched_episode_dates, rewatches,
              unwatched_released_count AS "unwatchedReleased"
       FROM show_progress WHERE firebase_uid = $1`,
      [uid],
    ),
    pool.query(
      `SELECT movie_id, movie->>'title' AS title, (movie->>'runtime')::int AS runtime,
              to_char(watched_on, 'YYYY-MM-DD') AS "watchedOn"
       FROM movie_watchlist WHERE firebase_uid = $1 AND watched_on IS NOT NULL`,
      [uid],
    ),
    pool.query('SELECT series_id, state FROM show_states WHERE firebase_uid = $1', [uid]),
    // Added shows: on the watchlist or with progress, less the ones removed; how many of those have not ended.
    pool.query(
      `WITH added AS (
         SELECT series_id FROM watchlist WHERE firebase_uid = $1
         UNION SELECT series_id FROM show_progress WHERE firebase_uid = $1
       ), kept AS (
         SELECT series_id FROM added WHERE series_id NOT IN
           (SELECT series_id FROM show_states WHERE firebase_uid = $1 AND state = 'removed')
       )
       SELECT (SELECT COUNT(*) FROM kept)::int AS added,
              (SELECT COUNT(*) FROM kept k WHERE NOT EXISTS (
                 SELECT 1 FROM show_progress p WHERE p.firebase_uid = $1 AND p.series_id = k.series_id AND p.is_ended
               ))::int AS "inProduction"`,
      [uid],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, COUNT(DISTINCT series_id)::int AS shows
       FROM episode_user_data WHERE firebase_uid = $1 AND rating IS NOT NULL`,
      [uid],
    ),
  ]);

  const inactive = new Set(states.rows.map((row) => Number(row.series_id)));
  const facts = await factsFor(progress.rows.map((row) => Number(row.series_id)));
  let unknownFacts = 0;
  const shows = progress.rows.map((row) => {
    const showId = Number(row.series_id);
    const found = facts.get(showId);
    if (found === undefined) unknownFacts += 1;
    return {
      showId,
      name: row.show_name || 'Unknown show',
      posterPath: row.poster_path || null,
      runtime: found ? found.runtime : null,
      genres: found ? found.genres : [],
      networks: found ? found.networks : [],
      active: !inactive.has(showId),
      unwatchedReleased: Number.isFinite(row.unwatchedReleased) ? row.unwatchedReleased : null,
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
      library: library.rows[0] || null,
      ratings: ratings.rows[0] || null,
    }),
    // Some shows' details were not fetched yet (TMDB was slow): their episodes counted 42 minutes for now.
    approximate: unknownFacts > 0,
    generatedAt: now.toISOString(),
  };
  // An unfinished answer is not kept, so the next request finishes the lookups.
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
