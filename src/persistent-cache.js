const { pool } = require('./db');

// Provider answers that rarely change (IMDb ratings, TMDB-to-IMDb id mappings)
// are kept in PostgreSQL, so a restart or redeploy does not send every show back
// to OMDb, whose free tier allows only a few hundred calls a day. The in-memory
// provider cache sits in front of this one for repeat reads inside a process.
//
// A database problem never fails the request: it just means asking the provider.
//
// `emptyTtlMs`: how long an empty answer lasts (null, or no ratings at all).
// "Nothing found" often means "not yet": a new show gets its IMDb id days after
// it appears, and kept for the full 90 days it showed TMDB's rating for months.
async function readThrough(key, ttlMs, load, { emptyTtlMs = ttlMs } = {}) {
  try {
    const { rows } = await pool.query(
      `SELECT data FROM provider_cache
       WHERE key = $1 AND fetched_at > NOW() - ((CASE
         WHEN data = 'null'::jsonb OR data->'ratings' = '{}'::jsonb THEN $3::bigint
         ELSE $2::bigint END) * INTERVAL '1 millisecond')`,
      [key, ttlMs, emptyTtlMs],
    );
    if (rows.length) return rows[0].data;
  } catch (error) {
    console.error(`[provider-cache] read failed for ${key}: ${error.message}`);
  }

  const value = await load();

  try {
    await pool.query(
      `INSERT INTO provider_cache(key, data, fetched_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, fetched_at = NOW()`,
      [key, JSON.stringify(value === undefined ? null : value)],
    );
  } catch (error) {
    console.error(`[provider-cache] write failed for ${key}: ${error.message}`);
  }
  return value;
}

module.exports = { readThrough };
