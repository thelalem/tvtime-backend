// Rewatches and rewatch passes (rewatches.js) through the real routes and PostgreSQL. Skipped unless
// TEST_DATABASE_URL is set; see progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('rewatch integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
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

const SHOW = 9100;
const users = [];
let server;
let base;

function newUser() {
  const uid = `it-rewatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

const R = `/me/progress/${SHOW}/rewatch`;
const watch = (uid, keys, watched = true) => api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, {
  episodeKeys: keys, watched, currentSeason: 1, currentEpisode: 1, totalEpisodes: 10,
});
const season = (n, count) => Array.from({ length: count }, (_, i) => `S${n}E${i + 1}`);
const startPassOn = (uid, n) => api(uid, 'POST', `${R}/passes`, { season: n });
const rewatchOf = (uid, key, body = {}) => api(uid, 'PUT', `${R}/episodes/${key}`, body);
const levels = (progress) => Object.fromEntries(
  Object.entries(progress.rewatches).map(([key, list]) => [key, 1 + list.length]),
);

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

test('a progress row carries no rewatch data until there is some', async () => {
  const uid = newUser();
  const row = (await watch(uid, season(1, 3))).body;
  assert.deepEqual(row.rewatches, {});
  assert.equal(row.rewatchCount, 0);
  assert.deepEqual(row.rewatchPasses, []);
});

test('a pass: start, tick through it, and it finishes by itself', async () => {
  const uid = newUser();
  await watch(uid, season(1, 3));

  const started = await startPassOn(uid, 1);
  assert.equal(started.status, 201);
  assert.deepEqual(started.body.progress.rewatchPasses.map((pass) => [pass.season, pass.target]), [[1, 2]]);
  assert.deepEqual(started.body.progress.rewatchPasses[0].episodes, ['S1E1', 'S1E2', 'S1E3']);
  assert.equal((await startPassOn(uid, 1)).status, 409, 'a second pass for the same season');

  let result = (await rewatchOf(uid, 'S1E1')).body;
  assert.equal(result.progress.rewatchCount, 1);
  assert.deepEqual(result.completedSeasons, []);
  assert.equal(result.progress.rewatches.S1E1[0].source, 'pass');
  result = (await rewatchOf(uid, 'S1E2')).body;
  result = (await rewatchOf(uid, 'S1E3')).body;
  assert.deepEqual(result.completedSeasons, [1]);
  assert.deepEqual(result.progress.rewatchPasses, [], 'the pass is gone');
  assert.deepEqual(levels(result.progress), { S1E1: 2, S1E2: 2, S1E3: 2 });
  assert.equal(result.progress.rewatchCount, 3);
});

test('a second pass after a finished one aims for 3x', async () => {
  const uid = newUser();
  await watch(uid, season(1, 2));
  await startPassOn(uid, 1);
  await rewatchOf(uid, 'S1E1');
  await rewatchOf(uid, 'S1E2');
  const again = await startPassOn(uid, 1);
  assert.equal(again.body.progress.rewatchPasses[0].target, 3);
});

test('two seasons can have a pass open at once', async () => {
  const uid = newUser();
  await watch(uid, [...season(1, 2), ...season(3, 2)]);
  await startPassOn(uid, 1);
  const second = await startPassOn(uid, 3);
  assert.deepEqual(second.body.progress.rewatchPasses.map((pass) => pass.season), [1, 3]);
  // Ticking in season 3 does not touch season 1's pass.
  await rewatchOf(uid, 'S3E1');
  const { body } = await rewatchOf(uid, 'S3E2');
  assert.deepEqual(body.completedSeasons, [3]);
  assert.deepEqual(body.progress.rewatchPasses.map((pass) => pass.season), [1]);
});

test('stop keeps what was ticked and ends the pass', async () => {
  const uid = newUser();
  await watch(uid, season(1, 3));
  await startPassOn(uid, 1);
  await rewatchOf(uid, 'S1E1');
  const stopped = await api(uid, 'POST', `${R}/passes/1/stop`);
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.body.progress.rewatchPasses, []);
  assert.deepEqual(levels(stopped.body.progress), { S1E1: 2 });
  assert.equal((await api(uid, 'POST', `${R}/passes/1/stop`)).status, 404);
});

test('cancel takes back what the pass added, but not an earlier rewatch', async () => {
  const uid = newUser();
  await watch(uid, season(1, 3));
  await rewatchOf(uid, 'S1E1'); // before any pass: a manual rewatch
  await startPassOn(uid, 1);    // lowest is 1x (E2, E3) so the target is 2
  await rewatchOf(uid, 'S1E2');
  await rewatchOf(uid, 'S1E1'); // E1 is already at 2x, so this one is manual too
  const cancelled = await api(uid, 'POST', `${R}/passes/1/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.removed, 1, 'only the pass tick on E2');
  assert.deepEqual(cancelled.body.progress.rewatchPasses, []);
  assert.deepEqual(levels(cancelled.body.progress), { S1E1: 3 });
});

