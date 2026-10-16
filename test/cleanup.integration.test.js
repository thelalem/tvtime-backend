// The daily clean-up (cleanup.js) against a real PostgreSQL. Skipped unless
// TEST_DATABASE_URL is set; see progress-endpoints.integration.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('clean-up integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { cleanUpOldRows } = require('../src/cleanup');

const uid = `it-cleanup-${Date.now()}`;
const keys = [`it-cleanup-old-${uid}`, `it-cleanup-new-${uid}`];

test.before(async () => {
  await initializeDatabase();
  await pool.query('INSERT INTO app_users(firebase_uid) VALUES ($1)', [uid]);
});

test.after(async () => {
  await pool.query('DELETE FROM provider_cache WHERE key = ANY($1)', [keys]);
  await pool.query('DELETE FROM app_users WHERE firebase_uid=$1', [uid]);
  await pool.end();
});

test('rows past their longest life go; recent ones stay', async () => {
  await pool.query(
    `INSERT INTO provider_cache(key, data, fetched_at) VALUES
       ($1, '"old"', NOW() - INTERVAL '100 days'), ($2, '"new"', NOW() - INTERVAL '80 days')`,
    keys,
  );
  await pool.query(
    `INSERT INTO notifications_sent(firebase_uid, series_id, season, episode, sent_at) VALUES
       ($1, 1, 1, 1, NOW() - INTERVAL '40 days'), ($1, 1, 1, 2, NOW() - INTERVAL '2 days')`,
    [uid],
  );

  await cleanUpOldRows();

  const cache = await pool.query('SELECT key FROM provider_cache WHERE key = ANY($1)', [keys]);
  assert.deepEqual(cache.rows.map((row) => row.key), [keys[1]]);
  const sent = await pool.query('SELECT episode FROM notifications_sent WHERE firebase_uid=$1', [uid]);
  assert.deepEqual(sent.rows.map((row) => row.episode), [2]);
});
