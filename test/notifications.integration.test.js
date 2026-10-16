// Device tokens, notification settings and the sweep (notifications.js) against a real
// PostgreSQL, with a fake FCM sender and a fake upcoming list. Skipped unless TEST_DATABASE_URL
// is set; see progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('notification integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
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
const { runNotificationSweep } = require('../src/notifications');

const users = [];
let server;
let base;

function newUser() {
  const uid = `it-notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

const tokenFor = (uid) => `${uid}-token-`.padEnd(40, 'x');

// An Upcoming item for [seriesId] airing on [airDate].
const item = (seriesId, name, season, episode, airDate) => ({
  seriesId,
  posterPath: `/${seriesId}.jpg`,
  seriesName: name,
  episode: { seasonNumber: season, episodeNumber: episode, airDate },
});

// 12:00 UTC is 15:00 in Addis Ababa and 08:00 in New York: after and before the 09:00 mark.
const noonUtc = new Date('2026-10-16T12:00:00Z');

function sweep(uid, upcoming, send, now = noonUtc) {
  // Only this test's user is swept: other rows in a shared database must not be touched.
  const db = {
    query: (sql, params) => (sql.includes('FROM app_users u')
      ? pool.query(`${sql} AND u.firebase_uid = $1`, [uid])
      : pool.query(sql, params)),
  };
  return runNotificationSweep({ db, getUpcoming: async () => upcoming, send, now });
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

async function setup(uid, timezone = 'Africa/Addis_Ababa') {
  assert.equal((await api(uid, 'PUT', '/me/devices', { token: tokenFor(uid), platform: 'android' })).status, 200);
  await api(uid, 'PATCH', '/me', { timezone });
}

test('device tokens: validated, upserted, moved to the new user, deleted on sign-out', async () => {
  const a = newUser();
  const b = newUser();
  assert.equal((await api(a, 'PUT', '/me/devices', { token: 'short' })).status, 400);
  await setup(a);
  await setup(a); // idempotent
  const token = tokenFor(a);
  let rows = (await pool.query('SELECT firebase_uid FROM device_tokens WHERE token=$1', [token])).rows;
  assert.deepEqual(rows.map((r) => r.firebase_uid), [a]);

  // Another account signs in on the same phone.
  await api(b, 'PUT', '/me/devices', { token });
  rows = (await pool.query('SELECT firebase_uid FROM device_tokens WHERE token=$1', [token])).rows;
  assert.deepEqual(rows.map((r) => r.firebase_uid), [b]);

  // Only the owner can delete it.
  await api(a, 'DELETE', '/me/devices', { token });
  assert.equal((await pool.query('SELECT 1 FROM device_tokens WHERE token=$1', [token])).rowCount, 1);
  await api(b, 'DELETE', '/me/devices', { token });
  assert.equal((await pool.query('SELECT 1 FROM device_tokens WHERE token=$1', [token])).rowCount, 0);
});

test('settings: on by default, master switch and per-show mute round-trip', async () => {
  const uid = newUser();
  assert.deepEqual((await api(uid, 'GET', '/me/notification-settings')).body, { enabled: true, mutedShows: [], muted: [] });
  assert.equal((await api(uid, 'PATCH', '/me/notification-settings', { enabled: 'no' })).status, 400);
  await api(uid, 'PATCH', '/me/notification-settings', { enabled: false });
  await api(uid, 'PUT', '/me/notification-settings/muted/7', { name: 'Seven', posterPath: '/7.jpg' });
  await api(uid, 'PUT', '/me/notification-settings/muted/7'); // muting again keeps the name
  await api(uid, 'PUT', '/me/notification-settings/muted/3');
  assert.deepEqual((await api(uid, 'GET', '/me/notification-settings')).body, {
    enabled: false,
    mutedShows: [3, 7],
    muted: [{ id: 3, name: null, posterPath: null }, { id: 7, name: 'Seven', posterPath: '/7.jpg' }],
  });
  await api(uid, 'DELETE', '/me/notification-settings/muted/3');
  assert.deepEqual((await api(uid, 'GET', '/me/notification-settings')).body.mutedShows, [7]);
});

test('sweep: sends today\'s episode once, with the show name and S03 | E01', async () => {
  const uid = newUser();
  await setup(uid);
  const calls = [];
  const send = async (tokens, message) => { calls.push({ tokens, message }); return []; };
  const upcoming = [
    item(100, 'Severance', 3, 1, '2026-10-16'),
    item(101, 'Tomorrow Show', 1, 1, '2026-10-17'),
  ];

  assert.equal(await sweep(uid, upcoming, send), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tokens, [tokenFor(uid)]);
  assert.equal(calls[0].message.title, 'Severance');
  assert.equal(calls[0].message.body, 'S03 | E01');
  assert.equal(calls[0].message.imageUrl, 'https://image.tmdb.org/t/p/w342/100.jpg');
  assert.deepEqual(calls[0].message.data, { type: 'new_episode', seriesId: '100', season: '3', episode: '1' });

  assert.equal(await sweep(uid, upcoming, send), 0, 'a second sweep does not repeat it');
  assert.equal(calls.length, 1);
});

test('sweep: waits for 09:00 local, then sends', async () => {
  const uid = newUser();
  await setup(uid, 'America/New_York');
  const calls = [];
  const send = async (tokens, message) => { calls.push(message); return []; };
  const upcoming = [item(200, 'Early', 1, 2, '2026-10-16')];

  assert.equal(await sweep(uid, upcoming, send, noonUtc), 0, '08:00 in New York is too early');
  assert.equal(await sweep(uid, upcoming, send, new Date('2026-10-16T13:30:00Z')), 1);
});

test('sweep: skips muted shows, watched episodes and users with notifications off', async () => {
  const uid = newUser();
  await setup(uid);
  await api(uid, 'PUT', '/me/notification-settings/muted/300');
  await api(uid, 'PUT', '/me/watchlist/301', { id: 301, name: 'Seen', posterPath: null });
  await api(uid, 'POST', '/me/progress/301/import', {
    actions: [{ key: 'S1E1', watched: true, at: '2026-10-01T10:00:00Z' }],
    totalEpisodes: 10,
    showName: 'Seen',
  });
  const calls = [];
  const send = async (tokens, message) => { calls.push(message.title); return []; };
  const upcoming = [
    item(300, 'Muted', 1, 1, '2026-10-16'),
    item(301, 'Seen', 1, 1, '2026-10-16'),
    item(302, 'Fresh', 1, 1, '2026-10-16'),
  ];
  assert.equal(await sweep(uid, upcoming, send), 1);
  assert.deepEqual(calls, ['Fresh']);

  await api(uid, 'PATCH', '/me/notification-settings', { enabled: false });
  assert.equal(await sweep(uid, [item(303, 'Off', 1, 1, '2026-10-16')], send), 0);
});

test('sweep: a failed send is retried next time; dead tokens are removed', async () => {
  const uid = newUser();
  await setup(uid);
  const upcoming = [item(400, 'Retry', 2, 5, '2026-10-16')];

  const failing = async () => { throw new Error('FCM down'); };
  assert.equal(await sweep(uid, upcoming, failing), 0);
  const ok = async () => [];
  assert.equal(await sweep(uid, upcoming, ok), 1, 'sent on the next sweep');

  const dead = async (tokens) => tokens;
  assert.equal(await sweep(uid, [item(401, 'Dead', 1, 1, '2026-10-16')], dead), 1);
  assert.equal((await pool.query('SELECT 1 FROM device_tokens WHERE firebase_uid=$1', [uid])).rowCount, 0);
});

test('sweep: a show with an air time and zone goes out at that moment, silently at night', async () => {
  const uid = newUser();
  await setup(uid); // Addis Ababa, UTC+3
  const calls = [];
  const send = async (tokens, message) => { calls.push(message); return []; };
  // 20:30 in New York on 16 Oct is 00:30 UTC on the 17th, 03:30 in Addis Ababa.
  const upcoming = [{ ...item(500, 'Network Show', 1, 4, '2026-10-16'), airTime: '20:30', timezone: 'America/New_York' }];

  assert.equal(await sweep(uid, upcoming, send, new Date('2026-10-17T00:20:00Z')), 0, 'not yet');
  assert.equal(await sweep(uid, upcoming, send, new Date('2026-10-17T00:40:00Z')), 1);
  assert.equal(calls[0].silent, true, '03:40 local is silent');
});

test('sweep: daytime pushes make sound; an episode older than a day is not announced', async () => {
  const uid = newUser();
  await setup(uid);
  const calls = [];
  const send = async (tokens, message) => { calls.push(message); return []; };

  assert.equal(await sweep(uid, [item(600, 'Daytime', 1, 1, '2026-10-16')], send), 1);
  assert.equal(calls[0].silent, false);

  const old = [item(601, 'Old', 1, 1, '2026-10-14')];
  assert.equal(await sweep(uid, old, send), 0);
});