test('finish marks what is left, with a chosen day, and ends the pass', async () => {
  const uid = newUser();
  await watch(uid, season(1, 4));
  await startPassOn(uid, 1);
  await rewatchOf(uid, 'S1E1');
  const day = '2026-10-01T12:00:00.000Z';
  const finished = await api(uid, 'POST', `${R}/passes/1/finish`, { at: day });
  assert.equal(finished.body.added, 3);
  assert.deepEqual(finished.body.completedSeasons, [1]);
  assert.equal(finished.body.progress.rewatches.S1E4[0].at, day);
  assert.equal(finished.body.progress.rewatchCount, 4);
});

test('removing the latest rewatch of an episode; the episode stays watched', async () => {
  const uid = newUser();
  await watch(uid, season(1, 2));
  await rewatchOf(uid, 'S1E1', { at: '2026-09-01T10:00:00.000Z' });
  await rewatchOf(uid, 'S1E1', { at: '2026-10-01T10:00:00.000Z' });
  const removed = await api(uid, 'DELETE', `${R}/episodes/S1E1`);
  assert.deepEqual(removed.body.progress.rewatches.S1E1.map((entry) => entry.at), ['2026-09-01T10:00:00.000Z']);
  await api(uid, 'DELETE', `${R}/episodes/S1E1`);
  const none = await api(uid, 'DELETE', `${R}/episodes/S1E1`);
  assert.equal(none.status, 404);
  const progress = (await api(uid, 'GET', `/me/progress/${SHOW}`)).body;
  assert.ok(progress.watchedEpisodes.includes('S1E1'));
  assert.equal(progress.rewatchCount, 0);
});

test('removing the last rewatch of a season is refused while its pass is open', async () => {
  const uid = newUser();
  await watch(uid, season(1, 2));
  await startPassOn(uid, 1);
  await rewatchOf(uid, 'S1E1');
  assert.equal((await api(uid, 'POST', `${R}/seasons/1/remove-last`)).status, 409);
  await rewatchOf(uid, 'S1E2'); // finishes
  const removed = await api(uid, 'POST', `${R}/seasons/1/remove-last`);
  assert.equal(removed.body.removed, 2);
  assert.equal(removed.body.progress.rewatchCount, 0);
  assert.equal((await api(uid, 'POST', `${R}/seasons/1/remove-last`)).status, 404);
});

test('un-ticking an episode forgets its rewatches and shrinks (or ends) the pass', async () => {
  const uid = newUser();
  await watch(uid, season(1, 2));
  await startPassOn(uid, 1);
  await rewatchOf(uid, 'S1E1');
  // E2 is the only one left to rewatch; un-tick it and the pass is over (E1 is done).
  const un = await watch(uid, ['S1E2'], false);
  assert.deepEqual(un.body.rewatchPasses, []);
  assert.deepEqual(levels(un.body), { S1E1: 2 });
  // Un-ticking E1 itself drops its rewatch; ticking it again starts from one.
  const gone = await watch(uid, ['S1E1'], false);
  assert.deepEqual(gone.body.rewatches, {});
  const again = await watch(uid, ['S1E1']);
  assert.deepEqual(again.body.rewatches, {});
  assert.equal(again.body.rewatchCount, 0);
});

test('only watched episodes can be rewatched, and a pass needs something watched', async () => {
  const uid = newUser();
  await watch(uid, ['S1E1']);
  assert.equal((await rewatchOf(uid, 'S1E5')).status, 409);
  assert.equal((await startPassOn(uid, 2)).status, 409);
  assert.equal((await rewatchOf(uid, 'bogus')).status, 400);
  assert.equal((await startPassOn(uid, 0)).status, 400);
  assert.equal((await api(uid, 'PUT', `/me/progress/777/rewatch/episodes/S1E1`, {})).status, 404, 'not tracked');
});

test('a chosen day must be real and not far in the future', async () => {
  const uid = newUser();
  await watch(uid, ['S1E1']);
  assert.equal((await rewatchOf(uid, 'S1E1', { at: 'nope' })).status, 400);
  assert.equal((await rewatchOf(uid, 'S1E1', { at: '2999-01-01T00:00:00Z' })).status, 400);
  assert.equal((await rewatchOf(uid, 'S1E1', { at: '2020-01-01T12:00:00Z' })).status, 200);
});

test('a rewatch makes the show recently watched; a past day does not move it back', async () => {
  const uid = newUser();
  const first = (await watch(uid, ['S1E1'])).body;
  const before = new Date(first.lastWatched).getTime();
  await rewatchOf(uid, 'S1E1', { at: '2020-01-01T12:00:00Z' });
  const same = (await api(uid, 'GET', `/me/progress/${SHOW}`)).body;
  assert.equal(new Date(same.lastWatched).getTime(), before, 'an old day does not make it older');
});

