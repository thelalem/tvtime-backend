// GET /me/stats through the real route and PostgreSQL (the rules themselves are in stats-logic.test.js). Skipped unless
// TEST_DATABASE_URL is set; see progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('stats integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

const SLOW_SHOW = 9202;
const NO_RUNTIME_SHOW = 9203;
const stubs = {
  './firebase': {
    admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token, email: `${token}@example.test` }) }) },
  },
  './tmdb': {
    getTvSeason: async () => ({ season_number: 1, episodes: [{ runtime: 20 }, { runtime: 22 }, { runtime: 22 }, { runtime: 90 }, { runtime: null }] }),
    getTvShowClassificationData: async (id) => {
      if (Number(id) === SLOW_SHOW) throw new Error('TMDB is down');
      if (Number(id) === NO_RUNTIME_SHOW) {
        // No usable episode_run_time; the last episode (a long finale) must not be taken for the usual length.
        return { seasons: [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 5 }],
          episode_run_time: [], last_episode_to_air: { runtime: 90 } };
      }
      return { seasons: [], status: 'Ended', episode_run_time: [30] };
    },
  },
  './upcoming': { getUpcomingEpisodes: async () => [] },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  const file = parent && parent.filename;
  if (file && (file.endsWith('user-data.js') || file.endsWith('stats.js')) && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};

const express = require('express');
const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { router } = require('../src/user-data');

const users = [];
let server;
let base;

function newUser() {
  const uid = `it-stats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  users.push(uid);
  return uid;
}

async function api(uid, method, route, body) {
  const response = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${uid}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const imported = (uid, show, actions) => api(uid, 'POST', `/me/progress/${show}/import`, {
  totalEpisodes: 30, showName: `Show ${show}`, actions,
});

test.before(async () => {
  await initializeDatabase();
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/v1', router);
  app.use((error, _request, response, _next) => {
    response.status(error.status || 500).json({ detail: error.message });
  });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (users.length) await pool.query('DELETE FROM app_users WHERE firebase_uid = ANY($1)', [users]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('stats: totals, bulk checks kept out of the records, movies, runtimes from TMDB', async () => {
  const uid = newUser();
  const spread = ['S1E1', 'S1E2', 'S1E3'].map((key, i) => ({ key, watched: true, at: `2026-05-10T1${i}:00:00Z` }));
  const bulk = Array.from({ length: 6 }, (_, i) => ({ key: `S1E${i + 4}`, watched: true, at: '2026-05-12T09:15:00Z' }));
  assert.equal((await imported(uid, 9201, [...spread, ...bulk])).status, 200);
  await pool.query(
    `INSERT INTO movie_watchlist(firebase_uid, movie_id, movie, watched_on)
     VALUES ($1, 77, '{"title":"A Movie","runtime":100}'::jsonb, '2026-05-11')`,
    [uid],
  );

  const { status, body } = await api(uid, 'GET', '/me/stats');
  assert.equal(status, 200);
  assert.equal(body.totals.episodes, 9);
  assert.equal(body.totals.movies, 1);
  assert.equal(body.totals.minutes.episodes, 9 * 30, 'TMDB runtime of 30 minutes');
  assert.equal(body.totals.minutes.movies, 100);
  assert.equal(body.bulkEpisodes, 6);
  assert.deepEqual(body.biggestBinge, { episodes: 3, showId: 9201, showName: 'Show 9201', date: '2026-05-10' });
  assert.deepEqual(body.streak.longest, { days: 2, from: '2026-05-10', to: '2026-05-11' });
  assert.equal(body.approximate, false);
  assert.equal(body.months[0].month, '2026-05');
  assert.equal(body.months[0].episodes, 9, 'bulk episodes still count in the month');
});

test('stats: a show whose runtime could not be fetched counts 42 minutes and the answer says it is approximate', async () => {
  const uid = newUser();
  assert.equal((await imported(uid, SLOW_SHOW, [{ key: 'S1E1', watched: true, at: '2026-05-10T10:00:00Z' }])).status, 200);
  const { body } = await api(uid, 'GET', '/me/stats');
  assert.equal(body.totals.minutes.episodes, 42);
  assert.equal(body.approximate, true);
});

test('stats: a new account has empty stats, and the route needs sign-in', async () => {
  const uid = newUser();
  const { status, body } = await api(uid, 'GET', '/me/stats');
  assert.equal(status, 200);
  assert.equal(body.totals.episodes, 0);
  assert.equal(body.biggestBinge, null);
  const anonymous = await fetch(`${base}/api/v1/me/stats`);
  assert.equal(anonymous.status, 401);
});

test('stats: a show with no episode_run_time uses the median of its first season, not a long finale', async () => {
  const uid = newUser();
  assert.equal((await imported(uid, NO_RUNTIME_SHOW, [
    { key: 'S1E1', watched: true, at: '2026-05-10T10:00:00Z' },
    { key: 'S1E2', watched: true, at: '2026-05-11T10:00:00Z' },
  ])).status, 200);
  const { body } = await api(uid, 'GET', '/me/stats');
  assert.equal(body.totals.minutes.episodes, 2 * 22, 'median of 20, 22, 22, 90 is 22');
  assert.equal(body.approximate, false);
});
