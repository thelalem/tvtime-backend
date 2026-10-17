// Deleting an account (account-deletion.js) against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is
// set; see progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('account deletion integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

// Tokens are "<uid>" (signed in just now) or "old:<uid>" (signed in an hour ago). A uid in `gone` is an
// account Firebase no longer has.
const gone = new Set();
const firebaseStub = {
  admin: {
    auth: () => ({
      verifyIdToken: async (token, checkRevoked) => {
        const old = token.startsWith('old:');
        const uid = old ? token.slice(4) : token;
        if (checkRevoked && gone.has(uid)) {
          const error = new Error('no user');
          error.code = 'auth/user-not-found';
          throw error;
        }
        return { uid, email: `${uid}@example.test`, auth_time: Math.floor(Date.now() / 1000) - (old ? 3600 : 5) };
      },
    }),
  },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (request === './firebase' && parent && parent.filename && /src[\\/]/.test(parent.filename)) return firebaseStub;
  return originalLoad.call(this, request, parent, ...rest);
};

const express = require('express');
const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { router } = require('../src/user-data');
const { deleteDueAccounts } = require('../src/account-deletion');

const users = [];
let server;
let base;

function newUser() {
  const uid = `it-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  users.push(uid);
  return uid;
}

async function api(token, method, route, body) {
  const response = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test.before(async () => {
  await initializeDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  app.use((error, _request, response, _next) => response.status(500).json({ detail: error.message }));
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (users.length) await pool.query('DELETE FROM app_users WHERE firebase_uid = ANY($1)', [users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('a request needs a recent sign-in, locks the account, drops its push tokens; cancel unlocks', async () => {
  const uid = newUser();
  assert.equal((await api(uid, 'PUT', '/me/devices', { token: `device-token-${uid}`, platform: 'android' })).status, 200);

  const stale = await api(`old:${uid}`, 'POST', '/me/account/delete-request');
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error, 'recent_sign_in_required');

  const asked = await api(uid, 'POST', '/me/account/delete-request');
  assert.equal(asked.status, 200);
  const days = (Date.parse(asked.body.deleteAfter) - Date.parse(asked.body.deletionRequestedAt)) / 86400000;
  assert.equal(Math.round(days), 30);
  const tokens = await pool.query('SELECT 1 FROM device_tokens WHERE firebase_uid = $1', [uid]);
  assert.equal(tokens.rowCount, 0, 'no pushes while the deletion is pending');

  const again = await api(uid, 'POST', '/me/account/delete-request');
  assert.equal(again.body.deletionRequestedAt, asked.body.deletionRequestedAt, 'asking twice keeps the first date');

  const locked = await api(`old:${uid}`, 'GET', '/me/watchlist');
  assert.equal(locked.status, 403, 'another phone still signed in is locked out');
  assert.equal(locked.body.error, 'account_pending_deletion');
  const me = await api(`old:${uid}`, 'GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.deleteAfter, asked.body.deleteAfter);

  assert.equal((await api(`old:${uid}`, 'POST', '/me/account/cancel-deletion')).status, 200);
  assert.equal((await api(`old:${uid}`, 'GET', '/me/watchlist')).status, 200);
  assert.equal((await api(uid, 'GET', '/me')).body.deletionRequestedAt, null);
});

test('after 30 days the daily job deletes the sign-in, then the data; not before, and not when Firebase fails', async () => {
  const due = newUser();
  const notYet = newUser();
  const firebaseDown = newUser();
  const alreadyGone = newUser();
  for (const uid of [due, notYet, firebaseDown, alreadyGone]) {
    await api(uid, 'PUT', '/me/watchlist/77', { id: 77, name: 'Show', posterPath: null });
  }
  await pool.query(
    `UPDATE app_users SET deletion_requested_at = NOW() - INTERVAL '31 days' WHERE firebase_uid = ANY($1)`,
    [[due, firebaseDown, alreadyGone]],
  );
  await pool.query(`UPDATE app_users SET deletion_requested_at = NOW() - INTERVAL '29 days' WHERE firebase_uid = $1`, [notYet]);

  const deletedSignIns = [];
  const auth = {
    deleteUser: async (uid) => {
      if (uid === firebaseDown) throw Object.assign(new Error('unavailable'), { code: 'app/network-error' });
      if (uid === alreadyGone) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
      deletedSignIns.push(uid);
    },
  };
  await deleteDueAccounts({ auth });

  const left = await pool.query('SELECT firebase_uid FROM app_users WHERE firebase_uid = ANY($1)', [[due, notYet, firebaseDown, alreadyGone]]);
  assert.deepEqual(left.rows.map((row) => row.firebase_uid).sort(), [firebaseDown, notYet].sort());
  assert.ok(deletedSignIns.includes(due));
  const watchlist = await pool.query('SELECT 1 FROM watchlist WHERE firebase_uid = $1', [due]);
  assert.equal(watchlist.rowCount, 0, 'everything of the account went with it');
});

test('a phone of an account Firebase no longer has is refused, not given a fresh empty account', async () => {
  const uid = newUser();
  gone.add(uid);
  const answer = await api(uid, 'GET', '/me');
  assert.equal(answer.status, 401);
  const row = await pool.query('SELECT 1 FROM app_users WHERE firebase_uid = $1', [uid]);
  assert.equal(row.rowCount, 0);
});
