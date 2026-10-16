// Rewatches and rewatch passes (FEATURE_PLAN.md section 14). The rules live in rewatch-logic.js; this file
// is the routes and the database around them.
//
// Every route answers with the show's progress row (which now carries `rewatches`, `rewatchCount` and
// `rewatchPasses`, see progress-columns.js) as `{ progress }`, plus what the action did:
//   completedSeasons  seasons whose pass finished because of it
//   removed / added   how many rewatches were taken off / put on
//
// Writes take the same per-show advisory lock as the other progress writes, so two quick taps (or two
// devices) apply one after the other and cannot lose each other.
const { pool } = require('./db');
const { PROGRESS_COLUMNS } = require('./progress-columns');
const {
  EPISODE_KEY, addRewatch, cleanRewatches, levelOf, passFor, pendingKeys, reconcilePasses,
  removeLastFromSeason, removeLatest, removePassRewatches, seasonOf, startPass,
} = require('./rewatch-logic');

const DAY_MS = 24 * 60 * 60 * 1000;

class RewatchError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseSeason(value) {
  const season = Number.parseInt(value, 10);
  return Number.isSafeInteger(season) && season > 0 && season < 10000 && String(season) === String(value)
    ? season : null;
}

// The moment of a rewatch: now, or a day the user chose (a real date, not more than a day ahead).
function parseAt(value, nowMs) {
  if (value === undefined || value === null) return new Date(nowMs).toISOString();
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms > nowMs + DAY_MS) throw new RewatchError(400, 'invalid_at');
  return new Date(ms).toISOString();
}

async function loadState(db, uid, seriesId) {
  const { rows } = await db.query(
    `SELECT watched_episodes, rewatches, last_watched
     FROM show_progress WHERE firebase_uid=$1 AND series_id=$2 FOR UPDATE`,
    [uid, seriesId],
  );
  if (!rows[0]) throw new RewatchError(404, 'not_tracked');
  const { rows: passRows } = await db.query(
    `SELECT season, target_level, started_at, episodes
     FROM rewatch_passes WHERE firebase_uid=$1 AND series_id=$2 ORDER BY season`,
    [uid, seriesId],
  );
  const watched = new Set(Array.isArray(rows[0].watched_episodes) ? rows[0].watched_episodes.map(String) : []);
  return {
    watched,
    rewatches: cleanRewatches(rows[0].rewatches || {}, watched),
    lastWatched: rows[0].last_watched,
    passes: passRows.map((row) => ({
      season: row.season,
      target: row.target_level,
      startedAt: row.started_at.getTime(),
      episodes: Array.isArray(row.episodes) ? row.episodes.map(String) : [],
    })),
  };
}

// Writes the rewatches back, ends the passes that are over, and answers with the row.
// [touch]: a rewatch was added, so the show counts as recently watched.
async function save(db, uid, seriesId, state, rewatches, { touchAtMs } = {}) {
  const { open, finished } = reconcilePasses(state.passes, state.watched, rewatches);
  const openSeasons = new Set(open.map((pass) => pass.season));
  for (const pass of state.passes) {
    if (!openSeasons.has(pass.season)) {
      await db.query(
        'DELETE FROM rewatch_passes WHERE firebase_uid=$1 AND series_id=$2 AND season=$3',
        [uid, seriesId, pass.season],
      );
    }
  }
  const previousLast = state.lastWatched ? new Date(state.lastWatched).getTime() : null;
  const lastWatched = touchAtMs !== undefined && (previousLast === null || touchAtMs > previousLast)
    ? new Date(touchAtMs) : state.lastWatched;
  await db.query(
    `UPDATE show_progress SET rewatches=$3::jsonb, last_watched=$4, updated_at=NOW()
     WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId, JSON.stringify(rewatches), lastWatched],
  );
  const { rows } = await db.query(
    `SELECT ${PROGRESS_COLUMNS} FROM show_progress WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId],
  );
  return { progress: rows[0], completedSeasons: finished };
}

