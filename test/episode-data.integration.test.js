// Episode ratings (episode-data.js) against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is
// set; see progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('episode data integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

const stubs = {
  './firebase': {
    admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token, email: `${token}@example.test` }) }) },
  },
  './tmdb': {
    getTvSeason: async () => ({ season_number: 1, episodes: [] }),
    getTvShowClassificationData: async () => ({ seasons: [], status: 'Returning Series' }),
  },
  './upcoming': { getUpcomingEpisodes: async () => [] },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('user-data.js') && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};

const express = require('express');
const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { router } = require('../src/user-data');
const { loadHistory } = require('../src/recommendations');

const users = [];
let server;
let base;

function newUser() {
  const uid = `it-episode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('a rating is saved, listed by S1E2 key, changed and cleared', async () => {
  const uid = newUser();
  assert.deepEqual((await api(uid, 'GET', '/me/shows/50/episode-ratings')).body, { ratings: {} });

  assert.equal((await api(uid, 'PUT', '/me/shows/50/episodes/1/2/rating', { rating: 4 })).status, 200);
  assert.equal((await api(uid, 'PUT', '/me/shows/50/episodes/2/1/rating', { rating: 5 })).status, 200);
  assert.deepEqual((await api(uid, 'GET', '/me/shows/50/episode-ratings')).body, { ratings: { S1E2: 4, S2E1: 5 } });

  await api(uid, 'PUT', '/me/shows/50/episodes/1/2/rating', { rating: 2 });
  assert.equal((await api(uid, 'GET', '/me/shows/50/episode-ratings')).body.ratings.S1E2, 2, 'changed in place');

  assert.equal((await api(uid, 'DELETE', '/me/shows/50/episodes/1/2/rating')).status, 200);
  assert.deepEqual((await api(uid, 'GET', '/me/shows/50/episode-ratings')).body, { ratings: { S2E1: 5 } });
  assert.equal(
    (await pool.query('SELECT 1 FROM episode_user_data WHERE firebase_uid=$1 AND season=1 AND episode=2', [uid])).rowCount,
    0,
    'an empty row is not kept',
  );
});

test('ratings belong to one show and one user', async () => {
  const a = newUser();
  const b = newUser();
  await api(a, 'PUT', '/me/shows/60/episodes/1/1/rating', { rating: 3 });
  assert.deepEqual((await api(a, 'GET', '/me/shows/61/episode-ratings')).body, { ratings: {} });
  assert.deepEqual((await api(b, 'GET', '/me/shows/60/episode-ratings')).body, { ratings: {} });
});

test('bad input is refused', async () => {
  const uid = newUser();
  for (const rating of [0, 6, 2.5, '4', null]) {
    assert.equal((await api(uid, 'PUT', '/me/shows/70/episodes/1/1/rating', { rating })).status, 400, `rating ${rating}`);
  }
  assert.equal((await api(uid, 'PUT', '/me/shows/70/episodes/x/1/rating', { rating: 3 })).status, 400);
  assert.equal((await api(uid, 'PUT', '/me/shows/0/episodes/1/1/rating', { rating: 3 })).status, 400);
  assert.equal((await api(uid, 'GET', '/me/shows/abc/episode-ratings')).status, 400);
});

test('the recommendation history reads each show\'s average rating and how many episodes it covers', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/shows/80/episodes/1/1/rating', { rating: 5 });
  await api(uid, 'PUT', '/me/shows/80/episodes/1/2/rating', { rating: 3 });
  await api(uid, 'PUT', '/me/shows/81/episodes/2/1/rating', { rating: 1 });
  const { ratings } = await loadHistory(uid);
  assert.deepEqual(ratings.get(80), { average: 4, count: 2 });
  assert.deepEqual(ratings.get(81), { average: 1, count: 1 });
  assert.equal(ratings.has(82), false);

  await api(uid, 'DELETE', '/me/shows/81/episodes/2/1/rating');
  assert.equal((await loadHistory(uid)).ratings.has(81), false, 'a cleared rating no longer counts');
});
