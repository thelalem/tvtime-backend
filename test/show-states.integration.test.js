// "Stop watching" and "Remove" (show-states.js) against a real PostgreSQL. Skipped unless
// TEST_DATABASE_URL is set; see progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('show state integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

let classificationGate = Promise.resolve();
const stubs = {
  './firebase': {
    admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token, email: `${token}@example.test` }) }) },
  },
  // Shows 900 and up have one aired season of three episodes, so the classification refresh
  // sees them as started and not caught up; the rest have no episodes.
  './tmdb': {
    getTvSeason: async (id) => ({
      season_number: 1,
      episodes: id >= 900
        ? [1, 2, 3].map((n) => ({ episode_number: n, air_date: '2020-01-0' + n }))
        : [],
    }),
    getTvShowClassificationData: async (id) => {
      // Shows 960 and up wait here, so a test can hold a refresh mid-way.
      if (id >= 960) await classificationGate;
      return { seasons: id >= 900 ? [{ season_number: 1 }] : [], status: 'Returning Series' };
    },
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
const { refreshStaleClassifications, router } = require('../src/user-data');

const users = [];
let server;
let base;

function newUser() {
  const uid = `it-states-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

const show = (id, name) => ({ id, name, posterPath: `/${id}.jpg`, backdropPath: null, overview: '', rating: 0, firstAirDate: '2020-01-01' });
const add = (uid, id, name) => api(uid, 'PUT', `/me/watchlist/${id}`, show(id, name));
const watch = (uid, id, name) => api(uid, 'POST', `/me/progress/${id}/import`, {
  actions: [{ key: 'S1E1', watched: true, at: '2026-09-01T10:00:00Z' }],
  totalEpisodes: 10,
  showName: name,
});
const state = async (uid, id) => (await api(uid, 'GET', `/me/shows/${id}/state`)).body.state;
const view = async (uid) => (await api(uid, 'GET', '/me/watchlist-view')).body;
const allShowIds = (body) => body.allShows.map((entry) => Number(entry.show.id)).sort();
const watchlistIds = (body) => body.watchlist.map((s) => Number(s.id)).sort();

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

test('stop watching: off the watchlist, in All Shows as stopped with its progress; continue restores it', async () => {
  const uid = newUser();
  await add(uid, 10, 'Ten');
  await watch(uid, 10, 'Ten');
  await add(uid, 11, 'Eleven');
  assert.equal(await state(uid, 10), 'watchlist');

  const stopped = await api(uid, 'PUT', '/me/shows/10/stopped', show(10, 'Ten'));
  assert.equal(stopped.status, 200);
  assert.equal(await state(uid, 10), 'stopped');

  let body = await view(uid);
  assert.deepEqual(watchlistIds(body), [11]);
  assert.deepEqual(allShowIds(body), [10, 11]);
  const entry = body.allShows.find((e) => Number(e.show.id) === 10);
  assert.equal(entry.progress.classification, 'stopped');
  assert.equal(entry.progress.watchedCount, 1, 'the progress is kept');
  assert.equal(entry.show.name, 'Ten');

  const resumed = await api(uid, 'DELETE', '/me/shows/10/stopped');
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.name, 'Ten');
  assert.equal(await state(uid, 10), 'watchlist');
  body = await view(uid);
  assert.deepEqual(watchlistIds(body), [10, 11]);
  assert.notEqual(body.allShows.find((e) => Number(e.show.id) === 10).progress.classification, 'stopped');

  assert.equal((await api(uid, 'DELETE', '/me/shows/10/stopped')).status, 404, 'no longer stopped');
});

test('a show that was never started can be stopped too', async () => {
  const uid = newUser();
  await add(uid, 20, 'Twenty');
  await api(uid, 'PUT', '/me/shows/20/stopped', show(20, 'Twenty'));
  const body = await view(uid);
  assert.deepEqual(watchlistIds(body), []);
  const entry = body.allShows.find((e) => Number(e.show.id) === 20);
  assert.equal(entry.progress.classification, 'stopped');
  assert.equal(entry.progress.watchedCount, 0);
  assert.equal(entry.show.posterPath, '/20.jpg');
});

test('remove: gone from every list, progress kept; adding it again brings it back', async () => {
  const uid = newUser();
  await add(uid, 30, 'Thirty');
  await watch(uid, 30, 'Thirty');

  const removed = await api(uid, 'PUT', '/me/shows/30/removed', show(30, 'Thirty'));
  assert.equal(removed.status, 200);
  assert.equal(await state(uid, 30), 'removed');
  let body = await view(uid);
  assert.deepEqual(watchlistIds(body), []);
  assert.deepEqual(allShowIds(body), [], 'not in All Shows even though it has progress');
  const kept = await api(uid, 'GET', '/me/progress/30');
  assert.equal(kept.body.watchedCount, 1, 'the progress row is untouched');

  await add(uid, 30, 'Thirty');
  assert.equal(await state(uid, 30), 'watchlist');
  body = await view(uid);
  assert.deepEqual(watchlistIds(body), [30]);
  assert.equal(body.allShows.find((e) => Number(e.show.id) === 30).progress.watchedCount, 1);
});

test('a stopped show can be removed for good', async () => {
  const uid = newUser();
  await add(uid, 40, 'Forty');
  await watch(uid, 40, 'Forty');
  await api(uid, 'PUT', '/me/shows/40/stopped', show(40, 'Forty'));
  await api(uid, 'PUT', '/me/shows/40/removed', show(40, 'Forty'));
  assert.equal(await state(uid, 40), 'removed');
  assert.deepEqual(allShowIds(await view(uid)), []);
});

test('the stopped and removed ids are listed together', async () => {
  const uid = newUser();
  await add(uid, 70, 'Seventy');
  await add(uid, 71, 'Seventy-one');
  await add(uid, 72, 'Seventy-two');
  await api(uid, 'PUT', '/me/shows/70/stopped', show(70, 'Seventy'));
  await api(uid, 'PUT', '/me/shows/71/removed', show(71, 'Seventy-one'));
  const listed = await api(uid, 'GET', '/me/show-states');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { stopped: [70], removed: [71] });
});

test('a show the user never had reads as none; bad requests are refused', async () => {
  const uid = newUser();
  assert.equal(await state(uid, 50), 'none');
  assert.equal((await api(uid, 'PUT', '/me/shows/50/stopped', show(51, 'Wrong id'))).status, 400);
  assert.equal((await api(uid, 'PUT', '/me/shows/50/paused', show(50, 'Fifty'))).status, 404);
  assert.equal((await api(uid, 'GET', '/me/shows/abc/state')).status, 400);
});

test('another user is not affected', async () => {
  const one = newUser();
  const two = newUser();
  await add(one, 60, 'Sixty');
  await add(two, 60, 'Sixty');
  await api(one, 'PUT', '/me/shows/60/removed', show(60, 'Sixty'));
  assert.equal(await state(two, 60), 'watchlist');
  assert.deepEqual(watchlistIds(await view(two)), [60]);
});

test('the classification sweep does not put a stopped or removed show back on the watchlist', async () => {
  const uid = newUser();
  for (const [id, name] of [[900, 'Stopped'], [901, 'Removed'], [902, 'Dropped off']]) {
    await add(uid, id, name);
    await watch(uid, id, name);
  }
  // Let the refreshes the progress writes started settle first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await api(uid, 'PUT', '/me/shows/900/stopped', show(900, 'Stopped'));
  await api(uid, 'PUT', '/me/shows/901/removed', show(901, 'Removed'));
  // Control: off the watchlist with no state, started and not caught up, so the sweep re-adds it.
  await pool.query('DELETE FROM watchlist WHERE firebase_uid=$1 AND series_id=902', [uid]);
  await pool.query(
    'UPDATE show_progress SET classification_checked_at=NULL WHERE firebase_uid=$1',
    [uid],
  );

  await refreshStaleClassifications();

  assert.deepEqual(watchlistIds(await view(uid)), [902], 'only the show with no state comes back');
  assert.equal(await state(uid, 900), 'stopped');
  assert.equal(await state(uid, 901), 'removed');
});

test('a change made while a refresh is running gets the last word', async () => {
  const uid = newUser();
  const tick = (keys, watched) => api(uid, 'PATCH', '/me/progress/960/episodes', {
    episodeKeys: keys, watched, currentSeason: 1, currentEpisode: 1, totalEpisodes: 3,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
  await add(uid, 960, 'Held');
  assert.equal((await tick(['S1E1', 'S1E2'], true)).status, 200);
  await settle();

  let release;
  classificationGate = new Promise((resolve) => { release = resolve; });
  assert.equal((await tick(['S1E3'], true)).status, 200); // refresh A starts: all 3 watched
  await settle(); // A has read the progress and is waiting
  assert.equal((await tick(['S1E3'], false)).status, 200); // unticked while A runs
  release();
  await settle();
  classificationGate = Promise.resolve();

  const body = await view(uid);
  assert.deepEqual(watchlistIds(body), [960], 'still on the watchlist: not caught up');
  assert.equal(body.allShows.find((e) => Number(e.show.id) === 960).progress.classification, 'watching');
});

test('a poll the client already has is answered 304 with no body; a change is sent in full', async () => {
  const uid = newUser();
  await add(uid, 80, 'Eighty');
  const get = (route, tag) => fetch(`${base}/api/v1${route}`, {
    headers: { authorization: `Bearer ${uid}`, ...(tag ? { 'if-none-match': tag } : {}) },
  });
  for (const route of ['/me/watchlist', '/me/progress', '/me/show-states']) {
    const first = await get(route);
    const tag = first.headers.get('etag');
    assert.equal(first.status, 200, route);
    assert.ok(tag, route);
    const again = await get(route, tag);
    assert.equal(again.status, 304, route);
    assert.equal(await again.text(), '', route);
    assert.equal((await get(route, `W/${tag}`)).status, 304, `${route}: the weak form Cloudflare sends`);
  }
  const before = (await get('/me/watchlist')).headers.get('etag');
  await add(uid, 81, 'Eighty-one');
  const changed = await get('/me/watchlist', before);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).length, 2);
});

test('the compact watchlist view carries no episode lists and no All Shows', async () => {
  const uid = newUser();
  await add(uid, 85, 'Eighty-five');
  await watch(uid, 85, 'Eighty-five');
  const full = (await api(uid, 'GET', '/me/watchlist-view')).body;
  const compact = (await api(uid, 'GET', '/me/watchlist-view?compact=1')).body;
  assert.ok(full.allShows && full.progress[0].watchedEpisodes, 'the full answer is unchanged');
  assert.equal(compact.allShows, undefined);
  assert.deepEqual(watchlistIds(compact), [85]);
  const row = compact.progress.find((p) => Number(p.seriesId) === 85);
  assert.equal(row.watchedEpisodes, undefined);
  assert.equal(row.watchedEpisodeDates, undefined);
  assert.equal(row.watchedCount, 1, 'the summary fields stay');
});
