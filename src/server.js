const cors = require('cors');
const express = require('express');
const { config } = require('./config');
const { pool } = require('./db');
const { searchTv } = require('./tmdb');

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
app.use(express.json());

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

app.use((error, _request, response, _next) => {
  response.status(error.status || 500).json({ detail: error.message || 'Internal server error' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`TV Time API listening on 0.0.0.0:${config.port}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
