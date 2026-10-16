const { pool } = require('./db');

// OMDb's key allows a fixed number of calls a day, and an uncached list page of
// 20 shows spends about 20 of them. Load-testing the public lists once used the
// whole day's quota (Oct 2026), after which episode ratings failed and every
// rating fell back to TMDB until the reset. Counting the calls here lets the
// lists spend only their share, so show pages and episode ratings keep the rest.
//
// The count is kept in PostgreSQL rather than in memory: every push redeploys
// the server, and a fresh count after each one would let a day spend far more.
// Days are UTC days.

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Takes one call from today's count. Answers false, without counting it, when
// `limit` calls have already been made today.
async function takeOmdbCall(limit) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO omdb_usage(day, calls) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET calls = omdb_usage.calls + 1
       WHERE omdb_usage.calls < $2
       RETURNING calls`,
      [utcDay(), limit],
    );
    return rows.length > 0;
  } catch (error) {
    // A safeguard, not a gate: a database hiccup must not stop the ratings.
    console.error(`[omdb] could not count a call: ${error.message}`);
    return true;
  }
}

module.exports = { takeOmdbCall, utcDay };