test('the lists carry the rewatch data too', async () => {
  const uid = newUser();
  await watch(uid, season(1, 2));
  await startPassOn(uid, 1);
  await rewatchOf(uid, 'S1E1');
  const list = (await api(uid, 'GET', '/me/progress')).body;
  assert.equal(list[0].rewatchCount, 1);
  assert.equal(list[0].rewatchPasses[0].season, 1);
  const view = (await api(uid, 'GET', '/me/watchlist-view')).body;
  const row = view.progress.find((entry) => Number(entry.seriesId) === SHOW);
  assert.equal(row.rewatchCount, 1);
});

test('deleting a show\'s progress drops its passes; another user is unaffected', async () => {
  const a = newUser();
  const b = newUser();
  await watch(a, season(1, 2));
  await watch(b, season(1, 2));
  await startPassOn(a, 1);
  await startPassOn(b, 1);
  await api(a, 'DELETE', `/me/progress/${SHOW}`);
  const rows = await pool.query('SELECT firebase_uid FROM rewatch_passes WHERE firebase_uid = ANY($1)', [[a, b]]);
  assert.deepEqual(rows.rows.map((row) => row.firebase_uid), [b]);
});

test('an import that un-ticks an episode forgets its rewatches', async () => {
  const uid = newUser();
  await watch(uid, season(1, 2));
  await rewatchOf(uid, 'S1E1');
  const future = new Date(Date.now() + 1000).toISOString();
  const imported = await api(uid, 'POST', `/me/progress/${SHOW}/import`, {
    actions: [{ key: 'S1E1', watched: false, at: future }], totalEpisodes: 2,
  });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.body.rewatches, {});
});

test('TV Time import (fill mode): the app wins, gaps are filled, rewatches are topped up, rerun changes nothing', async () => {
  const uid = newUser();
  const imp = (body) => api(uid, 'POST', `/me/progress/${SHOW}/import`, { totalEpisodes: 10, showName: 'Show', ...body });
  await watch(uid, ['S1E1']);                                   // watched in the app today
  await watch(uid, ['S1E2']);
  await watch(uid, ['S1E2'], false);                            // un-ticked in the app
  const appDate = (await api(uid, 'GET', `/me/progress/${SHOW}`)).body.watchedEpisodeDates.S1E1;

  const file = {
    mode: 'fill',
    actions: ['S1E1', 'S1E2', 'S1E3', 'S1E4'].map((key) => ({ key, watched: true, at: '2031-01-01T00:00:00Z' })),
    rewatchCounts: [{ key: 'S1E1', count: 2 }, { key: 'S1E3', count: 1 }, { key: 'S1E2', count: 1 }],
  };
  const first = await imp(file);
  assert.equal(first.status, 200);
  assert.equal(first.body.watchedEpisodeDates.S1E1, appDate, "the app's own date stays, even though the file's is newer");
  assert.equal(first.body.watchedEpisodes.includes('S1E2'), false, 'an episode un-ticked in the app stays un-ticked');
  assert.ok(first.body.watchedEpisodes.includes('S1E3') && first.body.watchedEpisodes.includes('S1E4'));
  assert.equal(first.body.watchedEpisodeDates.S1E3, '2031-01-01T00:00:00.000Z');
  assert.equal(first.body.rewatches.S1E1.length, 2);
  assert.equal(first.body.rewatches.S1E3.length, 1);
  assert.equal('S1E2' in first.body.rewatches, false);

  const second = await imp(file);
  assert.deepEqual(second.body.rewatches, first.body.rewatches, 'a rerun adds no rewatches');
  assert.deepEqual(second.body.watchedEpisodeDates, first.body.watchedEpisodeDates);

  for (const bad of [{ mode: 'x' }, { rewatchCounts: [{ key: 'S1E1', count: 0 }] }, { rewatchCounts: [{ key: 'bad', count: 1 }] }]) {
    assert.equal((await imp({ actions: [], ...bad })).status, 400);
  }
});

test('TV Time import with real rewatch dates, and the same request again', async () => {
  const uid = newUser();
  const body = {
    mode: 'fill', totalEpisodes: 10, showName: 'Show',
    actions: [{ key: 'S1E1', watched: true, at: '2020-01-01T00:00:00Z' }],
    rewatchDates: [{ key: 'S1E1', ats: ['2020-06-01T00:00:00Z', '2021-06-01T00:00:00Z'] }],
  };
  const first = await api(uid, 'POST', `/me/progress/${SHOW}/import`, body);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.rewatches.S1E1.map((r) => r.at), ['2020-06-01T00:00:00.000Z', '2021-06-01T00:00:00.000Z']);
  const second = await api(uid, 'POST', `/me/progress/${SHOW}/import`, body);
  assert.deepEqual(second.body.rewatches, first.body.rewatches);
  const bad = await api(uid, 'POST', `/me/progress/${SHOW}/import`, { ...body, rewatchDates: [{ key: 'S1E1', ats: ['nope'] }] });
  assert.equal(bad.status, 400);
});
