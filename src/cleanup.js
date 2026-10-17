const { pool } = require('./db');

// Rows that only ever accumulated. Each is deleted once it is past the longest
// time anything still reads it:
// - provider_cache: the longest cache life is 90 days (TMDB-to-IMDb ids);
// - notifications_sent: the sweep looks back a day, so a month is plenty to
//   stop an episode being announced twice;
// - omdb_usage, ai_usage: one row a day, only today's is read.
async function cleanUpOldRows(db = pool) {
  const provider = await db.query(
    "DELETE FROM provider_cache WHERE fetched_at < NOW() - INTERVAL '91 days'",
  );
  const sent = await db.query(
    "DELETE FROM notifications_sent WHERE sent_at < NOW() - INTERVAL '30 days'",
  );
  const usage = await db.query('DELETE FROM omdb_usage WHERE day < CURRENT_DATE - 30');
  await db.query('DELETE FROM ai_usage WHERE day < CURRENT_DATE - 30');
  return {
    providerCache: provider.rowCount,
    notificationsSent: sent.rowCount,
    omdbUsage: usage.rowCount,
  };
}

function startDailyCleanUp() {
  const run = () => cleanUpOldRows()
    .then((removed) => console.log(`[cleanup] removed ${JSON.stringify(removed)}`))
    .catch((error) => console.error(`[cleanup] failed: ${error.message}`));
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

module.exports = { cleanUpOldRows, startDailyCleanUp };
