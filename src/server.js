const cors = require('cors');
const express = require('express');
const { config } = require('./config');
const { pool } = require('./db');
const { initializeDatabase } = require('./schema');
const {
  refreshStaleClassifications,
  router: userDataRouter,
} = require('./user-data');
const {
  getDiscovery,
  getImdbRatings,
  getPerson,
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvSeason,
  getTvShow,
  searchTv,
  withImdbRating,
  withImdbRatings,
  getTvShowClassificationData,
} = require('./tmdb');
const { getSimilarShows } = require('./similar');
const { registerPublicMovieRoutes } = require('./movies');
const { startNotificationSweeps } = require('./notifications');
const { startDailyCleanUp } = require('./cleanup');

const app = express();
// As the /me router: /ME/... must not reach routes meant for /me/....
app.set('case sensitive routing', true);
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    let hostname;
    try {
      hostname = new URL(origin).hostname;
    } catch (_error) {
      return callback(null, false);
    }
    const isLocalWebDev = hostname === 'localhost' || hostname === '127.0.0.1';
    return callback(null, isLocalWebDev || config.corsAllowedOrigins.includes(origin));
  },
}));
app.use(express.json({ limit: '12mb' }));
app.use((request, response, next) => {
  if (request.path === '/' || request.path.startsWith('/health')) {
    return next();
  }

  const startedAt = process.hrtime.bigint();
  response.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `[api] ${request.method} ${request.path} ${response.statusCode} ${durationMs.toFixed(1)}ms`,
    );
  });
  next();
});

app.get('/', (_request, response) => {
  response.json({ service: 'TV Time API', status: 'ok' });
});

// Google Play asks for a page where people can delete their account without the app (FEATURE_PLAN.md
// section 19). Signing in and the deletion itself go through Firebase and the /me routes.
app.get('/delete-account', (_request, response) => {
  response.sendFile(require('node:path').join(__dirname, 'public', 'delete-account.html'));
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/health/ready', async (_request, response) => {
  try {
    await pool.query('SELECT 1');
    response.json({ status: 'ready', database: 'ok' });
  } catch (_error) {
    response.status(503).json({ status: 'not_ready', database: 'unavailable' });
  }
});

app.use('/api/v1', userDataRouter);

app.get('/api/v1/shows/search', async (request, response, next) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!query || query.length > 100) {
    return response.status(400).json({ detail: 'q must contain 1 to 100 characters' });
  }

  try {
    response.json(await withImdbRatings(await searchTv(query)));
  } catch (error) {
    next(error);
  }
});

// TMDB serves pages 1..500. Anything else (missing, junk, out of range) is page 1
// rather than an error, so an old client without the param keeps working.
function discoveryPage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 && page <= 500 ? page : 1;
}

app.get('/api/v1/shows/popular', async (request, response, next) => {
  try { response.json(await withImdbRatings(await getDiscovery('popular', { page: discoveryPage(request.query.page) }))); } catch (error) { next(error); }
});

app.get('/api/v1/shows/top-rated', async (request, response, next) => {
  try { response.json(await withImdbRatings(await getDiscovery('top_rated', { page: discoveryPage(request.query.page) }))); } catch (error) { next(error); }
});

app.get('/api/v1/shows/trending', async (request, response, next) => {
  try { response.json(await withImdbRatings(await getDiscovery('trending', { page: discoveryPage(request.query.page) }))); } catch (error) { next(error); }
});

// TMDB's sort orders for /discover/tv. Anything else was passed on and came
// back from TMDB as an error.
const discoverSortOrders = new Set([
  'popularity.desc', 'popularity.asc', 'vote_average.desc', 'vote_average.asc',
  'vote_count.desc', 'vote_count.asc', 'first_air_date.desc', 'first_air_date.asc',
  'name.asc', 'name.desc',
]);

app.get('/api/v1/shows/discover', async (request, response, next) => {
  const sortBy = request.query.sort_by === undefined ? 'popularity.desc' : request.query.sort_by;
  const genres = request.query.with_genres;
  if (typeof sortBy !== 'string' || !discoverSortOrders.has(sortBy) ||
      (genres !== undefined && (typeof genres !== 'string' || !/^\d{1,6}([,|]\d{1,6}){0,19}$/.test(genres)))) {
    return response.status(400).json({ detail: 'invalid sort_by or with_genres' });
  }
  try {
    response.json(await getDiscovery('discover', {
      with_genres: genres,
      sort_by: sortBy,
      page: discoveryPage(request.query.page),
    }));
  } catch (error) { next(error); }
});