// Runs [work] inside a transaction under the show's lock, and answers with what it returns.
async function inShowLock(request, response, next, seriesId, work) {
  const db = await pool.connect().catch((error) => { next(error); return null; });
  if (!db) return;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${request.user.uid}:${seriesId}`]);
    const state = await loadState(db, request.user.uid, seriesId);
    const result = await work(db, state);
    await db.query('COMMIT');
    response.status(result.status || 200).json(result.body);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (error instanceof RewatchError) return response.status(error.status).json({ error: error.code });
    next(error);
  } finally {
    db.release();
  }
}

function registerRewatchRoutes(router) {
  const base = '/me/progress/:seriesId/rewatch';
  const withIds = (handler) => (request, response, next) => {
    const seriesId = parseId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    return handler(request, response, next, seriesId);
  };

  // Begins a pass over a season: `{ season }`. 409 when that season already has one.
  router.post(`${base}/passes`, withIds((request, response, next, seriesId) => {
    const season = parseSeason(request.body?.season);
    if (!season) return response.status(400).json({ error: 'invalid_season' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      if (state.passes.some((pass) => pass.season === season)) throw new RewatchError(409, 'pass_open');
      const nowMs = Date.now();
      const pass = startPass(state.watched, state.rewatches, season, nowMs);
      if (!pass) throw new RewatchError(409, 'nothing_to_rewatch');
      await db.query(
        `INSERT INTO rewatch_passes(firebase_uid, series_id, season, target_level, started_at, episodes)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [request.user.uid, seriesId, season, pass.target, new Date(nowMs), JSON.stringify(pass.episodes)],
      );
      state.passes.push(pass);
      return { status: 201, body: await save(db, request.user.uid, seriesId, state, state.rewatches) };
    });
  }));

  // Ends a pass and keeps what was ticked ("Stop rewatching").
  router.post(`${base}/passes/:season/stop`, withIds((request, response, next, seriesId) => {
    const season = parseSeason(request.params.season);
    if (!season) return response.status(400).json({ error: 'invalid_season' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      if (!state.passes.some((pass) => pass.season === season)) throw new RewatchError(404, 'no_pass');
      await db.query(
        'DELETE FROM rewatch_passes WHERE firebase_uid=$1 AND series_id=$2 AND season=$3',
        [request.user.uid, seriesId, season],
      );
      state.passes = state.passes.filter((pass) => pass.season !== season);
      return { body: await save(db, request.user.uid, seriesId, state, state.rewatches) };
    });
  }));

  // Ends a pass and takes back every rewatch it added ("Remove this rewatch").
  router.post(`${base}/passes/:season/cancel`, withIds((request, response, next, seriesId) => {
    const season = parseSeason(request.params.season);
    if (!season) return response.status(400).json({ error: 'invalid_season' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      const pass = state.passes.find((candidate) => candidate.season === season);
      if (!pass) throw new RewatchError(404, 'no_pass');
      const { rewatches, removed } = removePassRewatches(state.rewatches, pass);
      await db.query(
        'DELETE FROM rewatch_passes WHERE firebase_uid=$1 AND series_id=$2 AND season=$3',
        [request.user.uid, seriesId, season],
      );
      state.passes = state.passes.filter((candidate) => candidate.season !== season);
      return { body: { ...(await save(db, request.user.uid, seriesId, state, rewatches)), removed } };
    });
  }));

  // Marks every episode still to do in a pass as rewatched, which finishes it ("Mark the rest").
  router.post(`${base}/passes/:season/finish`, withIds((request, response, next, seriesId) => {
    const season = parseSeason(request.params.season);
    if (!season) return response.status(400).json({ error: 'invalid_season' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      const pass = state.passes.find((candidate) => candidate.season === season);
      if (!pass) throw new RewatchError(404, 'no_pass');
      const nowMs = Date.now();
      const at = parseAt(request.body?.at, nowMs);
      let rewatches = state.rewatches;
      const pending = pendingKeys(pass, state.watched, rewatches);
      for (const key of pending) rewatches = addRewatch(rewatches, key, at, { source: 'pass', pass: pass.startedAt });
      const result = await save(db, request.user.uid, seriesId, state, rewatches, { touchAtMs: Date.parse(at) });
      return { body: { ...result, added: pending.length } };
    });
  }));

  // Adds a rewatch of one episode: `{ at? }`. Inside a pass that still wants the episode it counts for
  // the pass; otherwise it is a rewatch of its own.
  router.put(`${base}/episodes/:key`, withIds((request, response, next, seriesId) => {
    const key = request.params.key;
    if (!EPISODE_KEY.test(key)) return response.status(400).json({ error: 'invalid_episode' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      if (!state.watched.has(key)) throw new RewatchError(409, 'not_watched');
      const at = parseAt(request.body?.at, Date.now());
      const pass = passFor(state.passes, key, state.watched, state.rewatches);
      const rewatches = addRewatch(
        state.rewatches, key, at,
        pass ? { source: 'pass', pass: pass.startedAt } : { source: 'manual' },
      );
      return { body: await save(db, request.user.uid, seriesId, state, rewatches, { touchAtMs: Date.parse(at) }) };
    });
  }));

  // Takes off the latest rewatch of one episode (the episode itself stays watched).
  router.delete(`${base}/episodes/:key`, withIds((request, response, next, seriesId) => {
    const key = request.params.key;
    if (!EPISODE_KEY.test(key)) return response.status(400).json({ error: 'invalid_episode' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      const rewatches = removeLatest(state.rewatches, key);
      if (!rewatches) throw new RewatchError(404, 'no_rewatch');
      return { body: await save(db, request.user.uid, seriesId, state, rewatches) };
    });
  }));

  // One watch off every rewatched episode of a season ("Remove last rewatch"). Not while a pass is open:
  // that has its own stop and cancel.
  router.post(`${base}/seasons/:season/remove-last`, withIds((request, response, next, seriesId) => {
    const season = parseSeason(request.params.season);
    if (!season) return response.status(400).json({ error: 'invalid_season' });
    return inShowLock(request, response, next, seriesId, async (db, state) => {
      if (state.passes.some((pass) => pass.season === season)) throw new RewatchError(409, 'pass_open');
      const { rewatches, removed } = removeLastFromSeason(state.rewatches, season);
      if (!removed) throw new RewatchError(404, 'no_rewatch');
      return { body: { ...(await save(db, request.user.uid, seriesId, state, rewatches)), removed } };
    });
  }));
}

module.exports = { registerRewatchRoutes, levelOf, seasonOf };
