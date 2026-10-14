// Runs the real routes and SQL against a real PostgreSQL. Skipped unless
// TEST_DATABASE_URL is set, and deliberately NOT DATABASE_URL, so running the
// tests can never be pointed at a production database by accident:
//
//   docker compose up -d db
//   TEST_DATABASE_URL=postgres://tv_time:tv_time_dev@localhost:5432/tv_time npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('progress endpoint integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

// Firebase, TMDB and the upcoming feed are replaced; the database is real. A
// bearer token is simply taken to be the user's uid.
const tmdbState = { seasons: [], episodes: [] };
const stubs = {
  './firebase': {
    admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token, email: `${token}@example.test` }) }) },
  },
  './tmdb': {
    getTvSeason: async () => ({ season_number: 1, episodes: tmdbState.episodes }),
    getTvShowClassificationData: async () => ({ seasons: tmdbState.seasons, status: 'Returning Series' }),
  },
  './upcoming': { getUpcomingEpisodes: async () => [] },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('user-data.js') && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};

const express = require('express');
const { localDateString } = require('../src/local-date');
const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { router } = require('../src/user-data');

const SHOW = 1399;
const users = [];
let server;
let base;

function newUser() {
  const uid = `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

const importShow = (uid, actions, extra = {}, series = SHOW) =>
  api(uid, 'POST', `/me/progress/${series}/import`, { actions, ...extra });
const act = (key, watched, at) => ({ key, watched, at });
const progress = (uid, series = SHOW) => api(uid, 'GET', `/me/progress/${series}`);
const unwatchedRows = async (uid, series = SHOW) =>
  (await pool.query(
    'SELECT episode_key, unwatched_at FROM unwatched_episodes WHERE firebase_uid=$1 AND series_id=$2 ORDER BY episode_key',
    [uid, series],
  )).rows;
const watchedKeys = (row) => [...row.watchedEpisodes].sort();

test.before(async () => {
  await initializeDatabase();
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/v1', router);
  // Same as server.js: errors come back as JSON.
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

test('imports episodes with their dates and the show appears in progress', async () => {
  const uid = newUser();
  const res = await importShow(uid, [
    act('S1E1', true, '2026-06-30T16:18:00Z'),
    act('S1E2', true, '2026-07-01T10:00:00Z'),
  ], { totalEpisodes: 10, showName: 'Game', posterPath: '/p.jpg' });
  assert.equal(res.status, 200);
  assert.deepEqual(watchedKeys(res.body), ['S1E1', 'S1E2']);
  assert.equal(res.body.watchedCount, 2);
  assert.equal(res.body.totalEpisodes, 10);
  assert.equal(res.body.watchedEpisodeDates.S1E1, '2026-06-30T16:18:00.000Z');
  assert.equal(new Date(res.body.lastWatched).toISOString(), '2026-07-01T10:00:00.000Z');
  assert.equal(res.body.showName, 'Game');
});

test('THE BUG, end to end: an older export cannot resurrect an episode a newer one unwatched', async () => {
  const uid = newUser();
  const october = [
    act('S1E1', true, '2026-06-30T16:18:00Z'),
    act('S1E1', false, '2026-08-01T00:00:00Z'),
    act('S1E2', true, '2026-06-30T16:18:00Z'),
  ];
  const july = [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')];

  await importShow(uid, october);
  assert.deepEqual(watchedKeys((await progress(uid)).body), ['S1E2']);

  const after = await importShow(uid, july);
  assert.equal(after.status, 200);
  assert.deepEqual(watchedKeys(after.body), ['S1E2'], 'S1E1 stays unwatched');
  const remembered = await unwatchedRows(uid);
  assert.deepEqual(remembered.map((r) => r.episode_key), ['S1E1']);
});

test('the result is the same whichever export is imported first', async () => {
  const july = [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')];
  const october = [
    act('S1E1', true, '2026-06-30T16:18:00Z'),
    act('S1E1', false, '2026-08-01T00:00:00Z'),
    act('S1E3', true, '2026-09-01T00:00:00Z'),
  ];
  const a = newUser();
  const b = newUser();
  await importShow(a, july);
  await importShow(a, october);
  await importShow(b, october);
  await importShow(b, july);
  const rowA = (await progress(a)).body;
  const rowB = (await progress(b)).body;
  assert.deepEqual(watchedKeys(rowA), ['S1E2', 'S1E3']);
  assert.deepEqual(watchedKeys(rowB), watchedKeys(rowA));
  assert.deepEqual(rowB.watchedEpisodeDates, rowA.watchedEpisodeDates);
});

test('a newer watch beats an older unwatch; ties keep what is stored', async () => {
  const uid = newUser();
  await importShow(uid, [act('S1E1', false, '2026-08-01T00:00:00Z')]);
  const watched = await importShow(uid, [act('S1E1', true, '2026-09-01T00:00:00Z'), act('S1E2', true, '2026-09-01T00:00:00Z')]);
  assert.deepEqual(watchedKeys(watched.body), ['S1E1', 'S1E2']);
  assert.deepEqual(await unwatchedRows(uid), [], 'the remembered unwatch is cleared');

  const tie = await importShow(uid, [act('S1E2', false, '2026-09-01T00:00:00Z')]);
  assert.deepEqual(watchedKeys(tie.body), ['S1E1', 'S1E2'], 'equal time keeps the stored state');
});

test('a show with nothing watched gets no progress row and stays invisible, but is remembered', async () => {
  const uid = newUser();
  const res = await importShow(uid, [act('S1E1', false, '2026-08-01T00:00:00Z'), act('S1E2', false, '2026-08-02T00:00:00Z')]);
  assert.equal(res.status, 204);

  assert.equal((await progress(uid)).status, 404);
  assert.deepEqual((await api(uid, 'GET', '/me/progress')).body, []);
  const view = (await api(uid, 'GET', '/me/watchlist-view')).body;
  assert.deepEqual(view.allShows, [], 'All Shows does not list it');
  assert.deepEqual(view.progress, []);
  assert.deepEqual(view.watchlist, []);
  assert.equal((await unwatchedRows(uid)).length, 2, 'but the unwatches are remembered');

  // An older watch (June) than the remembered unwatch (August) is ignored, so
  // the show still has nothing watched: still no row.
  const older = await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  assert.equal(older.status, 204);
  assert.equal((await progress(uid)).status, 404);
  assert.equal((await unwatchedRows(uid)).length, 2);

  // A newer watch (September) does apply.
  const newer = await importShow(uid, [act('S1E1', true, '2026-09-01T00:00:00Z')]);
  assert.equal(newer.status, 200);
  assert.deepEqual(watchedKeys(newer.body), ['S1E1']);
});

test('an import that unwatches everything removes an existing row (204) and keeps the memory', async () => {
  const uid = newUser();
  await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  const res = await importShow(uid, [act('S1E1', false, '2026-08-01T00:00:00Z')]);
  assert.equal(res.status, 204);
  assert.equal((await progress(uid)).status, 404);
  assert.equal((await unwatchedRows(uid)).length, 1);
});

test('unmarking in the app is remembered, so an older import cannot undo it', async () => {
  const uid = newUser();
  await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')]);
  const unmark = await api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, {
    episodeKeys: ['S1E1'], watched: false, currentSeason: 1, currentEpisode: 1,
  });
  assert.equal(unmark.status, 200);
  assert.deepEqual(watchedKeys(unmark.body), ['S1E2']);
  assert.equal((await unwatchedRows(uid)).length, 1);

  const reimport = await importShow(uid, [act('S1E1', true, '2026-09-01T00:00:00Z')]);
  assert.deepEqual(watchedKeys(reimport.body), ['S1E2'], 'an import dated before the unmark (now) cannot bring it back');
});

test('marking in the app behaves as before: original date kept, row kept when emptied', async () => {
  const uid = newUser();
  const first = await api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, {
    episodeKeys: ['S1E1', 'S1E2'], watched: true, currentSeason: 1, currentEpisode: 2, totalEpisodes: 8,
  });
  assert.equal(first.status, 200);
  const firstDate = first.body.watchedEpisodeDates.S1E1;
  assert.ok(firstDate);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = await api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, {
    episodeKeys: ['S1E1'], watched: true, currentSeason: 1, currentEpisode: 1,
  });
  assert.equal(again.body.watchedEpisodeDates.S1E1, firstDate, 're-marking keeps the original date');

  await api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, { episodeKeys: ['S1E1', 'S1E2'], watched: false, currentSeason: 1, currentEpisode: 1 });
  const emptied = await progress(uid);
  assert.equal(emptied.status, 200, 'unmarking everything keeps the row, as it always did');
  assert.deepEqual(emptied.body.watchedEpisodes, []);
  assert.equal(emptied.body.lastWatched, null);

  const remarked = await api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, { episodeKeys: ['S1E1'], watched: true, currentSeason: 1, currentEpisode: 1 });
  assert.deepEqual(watchedKeys(remarked.body), ['S1E1']);
  assert.deepEqual((await unwatchedRows(uid)).map((r) => r.episode_key), ['S1E2'], 'marking clears S1E1\'s memory');
});

test('deleting a show\'s history forgets its unwatches, so an import can restore it', async () => {
  const uid = newUser();
  await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E1', false, '2026-08-01T00:00:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')]);
  assert.equal((await unwatchedRows(uid)).length, 1);
  const del = await api(uid, 'DELETE', `/me/progress/${SHOW}`);
  assert.equal(del.status, 204);
  assert.equal((await progress(uid)).status, 404);
  assert.deepEqual(await unwatchedRows(uid), []);
  const restored = await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  assert.deepEqual(watchedKeys(restored.body), ['S1E1']);
});

test('repeating the same import changes nothing', async () => {
  const uid = newUser();
  const actions = [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E2', false, '2026-07-01T00:00:00Z'), act('S1E3', true, '2026-07-02T00:00:00Z')];
  const first = await importShow(uid, actions, { totalEpisodes: 6 });
  const second = await importShow(uid, actions, { totalEpisodes: 6 });
  const strip = ({ classification, classificationCheckedAt, ...rest }) => rest;
  assert.deepEqual(strip(second.body), strip(first.body));
  assert.equal((await unwatchedRows(uid)).length, 1);
});

test('simultaneous imports for one show are applied one after another, none lost', async () => {
  const uid = newUser();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => importShow(uid, [act(`S1E${i + 1}`, true, `2026-07-0${(i % 8) + 1}T00:00:00Z`)])),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(
    watchedKeys((await progress(uid)).body),
    Array.from({ length: 8 }, (_, i) => `S1E${i + 1}`).sort(),
  );
});

test('an import and an app tap running at the same time do not overwrite each other', async () => {
  const uid = newUser();
  await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  const [a, b] = await Promise.all([
    importShow(uid, [act('S1E2', true, '2026-07-01T00:00:00Z')]),
    api(uid, 'PATCH', `/me/progress/${SHOW}/episodes`, { episodeKeys: ['S1E3'], watched: true, currentSeason: 1, currentEpisode: 3 }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(watchedKeys((await progress(uid)).body), ['S1E1', 'S1E2', 'S1E3']);
});

test('the show-level summary date only counts when there are watched episodes', async () => {
  const uid = newUser();
  const withEpisodes = await importShow(
    uid, [act('S1E1', true, '2026-06-30T16:18:00Z')],
    { summary: { plays: 3, lastWatched: '2026-09-15T12:00:00Z' } },
  );
  assert.equal(new Date(withEpisodes.body.lastWatched).toISOString(), '2026-09-15T12:00:00.000Z');

  const none = newUser();
  const summaryOnly = await importShow(none, [], { summary: { plays: 3, lastWatched: '2026-09-15T12:00:00Z' } });
  assert.equal(summaryOnly.status, 204, 'no episodes, no row: "not started" stays the rule');
  assert.equal((await progress(none)).status, 404);
});

test('invalid imports are rejected with 400, not a server error', async () => {
  const uid = newUser();
  const bad = [
    { actions: 'nope' },
    { actions: [{ key: 'bad', watched: true, at: '2026-06-30T00:00:00Z' }] },
    { actions: [{ key: 'S1E1', watched: 'yes', at: '2026-06-30T00:00:00Z' }] },
    { actions: [{ key: 'S1E1', watched: true, at: 'yesterday-ish' }] },
    { actions: [{ key: 'S1E1', watched: true }] },
    { actions: [], totalEpisodes: -1 },
    { actions: Array.from({ length: 5001 }, () => act('S1E1', true, '2026-06-30T00:00:00Z')) },
    { actions: [], summary: { plays: 'x', lastWatched: null } },
  ];
  for (const body of bad) {
    const res = await api(uid, 'POST', `/me/progress/${SHOW}/import`, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await api(uid, 'POST', '/me/progress/abc/import', { actions: [] })).status, 400);
  assert.equal((await api(uid, 'POST', `/me/progress/${SHOW}/import`)).status, 400, 'no body');
});

test('one user\'s memory never leaks into another\'s', async () => {
  const a = newUser();
  const b = newUser();
  await importShow(a, [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E1', false, '2026-08-01T00:00:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')]);
  const other = await importShow(b, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  assert.deepEqual(watchedKeys(other.body), ['S1E1'], 'B has no unwatch for S1E1');
});

test('the old whole-row PUT still works and is unaffected by remembered unwatches', async () => {
  const uid = newUser();
  await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E1', false, '2026-08-01T00:00:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')]);
  const put = await api(uid, 'PUT', `/me/progress/${SHOW}`, {
    currentSeason: 1, currentEpisode: 2, watchedEpisodes: ['S1E2', 'S1E3'],
    watchedEpisodeDates: { S1E2: '2026-06-30T16:18:00.000Z', S1E3: '2026-09-01T00:00:00.000Z' },
    watchedCount: 2, totalEpisodes: 5, lastWatched: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(put.status, 200);
  assert.deepEqual(watchedKeys(put.body), ['S1E2', 'S1E3']);
  assert.equal((await unwatchedRows(uid)).length, 1, 'PUT leaves the memory alone');
});

test('whether an episode has aired follows each user calendar date, and that date is stored with the result', async () => {
  // Kiritimati (UTC+14) and Pago Pago (UTC-11) are 25 hours apart, so the
  // first is always on a later calendar date than the second.
  const early = 'Pacific/Kiritimati';
  const late = 'Pacific/Pago_Pago';
  const todayEarly = localDateString(early);
  const todayLate = localDateString(late);
  assert.notEqual(todayEarly, todayLate);

  tmdbState.seasons = [{ season_number: 1 }];
  tmdbState.episodes = [
    { episode_number: 1, air_date: '2000-01-01' },
    { episode_number: 2, air_date: todayEarly }, // today for one user, tomorrow for the other
  ];
  const results = {};
  for (const [label, zone] of [['early', early], ['late', late]]) {
    const uid = newUser();
    assert.equal((await api(uid, 'PATCH', '/me', { timezone: zone })).body.timezone, zone);
    await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
    const refreshed = await api(uid, 'POST', '/me/refresh-classifications', {});
    assert.equal(refreshed.status, 200);
    const row = (await progress(uid)).body;
    const stored = (await pool.query(
      'SELECT classification_date FROM show_progress WHERE firebase_uid=$1 AND series_id=$2', [uid, SHOW],
    )).rows[0];
    results[label] = { row, stored };
  }

  // Watched only S1E1. Early-zone user: S1E2 has aired (today there), so they
  // are behind. Late-zone user: S1E2 has not aired yet, so they are caught up.
  assert.equal(results.early.row.releasedEpisodeCount, 2);
  assert.equal(results.early.row.classification, 'watching');
  assert.equal(results.late.row.releasedEpisodeCount, 1);
  assert.equal(results.late.row.classification, 'upToDate');
  assert.equal(results.early.stored.classification_date, todayEarly);
  assert.equal(results.late.stored.classification_date, todayLate);
});

test('a classification from an earlier local day is stale and recomputed', async () => {
  tmdbState.seasons = [{ season_number: 1 }];
  tmdbState.episodes = [{ episode_number: 1, air_date: '2000-01-01' }];
  const uid = newUser();
  await importShow(uid, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  await api(uid, 'POST', '/me/refresh-classifications', {});
  // Pretend that result was computed yesterday, a moment ago.
  await pool.query(
    `UPDATE show_progress SET classification='watching', classification_date='2000-01-01',
       classification_checked_at=NOW() WHERE firebase_uid=$1 AND series_id=$2`, [uid, SHOW],
  );
  const res = await api(uid, 'POST', '/me/refresh-classifications', {});
  assert.equal(res.body.refreshed, 1, 'recent but from another day: recomputed');
  assert.equal((await progress(uid)).body.classification, 'upToDate');
  const again = await api(uid, 'POST', '/me/refresh-classifications', {});
  assert.equal(again.body.refreshed, 0, 'now fresh for today: left alone');
});