// These ids are spliced into the TMDB request path. Express has already decoded
// them, so an unchecked `..%2F..%2Fsomething` would walk out of `/tv/` and let
// anyone (these routes need no login) send the server's TMDB token to any path
// on the provider — and fill the cache with junk keys. Only plain numbers pass.
app.param('showId', (_request, response, next, value) => {
  if (/^[1-9]\d{0,9}$/.test(value)) return next();
  return response.status(400).json({ detail: 'showId must be a positive integer' });
});
app.param('seasonNumber', (_request, response, next, value) => {
  if (/^\d{1,4}$/.test(value)) return next();
  return response.status(400).json({ detail: 'seasonNumber must be a non-negative integer' });
});

app.get('/api/v1/shows/:showId', async (request, response, next) => {
  try { response.json(await withImdbRating(await getTvShow(request.params.showId))); } catch (error) { next(error); }
});

// The few fields a Trakt import stores for a show. The full route above is
// 250-600 KB (the whole run's cast, videos, providers) and asks OMDb for the
// IMDb rating; an import of a few hundred shows downloaded all of it and spent
// a third of the day's OMDb budget. The rating here is TMDB's.
app.get('/api/v1/shows/:showId/summary', async (request, response, next) => {
  try {
    const show = await getTvShowClassificationData(request.params.showId);
    response.json({
      id: show.id,
      name: show.name,
      overview: show.overview || '',
      poster_path: show.poster_path || null,
      backdrop_path: show.backdrop_path || null,
      vote_average: show.vote_average || 0,
      first_air_date: show.first_air_date || '',
      // How many episodes each season has (the TV Time import drops episodes TMDB does not have).
      seasons: (Array.isArray(show.seasons) ? show.seasons : [])
        .filter((season) => Number.isInteger(season.season_number))
        .map((season) => ({ season_number: season.season_number, episode_count: season.episode_count || 0 })),
    });
  } catch (error) { next(error); }
});

app.get('/api/v1/shows/:showId/similar', async (request, response, next) => {
  try { response.json(await withImdbRatings(await getSimilarShows(request.params.showId))); } catch (error) { next(error); }
});

app.get('/api/v1/shows/:showId/seasons/:seasonNumber', async (request, response, next) => {
  try {
    response.json(await getTvSeason(request.params.showId, request.params.seasonNumber));
  } catch (error) { next(error); }
});

app.get('/api/v1/shows/:showId/ratings', async (request, response, next) => {
  try { response.json(await getImdbRatings(request.params.showId)); } catch (error) { next(error); }
});

// An actor's page (people-logic.js). The id goes into the TMDB path, so only plain numbers pass, as for showId.
// Ratings are TMDB's: a busy actor has hundreds of titles, too many to ask OMDb about.
app.param('personId', (_request, response, next, value) => {
  if (/^[1-9]\d{0,9}$/.test(value)) return next();
  return response.status(400).json({ detail: 'personId must be a positive integer' });
});

app.get('/api/v1/people/:personId', async (request, response, next) => {
  try { response.json(await getPerson(request.params.personId)); } catch (error) { next(error); }
});

app.get('/api/v1/providers/tvmaze/show', async (request, response, next) => {
  const name = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!name || name.length > 100) {
    return response.status(400).json({ detail: 'q must contain 1 to 100 characters' });
  }
  try { response.json(await getTvMazeShow(name)); } catch (error) { next(error); }
});

app.get('/api/v1/providers/tvmaze/episodes', async (request, response, next) => {
  const name = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!name || name.length > 100) {
    return response.status(400).json({ detail: 'q must contain 1 to 100 characters' });
  }
  try { response.json(await getTvMazeEpisodes(name)); } catch (error) { next(error); }
});

registerPublicMovieRoutes(app);

app.use((error, request, response, _next) => {
  const status = error.status || 500;
  // An unexpected error's message (a Postgres error carries SQL) stays in the
  // log. Errors this code raised on purpose (400s, provider 502/503/504) keep
  // theirs: the app shows or logs them.
  if (status >= 500 && !error.status) {
    console.error(`[${request.method} ${request.path}] ${error.stack || error.message}`);
  }
  response.status(status).json({
    detail: status >= 500 && !error.status
      ? 'Internal server error'
      : error.message || 'Internal server error',
  });
});

let server;

async function start() {
  await initializeDatabase();
  // Not awaited: the sweep is now rate-limited, so on a large library it runs
  // for minutes. Blocking on it kept the port closed and failed health checks.
  refreshStaleClassifications().catch((error) => {
    console.error(`[classification] startup refresh failed: ${error.message}`);
  });
  const classificationTimer = setInterval(() => {
    refreshStaleClassifications().catch((error) => {
      console.error(`[classification] scheduled refresh failed: ${error.message}`);
    });
  }, 6 * 60 * 60 * 1000);
  classificationTimer.unref();
  startNotificationSweeps();
  startDailyCleanUp();
  server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`TV Time API listening on 0.0.0.0:${config.port}`);
  });
}

// Started only when run (`npm start`), so tests can load the app on its own.
if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to initialize API', error);
    process.exit(1);
  });
}

async function shutdown() {
  if (!server) {
    await pool.end();
    return process.exit(0);
  }
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app };
