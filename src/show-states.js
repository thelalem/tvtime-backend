// "Stop watching" and "Remove" for a show (see FEATURE_PLAN.md section 8).
//
// Both take the show off the watchlist and leave its progress (show_progress, watched dates)
// untouched, so putting it back restores everything:
//   - stopped: listed at the end of All Shows ("Stopped watching"), but not on the watchlist,
//     in Upcoming or as a recommendation seed. "Continue watching" puts it back.
//   - removed: gone from every list of shows, as if never added. Adding it again (from search,
//     or by ticking an episode, which adds it) brings it back with its progress.
// Kept in a table of its own rather than a column on show_progress: a show that was never
// started has no progress row, and the state has to outlive the watchlist row it replaces.
const { pool } = require('./db');
const { invalidateRecommendations } = require('./recommendations');

const STATES = new Set(['stopped', 'removed']);

// Upper bound for the stored show document, as for watchlist entries.
const maxSeriesDocumentChars = 32 * 1024;

// { stopped: Map<id, { series, changedAt }>, removed: Set<id> } for one user.
async function loadShowStates(db, uid) {
  const { rows } = await db.query(
    `SELECT series_id, state, series, changed_at FROM show_states WHERE firebase_uid=$1`,
    [uid],
  );
  const stopped = new Map();
  const removed = new Set();
  for (const row of rows) {
    const id = Number(row.series_id);
    if (row.state === 'stopped') stopped.set(id, { series: row.series, changedAt: row.changed_at });
    else if (row.state === 'removed') removed.add(id);
  }
  return { stopped, removed };
}

// Ids that are stopped or removed: left out of Upcoming and the recommendation seeds.
async function inactiveSeriesIds(db, uid) {
  const { rows } = await db.query('SELECT series_id FROM show_states WHERE firebase_uid=$1', [uid]);
  return new Set(rows.map((row) => Number(row.series_id)));
}

// Called when a show is (re)added to the watchlist: whatever it was, it is active again.
async function clearShowState(db, uid, seriesId) {
  await db.query('DELETE FROM show_states WHERE firebase_uid=$1 AND series_id=$2', [uid, seriesId]);
}

function parseSeriesId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function registerShowStateRoutes(router) {
  // Every stopped and removed show id, so the app's add/check buttons do not count them as
  // tracked just because they have progress. Registered before `/me/:collection`.
  router.get('/me/show-states', async (request, response, next) => {
    try {
      const { stopped, removed } = await loadShowStates(pool, request.user.uid);
      response.json({ stopped: [...stopped.keys()], removed: [...removed] });
    } catch (error) { next(error); }
  });

  // What the show details page's menu needs: on the watchlist, stopped, removed, or none of these.
  router.get('/me/shows/:seriesId/state', async (request, response, next) => {
    const seriesId = parseSeriesId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    try {
      const uid = request.user.uid;
      const [state, watchlist] = await Promise.all([
        pool.query('SELECT state FROM show_states WHERE firebase_uid=$1 AND series_id=$2', [uid, seriesId]),
        pool.query('SELECT 1 FROM watchlist WHERE firebase_uid=$1 AND series_id=$2', [uid, seriesId]),
      ]);
      const stored = state.rows[0]?.state;
      response.json({ state: stored || (watchlist.rowCount ? 'watchlist' : 'none') });
    } catch (error) { next(error); }
  });

  // Stop watching, or remove. The body is the show (id, name, posterPath...), kept so a stopped
  // show can still be drawn in All Shows without a watchlist row.
  router.put('/me/shows/:seriesId/:state', async (request, response, next) => {
    const seriesId = parseSeriesId(request.params.seriesId);
    const state = request.params.state;
    if (!STATES.has(state)) return response.status(404).json({ error: 'not_found' });
    const body = request.body || {};
    if (!seriesId || Number(body.id) !== seriesId) {
      return response.status(400).json({ error: 'invalid_series' });
    }
    if (JSON.stringify(body).length > maxSeriesDocumentChars) {
      return response.status(413).json({ error: 'series_too_large' });
    }
    const uid = request.user.uid;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Prefer the watchlist's copy of the show, which is the one the app has been drawing.
      const { rows } = await client.query(
        'DELETE FROM watchlist WHERE firebase_uid=$1 AND series_id=$2 RETURNING series',
        [uid, seriesId],
      );
      const series = { ...body, ...(rows[0]?.series || {}), id: seriesId };
      await client.query(
        `INSERT INTO show_states(firebase_uid, series_id, state, series) VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT(firebase_uid, series_id) DO UPDATE
         SET state=EXCLUDED.state, series=EXCLUDED.series, changed_at=NOW()`,
        [uid, seriesId, state, JSON.stringify(series)],
      );
      await client.query('COMMIT');
      invalidateRecommendations(uid);
      response.json({ state });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  });

  // Continue watching: the stopped show goes back on the watchlist, as it was.
  router.delete('/me/shows/:seriesId/stopped', async (request, response, next) => {
    const seriesId = parseSeriesId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    const uid = request.user.uid;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `DELETE FROM show_states WHERE firebase_uid=$1 AND series_id=$2 AND state='stopped'
         RETURNING series`,
        [uid, seriesId],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return response.status(404).json({ error: 'not_stopped' });
      }
      const inserted = await client.query(
        `INSERT INTO watchlist(firebase_uid, series_id, series) VALUES ($1,$2,$3::jsonb)
         ON CONFLICT(firebase_uid, series_id) DO UPDATE SET series=watchlist.series || EXCLUDED.series
         RETURNING series AS data, added_at AS "addedAt"`,
        [uid, seriesId, JSON.stringify({ ...rows[0].series, id: seriesId })],
      );
      await client.query('COMMIT');
      invalidateRecommendations(uid);
      response.json({ ...inserted.rows[0].data, addedAt: inserted.rows[0].addedAt });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  });
}

module.exports = { clearShowState, inactiveSeriesIds, loadShowStates, registerShowStateRoutes };
