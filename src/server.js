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
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvSeason,
  getTvShow,
  searchTv,
} = require('./tmdb');

const app = express();
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
    response.json(await searchTv(query));
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/shows/popular', async (_request, response, next) => {
  try { response.json(await getDiscovery('popular')); } catch (error) { next(error); }
});

app.get('/api/v1/shows/top-rated', async (_request, response, next) => {
  try { response.json(await getDiscovery('top_rated')); } catch (error) { next(error); }
});

app.get('/api/v1/shows/trending', async (_request, response, next) => {
  try { response.json(await getDiscovery('trending')); } catch (error) { next(error); }
});

app.get('/api/v1/shows/discover', async (request, response, next) => {
  try {
    response.json(await getDiscovery('discover', {
      with_genres: request.query.with_genres,
      sort_by: request.query.sort_by || 'popularity.desc',
      page: request.query.page || 1,
    }));
  } catch (error) { next(error); }
});

app.get('/api/v1/shows/:showId', async (request, response, next) => {
  try { response.json(await getTvShow(request.params.showId)); } catch (error) { next(error); }
});

app.get('/api/v1/shows/:showId/seasons/:seasonNumber', async (request, response, next) => {
  try {
    response.json(await getTvSeason(request.params.showId, request.params.seasonNumber));
  } catch (error) { next(error); }
});

app.get('/api/v1/shows/:showId/ratings', async (request, response, next) => {
  try { response.json(await getImdbRatings(request.params.showId)); } catch (error) { next(error); }
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

app.use((error, _request, response, _next) => {
  response.status(error.status || 500).json({ detail: error.message || 'Internal server error' });
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
  server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`TV Time API listening on 0.0.0.0:${config.port}`);
  });
}

start().catch((error) => {
  console.error('Failed to initialize API', error);
  process.exit(1);
});

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
