const express = require('express');
const { admin } = require('./firebase');
const { pool } = require('./db');
const { getTvSeason, getTvShowClassificationData, withImdbRatings } = require('./tmdb');
const { getUpcomingEpisodes } = require('./upcoming');
const { getRecommendations, invalidateRecommendations } = require('./recommendations');
const { registerMeMovieRoutes } = require('./me-movies');
const { hasAired, isValidTimeZone, localDateString } = require('./local-date');
const { EPISODE_KEY, markEpisodes, mergeImportedActions, toMs } = require('./episode-merge');

const router = express.Router();
const classificationRefreshes = new Map();
const classificationLifetimeMs = 24 * 60 * 60 * 1000;

// A pull-to-refresh is an explicit request for fresh data, so it ignores the
// 24-hour lifetime above. This shorter window only collapses repeat pulls and
// the refresh a just-completed progress write already queued.
const classificationDebounceMs = 60 * 1000;

// Series reclassified at once. Each one reads a show plus every season from
// TMDB, so an unbounded fan-out rate-limited itself into failing.
const classificationConcurrency = 4;

// Upper bound for one stored watchlist/favorites entry (about 32 KB of JSON).
const maxSeriesDocumentChars = 32 * 1024;

// Wall-clock budget for one pull-to-refresh. Whatever does not fit is left for
// the next pull or the background sweep, so a large library still gets a
// prompt, usable response instead of hitting a proxy timeout.
const classificationRequestBudgetMs = 20 * 1000;

router.use(async (request, response, next) => {
  if (request.path !== '/me' && !request.path.startsWith('/me/')) return next();
  const match = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
  if (!match) return response.status(401).json({ error: 'unauthenticated' });
  try {
    const token = await admin.auth().verifyIdToken(match[1]);
    request.user = { uid: token.uid, email: token.email || '' };
    await pool.query(
      `INSERT INTO app_users(firebase_uid, email) VALUES ($1, $2)
       ON CONFLICT(firebase_uid) DO UPDATE SET email = EXCLUDED.email
       WHERE app_users.email IS DISTINCT FROM EXCLUDED.email`,
      [request.user.uid, request.user.email],
    );
    next();
  } catch (error) {
    if (error && typeof error.code === 'string' && error.code.startsWith('auth/')) {
      return response.status(401).json({ error: 'invalid_token' });
    }
    next(error);
  }
});

// Movie routes first: the generic `/me/:collection/:seriesId` routes below would answer these
// paths with a 404.
registerMeMovieRoutes(router);

router.get('/me', async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT firebase_uid AS id, email, display_name AS "displayName",
              photo_url AS "photoUrl", created_at AS "createdAt"
       FROM app_users WHERE firebase_uid = $1`, [request.user.uid],
    );
    response.json(rows[0]);
  } catch (error) { next(error); }
});

router.patch('/me', async (request, response, next) => {
  const body = request.body || {};
  const displayName = typeof body.displayName === 'string'
    ? body.displayName.trim() : null;
  if (displayName !== null && displayName.length > 120) {
    return response.status(400).json({ error: 'display_name_too_long' });
  }
  // Optional. Reported by the app on start and resume so "has it aired?" can be
  // answered against the user's own calendar date.
  let timezone = null;
  if (body.timezone !== undefined && body.timezone !== null) {
    if (!isValidTimeZone(body.timezone)) {
      return response.status(400).json({ error: 'invalid_timezone' });
    }
    timezone = body.timezone;
  }
  try {
    const { rows } = await pool.query(
      `UPDATE app_users SET display_name = COALESCE($2, display_name),
         timezone = COALESCE($3, timezone), updated_at = NOW()
       WHERE firebase_uid = $1
       RETURNING firebase_uid AS id, email, display_name AS "displayName",
                 photo_url AS "photoUrl", timezone, created_at AS "createdAt"`,
      [request.user.uid, displayName, timezone],
    );
    response.json(rows[0]);
  } catch (error) { next(error); }
});

router.post('/me/avatar', async (request, response, next) => {
  const { contentType, imageBase64 } = request.body || {};
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType) ||
      typeof imageBase64 !== 'string') {
    return response.status(400).json({ error: 'invalid_image' });
  }
  const image = Buffer.from(imageBase64, 'base64');
  if (!image.length || image.length > 8 * 1024 * 1024) {
    return response.status(413).json({ error: 'image_too_large' });
  }
  try {
    await pool.query(
      `UPDATE app_users SET avatar=$2, avatar_content_type=$3,
         photo_url='/api/v1/me/avatar', updated_at=NOW() WHERE firebase_uid=$1`,
      [request.user.uid, image, contentType],
    );
    response.json({ photoUrl: '/api/v1/me/avatar' });
  } catch (error) { next(error); }
});

router.get('/me/avatar', async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT avatar, avatar_content_type FROM app_users WHERE firebase_uid=$1',
      [request.user.uid],
    );
    if (!rows[0] || !rows[0].avatar) return response.status(404).end();
    response.set('Content-Type', rows[0].avatar_content_type || 'image/jpeg');
    response.set('Cache-Control', 'private, no-store');
    response.send(rows[0].avatar);
  } catch (error) { next(error); }
});

router.delete('/me/avatar', async (request, response, next) => {
  try {
    await pool.query(
      `UPDATE app_users SET avatar=NULL, avatar_content_type=NULL, photo_url=NULL,
       updated_at=NOW() WHERE firebase_uid=$1`, [request.user.uid],
    );
    response.status(204).end();
  } catch (error) { next(error); }
});

router.get('/me/progress', async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT series_id AS "seriesId", current_season AS "currentSeason",
        current_episode AS "currentEpisode", watched_episodes AS "watchedEpisodes",
        watched_episode_dates AS "watchedEpisodeDates", watched_count AS "watchedCount",
        total_episodes AS "totalEpisodes", last_watched AS "lastWatched",
        show_name AS "showName", poster_path AS "posterPath", backdrop_path AS "backdropPath",
        classification, classification_checked_at AS "classificationCheckedAt",
        released_episode_count AS "releasedEpisodeCount", is_ended AS "isEnded"
       FROM show_progress WHERE firebase_uid=$1 ORDER BY updated_at DESC`,
      [request.user.uid],
    );
    response.json(rows);
  } catch (error) { next(error); }
});

router.get('/me/watchlist-view', async (request, response, next) => {
  try {
    const [watchlistResult, progressResult] = await Promise.all([
      pool.query(
        `SELECT series AS data, added_at AS "addedAt" FROM watchlist
         WHERE firebase_uid=$1 ORDER BY added_at DESC`,
        [request.user.uid],
      ),
      pool.query(
        `SELECT series_id AS "seriesId", current_season AS "currentSeason",
          current_episode AS "currentEpisode", watched_episodes AS "watchedEpisodes",
          watched_episode_dates AS "watchedEpisodeDates", watched_count AS "watchedCount",
          total_episodes AS "totalEpisodes", last_watched AS "lastWatched",
          show_name AS "showName", poster_path AS "posterPath",
          backdrop_path AS "backdropPath", classification,
          classification_checked_at AS "classificationCheckedAt",
          released_episode_count AS "releasedEpisodeCount", is_ended AS "isEnded"
         FROM show_progress WHERE firebase_uid=$1 ORDER BY updated_at DESC`,
        [request.user.uid],
      ),
    ]);
    const progressById = new Map(
      progressResult.rows.map((row) => [
        seriesKey(row.seriesId),
        !hasWatchedProgress(row)
          ? { ...row, classification: 'unstarted', lastWatched: null }
          : row,
      ]),
    );
    const allShows = [];
    const includedIds = new Set();
    for (const row of watchlistResult.rows) {
      const show = { ...row.data, addedAt: row.addedAt };
      const progress = progressById.get(seriesKey(show.id));
      allShows.push({ show, progress: progress || {
        seriesId: show.id,
        currentSeason: 1,
        currentEpisode: 1,
        watchedEpisodes: [],
        watchedEpisodeDates: {},
        watchedCount: 0,
        totalEpisodes: 0,
        lastWatched: null,
        showName: show.name,
        posterPath: show.posterPath,
        backdropPath: show.backdropPath,
        classification: 'unstarted',
        classificationCheckedAt: null,
        releasedEpisodeCount: 0,
        isEnded: false,
      } });
      includedIds.add(seriesKey(show.id));
    }
    for (const progress of progressResult.rows) {
      if (includedIds.has(seriesKey(progress.seriesId))) continue;
      allShows.push({
        show: {
          id: progress.seriesId,
          name: progress.showName || 'TV show',
          overview: '',
          posterPath: progress.posterPath,
          backdropPath: progress.backdropPath,
          rating: 0,
          firstAirDate: '',
        },
        progress: !hasWatchedProgress(progress)
          ? { ...progress, classification: 'unstarted', lastWatched: null }
          : progress,
      });
    }
    response.json({
      watchlist: watchlistResult.rows.map((row) => ({
        ...row.data,
        addedAt: row.addedAt,
      })),
      // The normalized rows, not the raw ones. `allShows` already reported a
      // zero-watched show as `unstarted` while this list reported whatever was
      // stored, so the same series contradicted itself across the response.
      // Map values keep the `updated_at DESC` order of the rows they came from.
      progress: [...progressById.values()],
      allShows,
    });
  } catch (error) { next(error); }
});

router.get('/me/upcoming', async (request, response, next) => {
  const today = typeof request.query.today === 'string' ? request.query.today : '';
  const forceRefresh = request.query.refresh === 'true';
  try {
    const episodes = await getUpcomingEpisodes({
      uid: request.user.uid,
      today,
      forceRefresh,
      pool,
    });
    response.set('Cache-Control', 'private, no-store');
    response.json({ episodes });
  } catch (error) { next(error); }
});

router.post('/me/refresh-classifications', async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.series_id AS "seriesId", p.classification,
              p.classification_checked_at AS "classificationCheckedAt",
              p.classification_date AS "classificationDate", u.timezone
       FROM show_progress p
       JOIN app_users u ON u.firebase_uid = p.firebase_uid
       WHERE p.firebase_uid=$1
       ORDER BY p.classification_checked_at ASC NULLS FIRST`,
      [request.user.uid],
    );
    // Stalest first, so successive pulls work through a large library instead
    // of re-doing the same leading shows until the budget runs out.
    const today = localDateString(rows[0]?.timezone);
    const due = rows.filter(
      (row) => !isClassificationFresh(row, classificationDebounceMs, today),
    );

    const deadline = Date.now() + classificationRequestBudgetMs;
    const failedSeriesIds = [];
    let refreshed = 0;
    await mapWithConcurrency(
      due,
      classificationConcurrency,
      async (row) => {
        try {
          await refreshClassificationOnce(request.user.uid, row.seriesId);
          refreshed += 1;
        } catch (error) {
          failedSeriesIds.push(row.seriesId);
          console.error(`[classification] ${row.seriesId}: ${error.message}`);
        }
      },
      { stopWhen: () => Date.now() >= deadline },
    );

    response.json({
      refreshed,
      failed: failedSeriesIds.length,
      failedSeriesIds,
      skipped: rows.length - due.length,
      pending: due.length - refreshed - failedSeriesIds.length,
    });
  } catch (error) { next(error); }
});

router.get('/me/recommendations', async (request, response, next) => {
  const page = Number.parseInt(request.query.page, 10);
  try {
    response.json(await withImdbRatings(await getRecommendations(
      request.user.uid,
      Number.isInteger(page) && page >= 1 && page <= 500 ? page : 1,
    )));
  } catch (error) { next(error); }
});

router.get('/me/:collection', async (request, response, next) => {
  const table = collectionTable(request.params.collection);
  if (!table) return response.status(404).json({ error: 'not_found' });
  try {
    const { rows } = await pool.query(
      `SELECT series AS data, added_at AS "addedAt" FROM ${table}
       WHERE firebase_uid = $1 ORDER BY added_at DESC`, [request.user.uid],
    );
    response.json(rows.map((row) => ({ ...row.data, addedAt: row.addedAt })));
  } catch (error) { next(error); }
});

router.put('/me/:collection/:seriesId', async (request, response, next) => {
  if (request.params.collection === 'progress') return next();
  const table = collectionTable(request.params.collection);
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  // Express 5 leaves `request.body` undefined when no JSON body was sent.
  const body = request.body || {};
  const bodyId = Number(body.id || body.seriesId);
  if (!table) return response.status(404).json({ error: 'not_found' });
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 || bodyId !== seriesId) {
    return response.status(400).json({ error: 'invalid_series' });
  }
  // The row is stored as given, so bound it: the app sends a few short fields,
  // while the 12 MB body limit (there for avatars) would let any signed-in
  // account park megabytes in a single watchlist entry.
  if (JSON.stringify(body).length > maxSeriesDocumentChars) {
    return response.status(413).json({ error: 'series_too_large' });
  }
  try {
    const data = { ...body, id: seriesId };
    const { rows } = await pool.query(
      `INSERT INTO ${table}(firebase_uid, series_id, series) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT(firebase_uid,series_id) DO UPDATE
       SET series=${table}.series || EXCLUDED.series
       RETURNING series AS data, added_at AS "addedAt"`,
      [request.user.uid, seriesId, JSON.stringify(data)],
    );
    invalidateRecommendations(request.user.uid);
    response.json({ ...rows[0].data, addedAt: rows[0].addedAt });
  } catch (error) { next(error); }
});

router.delete('/me/:collection/:seriesId', async (request, response, next) => {
  if (request.params.collection === 'progress') return next();
  const table = collectionTable(request.params.collection);
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  if (!table) return response.status(404).json({ error: 'not_found' });
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return response.status(400).json({ error: 'invalid_series_id' });
  }
  try {
    await pool.query(`DELETE FROM ${table} WHERE firebase_uid=$1 AND series_id=$2`,
      [request.user.uid, seriesId]);
    invalidateRecommendations(request.user.uid);
    response.status(204).end();
  } catch (error) { next(error); }
});

const PROGRESS_COLUMNS = `series_id AS "seriesId",current_season AS "currentSeason",
  current_episode AS "currentEpisode",watched_episodes AS "watchedEpisodes",
  watched_episode_dates AS "watchedEpisodeDates",watched_count AS "watchedCount",
  total_episodes AS "totalEpisodes",last_watched AS "lastWatched",
  show_name AS "showName",poster_path AS "posterPath",backdrop_path AS "backdropPath",
  classification,classification_checked_at AS "classificationCheckedAt",
  released_episode_count AS "releasedEpisodeCount",is_ended AS "isEnded"`;

// The remembered unwatch dates for one show, as { 'S1E2': isoDate }. These live
// in their own table and are read only by the episode-marking and import
// endpoints, never by anything that draws a list of shows.
async function loadUnwatched(db, uid, seriesId) {
  const { rows } = await db.query(
    `SELECT episode_key, unwatched_at FROM unwatched_episodes
     WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.episode_key, new Date(row.unwatched_at).toISOString()]),
  );
}

// Brings the stored unwatch dates from `before` to `after`.
async function saveUnwatched(db, uid, seriesId, before, after) {
  const removed = Object.keys(before).filter((key) => !(key in after));
  const changed = Object.keys(after).filter((key) => before[key] !== after[key]);
  if (removed.length) {
    await db.query(
      `DELETE FROM unwatched_episodes
       WHERE firebase_uid=$1 AND series_id=$2 AND episode_key = ANY($3::text[])`,
      [uid, seriesId, removed],
    );
  }
  if (changed.length) {
    await db.query(
      `INSERT INTO unwatched_episodes(firebase_uid,series_id,episode_key,unwatched_at)
       SELECT $1,$2,k,t FROM unnest($3::text[],$4::timestamptz[]) AS x(k,t)
       ON CONFLICT(firebase_uid,series_id,episode_key)
       DO UPDATE SET unwatched_at=EXCLUDED.unwatched_at`,
      [uid, seriesId, changed, changed.map((key) => after[key])],
    );
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

// One show's progress. The app used to download every show's progress and scan
// for the one it wanted.
router.get('/me/progress/:seriesId', async (request, response, next) => {
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return response.status(400).json({ error: 'invalid_series_id' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT ${PROGRESS_COLUMNS} FROM show_progress
       WHERE firebase_uid=$1 AND series_id=$2`,
      [request.user.uid, seriesId],
    );
    if (!rows[0]) return response.status(404).json({ error: 'not_found' });
    response.json(rows[0]);
  } catch (error) { next(error); }
});

// Marks episodes watched or unwatched without the client sending the whole
// watched set back. The read-modify-write runs under a per-show advisory lock,
// so two quick taps (or two devices) apply one after the other instead of the
// later PUT overwriting the earlier one with a stale copy.
router.patch('/me/progress/:seriesId/episodes', async (request, response, next) => {
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  const body = request.body || {};
  const keys = body.episodeKeys;
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 ||
      typeof body.watched !== 'boolean' ||
      !Array.isArray(keys) || keys.length === 0 || keys.length > 5000 ||
      !keys.every((key) => typeof key === 'string' && /^S\d{1,4}E\d{1,5}$/.test(key)) ||
      !Number.isInteger(body.currentSeason) || !Number.isInteger(body.currentEpisode)) {
    return response.status(400).json({ error: 'invalid_episodes' });
  }
  const optionalString = (value) => (typeof value === 'string' ? value : null);
  const db = await pool.connect().catch((error) => { next(error); return null; });
  if (!db) return;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${request.user.uid}:${seriesId}`]);
    const { rows: existingRows } = await db.query(
      `SELECT watched_episodes, watched_episode_dates, last_watched, total_episodes
       FROM show_progress WHERE firebase_uid=$1 AND series_id=$2`,
      [request.user.uid, seriesId],
    );
    const existing = existingRows[0];
    const unwatchedBefore = await loadUnwatched(db, request.user.uid, seriesId);
    const now = new Date();
    // Marking and unmarking in the app is the newest information there is, so
    // it is applied without comparison. An unmark is also remembered, so an
    // older import cannot bring the episode back.
    const marked = markEpisodes(
      {
        watched: Array.isArray(existing?.watched_episodes)
          ? existing.watched_episodes.map(String) : [],
        dates: plainObject(existing?.watched_episode_dates),
        unwatched: unwatchedBefore,
      },
      keys,
      body.watched,
      now.toISOString(),
    );
    const episodes = marked.watched;
    const dates = marked.dates;
    const lastWatched = episodes.size === 0
      ? null : body.watched ? now : (existing?.last_watched ?? null);
    const totalEpisodes = Number.isInteger(body.totalEpisodes) && body.totalEpisodes >= 0
      ? body.totalEpisodes : (existing?.total_episodes ?? 0);

    const { rows } = await db.query(
      `INSERT INTO show_progress(firebase_uid,series_id,current_season,current_episode,
        watched_episodes,watched_episode_dates,watched_count,total_episodes,last_watched,
        show_name,poster_path,backdrop_path,classification,classification_checked_at,
        released_episode_count,is_ended)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,NULL,NULL,0,FALSE)
       ON CONFLICT(firebase_uid,series_id) DO UPDATE SET
        current_season=EXCLUDED.current_season,current_episode=EXCLUDED.current_episode,
        watched_episodes=EXCLUDED.watched_episodes,
        watched_episode_dates=EXCLUDED.watched_episode_dates,
        watched_count=EXCLUDED.watched_count,total_episodes=EXCLUDED.total_episodes,
        last_watched=EXCLUDED.last_watched,
        show_name=COALESCE(EXCLUDED.show_name,show_progress.show_name),
        poster_path=COALESCE(EXCLUDED.poster_path,show_progress.poster_path),
        backdrop_path=COALESCE(EXCLUDED.backdrop_path,show_progress.backdrop_path),
        classification=NULL,classification_checked_at=NULL,
        released_episode_count=0,is_ended=FALSE,updated_at=NOW()
       RETURNING ${PROGRESS_COLUMNS}`,
      [request.user.uid, seriesId, body.currentSeason, body.currentEpisode,
       JSON.stringify([...episodes]), JSON.stringify(dates), episodes.size, totalEpisodes,
       lastWatched, optionalString(body.showName), optionalString(body.posterPath),
       optionalString(body.backdropPath)],
    );
    await saveUnwatched(db, request.user.uid, seriesId, unwatchedBefore, marked.unwatched);
    await db.query('COMMIT');
    response.json(rows[0]);
    scheduleClassificationRefresh(request.user.uid, rows[0].seriesId);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    db.release();
  }
});

// Merges imported watch records (for example from a Trakt export) into one
// show, newest date winning per episode - see episode-merge.js. Sent as
// `{ actions: [{ key, watched, at }], totalEpisodes?, showName?, posterPath?,
// backdropPath?, summary?: { plays, lastWatched } }`.
//
// Answers with the show's progress, or 204 when it ends up with no watched
// episodes: a show with nothing watched has no progress row, exactly as before,
// so it cannot appear in All Shows or count as tracked. What is remembered
// about unwatched episodes is stored apart and is invisible there.
//
// Running the same request again changes nothing, so a client may retry it.
router.post('/me/progress/:seriesId/import', async (request, response, next) => {
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  const body = request.body || {};
  const actions = body.actions;
  const summary = body.summary;
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 ||
      !Array.isArray(actions) || actions.length > 5000 ||
      !actions.every((action) => action && typeof action === 'object' &&
        typeof action.key === 'string' && EPISODE_KEY.test(action.key) &&
        typeof action.watched === 'boolean' && toMs(action.at) !== null) ||
      !isOptionalCount(body.totalEpisodes) ||
      (summary !== undefined && summary !== null &&
        (typeof summary !== 'object' || !isOptionalCount(summary.plays) ||
         !isOptionalDate(summary.lastWatched)))) {
    return response.status(400).json({ error: 'invalid_import' });
  }
  const optionalString = (value) => (typeof value === 'string' ? value : null);
  const db = await pool.connect().catch((error) => { next(error); return null; });
  if (!db) return;
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${request.user.uid}:${seriesId}`]);
    const { rows: existingRows } = await db.query(
      `SELECT watched_episodes, watched_episode_dates, last_watched, total_episodes,
              current_season, current_episode
       FROM show_progress WHERE firebase_uid=$1 AND series_id=$2`,
      [request.user.uid, seriesId],
    );
    const existing = existingRows[0];
    const unwatchedBefore = await loadUnwatched(db, request.user.uid, seriesId);
    const merged = mergeImportedActions(
      {
        watched: Array.isArray(existing?.watched_episodes)
          ? existing.watched_episodes.map(String) : [],
        dates: plainObject(existing?.watched_episode_dates),
        unwatched: unwatchedBefore,
      },
      actions,
    );
    await saveUnwatched(db, request.user.uid, seriesId, unwatchedBefore, merged.unwatched);

    if (merged.watched.size === 0) {
      if (existing) {
        await db.query(
          'DELETE FROM show_progress WHERE firebase_uid=$1 AND series_id=$2',
          [request.user.uid, seriesId],
        );
      }
      await db.query('COMMIT');
      return response.status(204).end();
    }

    // The most recent activity: the newest watch date, any activity date
    // already on file, and the export's own last-watched date for the show.
    const candidates = [
      ...Object.values(merged.dates).map(toMs),
      toMs(existing?.last_watched),
      summary && Number(summary.plays) > 0 ? toMs(summary.lastWatched) : null,
    ].filter((ms) => ms !== null);
    const lastWatched = candidates.length ? new Date(Math.max(...candidates)) : null;
    const totalEpisodes = Number.isInteger(body.totalEpisodes) && body.totalEpisodes > 0
      ? body.totalEpisodes : (existing?.total_episodes ?? 0);

    const { rows } = await db.query(
      `INSERT INTO show_progress(firebase_uid,series_id,current_season,current_episode,
        watched_episodes,watched_episode_dates,watched_count,total_episodes,last_watched,
        show_name,poster_path,backdrop_path,classification,classification_checked_at,
        released_episode_count,is_ended)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,NULL,NULL,0,FALSE)
       ON CONFLICT(firebase_uid,series_id) DO UPDATE SET
        watched_episodes=EXCLUDED.watched_episodes,
        watched_episode_dates=EXCLUDED.watched_episode_dates,
        watched_count=EXCLUDED.watched_count,total_episodes=EXCLUDED.total_episodes,
        last_watched=EXCLUDED.last_watched,
        show_name=COALESCE(EXCLUDED.show_name,show_progress.show_name),
        poster_path=COALESCE(EXCLUDED.poster_path,show_progress.poster_path),
        backdrop_path=COALESCE(EXCLUDED.backdrop_path,show_progress.backdrop_path),
        classification=NULL,classification_checked_at=NULL,
        released_episode_count=0,is_ended=FALSE,updated_at=NOW()
       RETURNING ${PROGRESS_COLUMNS}`,
      [request.user.uid, seriesId, existing?.current_season ?? 1,
       existing?.current_episode ?? 1, JSON.stringify([...merged.watched]),
       JSON.stringify(merged.dates), merged.watched.size, totalEpisodes, lastWatched,
       optionalString(body.showName), optionalString(body.posterPath),
       optionalString(body.backdropPath)],
    );
    await db.query('COMMIT');
    response.json(rows[0]);
    scheduleClassificationRefresh(request.user.uid, rows[0].seriesId);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    db.release();
  }
});

router.put('/me/progress/:seriesId', async (request, response, next) => {
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  const body = request.body || {};
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 ||
      !Number.isInteger(body.currentSeason) || !Number.isInteger(body.currentEpisode) ||
      !Array.isArray(body.watchedEpisodes) || !body.watchedEpisodeDates ||
      typeof body.watchedEpisodeDates !== 'object' ||
      !isOptionalCount(body.watchedCount) || !isOptionalCount(body.totalEpisodes) ||
      !isOptionalDate(body.lastWatched)) {
    return response.status(400).json({ error: 'invalid_progress' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO show_progress(firebase_uid,series_id,current_season,current_episode,
        watched_episodes,watched_episode_dates,watched_count,total_episodes,last_watched,
         show_name,poster_path,backdrop_path,classification,classification_checked_at,
         released_episode_count,is_ended)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,
         NULL,NULL,0,FALSE)
        ON CONFLICT(firebase_uid,series_id) DO UPDATE SET
        current_season=EXCLUDED.current_season,current_episode=EXCLUDED.current_episode,
        watched_episodes=EXCLUDED.watched_episodes,
        watched_episode_dates=EXCLUDED.watched_episode_dates,
        watched_count=EXCLUDED.watched_count,total_episodes=EXCLUDED.total_episodes,
        last_watched=CASE WHEN jsonb_array_length(EXCLUDED.watched_episodes) = 0
          THEN NULL ELSE EXCLUDED.last_watched END,
        show_name=COALESCE(EXCLUDED.show_name,show_progress.show_name),
        poster_path=COALESCE(EXCLUDED.poster_path,show_progress.poster_path),
        backdrop_path=COALESCE(EXCLUDED.backdrop_path,show_progress.backdrop_path),
        classification=NULL,classification_checked_at=NULL,
        released_episode_count=0,is_ended=FALSE,updated_at=NOW()
       RETURNING series_id AS "seriesId",current_season AS "currentSeason",
        current_episode AS "currentEpisode",watched_episodes AS "watchedEpisodes",
        watched_episode_dates AS "watchedEpisodeDates",watched_count AS "watchedCount",
        total_episodes AS "totalEpisodes",last_watched AS "lastWatched",
        show_name AS "showName",poster_path AS "posterPath",backdrop_path AS "backdropPath",
        classification,classification_checked_at AS "classificationCheckedAt",
        released_episode_count AS "releasedEpisodeCount",is_ended AS "isEnded"`,
      [request.user.uid, seriesId, body.currentSeason, body.currentEpisode,
       JSON.stringify(body.watchedEpisodes), JSON.stringify(body.watchedEpisodeDates),
       Number(body.watchedCount ?? body.watchedEpisodes.length), Number(body.totalEpisodes ?? 0),
       body.lastWatched ?? null, body.showName ?? null, body.posterPath ?? null,
       body.backdropPath ?? null],
    );
    response.json(rows[0]);
    scheduleClassificationRefresh(request.user.uid, rows[0].seriesId);
  } catch (error) { next(error); }
});

router.delete('/me/progress/:seriesId', async (request, response, next) => {
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  // Unvalidated, a non-numeric id reached Postgres as NaN and came back as a
  // 500, so the client could not tell a bad request from a server fault.
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return response.status(400).json({ error: 'invalid_series_id' });
  }
  try {
    await pool.query('DELETE FROM show_progress WHERE firebase_uid=$1 AND series_id=$2',
      [request.user.uid, seriesId]);
    // Deleting a show's history on purpose also forgets what was unmarked, so
    // an import can restore it.
    await pool.query('DELETE FROM unwatched_episodes WHERE firebase_uid=$1 AND series_id=$2',
      [request.user.uid, seriesId]);
    response.status(204).end();
  } catch (error) { next(error); }
});

// Absent, or a non-negative integer. A string like "abc" used to reach Postgres
// as NaN and come back as a 500, which the client cannot tell from an outage.
function isOptionalCount(value) {
  return value === undefined || value === null ||
    (Number.isInteger(value) && value >= 0);
}

// Absent, or an ISO date string Postgres will accept.
function isOptionalDate(value) {
  return value === undefined || value === null ||
    (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function collectionTable(name) {
  return name === 'watchlist' || name === 'favorites' ? name : null;
}

// Fresh means recent *and* computed for the user's current local date. Whether
// an episode has aired depends on that date, so a result from yesterday is
// stale however recently it ran.
function isClassificationFresh(progress, maxAgeMs, today) {
  if (!progress.classification) return false;
  if (progress.classificationDate !== today) return false;
  const checkedAt = progress.classificationCheckedAt
    ? new Date(progress.classificationCheckedAt).getTime()
    : NaN;
  return Number.isFinite(checkedAt) && Date.now() - checkedAt < maxAgeMs;
}

function hasWatchedProgress(progress) {
  return Number(progress.watchedCount || 0) > 0 ||
    (Array.isArray(progress.watchedEpisodes) && progress.watchedEpisodes.length > 0) ||
    progress.lastWatched != null;
}

function seriesKey(seriesId) {
  return String(seriesId);
}

// Joins the in-flight refresh for a series, or starts one.
//
// Pull-to-refresh, the per-write recompute and the background sweep all reach
// the same series. Running them concurrently doubled the TMDB reads and let two
// passes race on watchlist membership, each deciding whether the show was still
// active from its own pre-update snapshot.
function refreshClassificationOnce(uid, seriesId) {
  const key = `${uid}:${seriesId}`;
  const inFlight = classificationRefreshes.get(key);
  if (inFlight) return inFlight;

  const refresh = refreshClassification(uid, seriesId)
    .finally(() => classificationRefreshes.delete(key));
  classificationRefreshes.set(key, refresh);
  return refresh;
}

// Fire-and-forget recompute after a progress write, which stores a NULL
// classification. The sweep retries anything that stays NULL.
function scheduleClassificationRefresh(uid, seriesId) {
  refreshClassificationOnce(uid, seriesId).catch((error) => console.error(
    `[classification] ${seriesId}: ${error.message}`,
  ));
}

// Runs `run` over `items`, at most `limit` at a time, stopping before the next
// item once `stopWhen` reports the caller's time budget is spent.
async function mapWithConcurrency(items, limit, run, { stopWhen } = {}) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        if (stopWhen && stopWhen()) return;
        // Claimed before the await, not after. Advancing afterwards let every
        // worker read the same index: each claimed item ran `limit` times and
        // the `limit - 1` items behind it were skipped, so most of a library
        // was never reclassified at all.
        const item = items[next];
        next += 1;
        await run(item);
      }
    },
  );
  await Promise.all(workers);
}

async function refreshStaleClassifications() {
  const { rows: all } = await pool.query(
    `SELECT p.firebase_uid AS uid, p.series_id AS "seriesId", p.classification,
            p.classification_checked_at AS "classificationCheckedAt",
            p.classification_date AS "classificationDate", u.timezone
     FROM show_progress p
     JOIN app_users u ON u.firebase_uid = p.firebase_uid
     ORDER BY p.classification_checked_at ASC NULLS FIRST`,
  );
  // Decided here rather than in SQL: "today" is per user, and an unrecognised
  // timezone name must not fail the whole query for everyone.
  const todayByZone = new Map();
  const todayFor = (zone) => {
    if (!todayByZone.has(zone)) todayByZone.set(zone, localDateString(zone));
    return todayByZone.get(zone);
  };
  const rows = all.filter(
    (row) => !isClassificationFresh(row, classificationLifetimeMs, todayFor(row.timezone)),
  );
  // Capped like the pull-to-refresh path. The sweep covers every user at once,
  // so firing it all at once rate-limited the interactive refreshes behind it.
  await mapWithConcurrency(rows, classificationConcurrency, async (progress) => {
    try {
      await refreshClassificationOnce(progress.uid, progress.seriesId);
    } catch (error) {
      console.error(`[classification] ${progress.seriesId}: ${error.message}`);
    }
  });
}

async function refreshClassification(uid, seriesId) {
  const { rows } = await pool.query(
    `SELECT p.watched_episodes AS "watchedEpisodes",
            p.watched_count AS "watchedCount", p.last_watched AS "lastWatched",
            p.show_name AS "showName", p.poster_path AS "posterPath",
            p.backdrop_path AS "backdropPath",
            w.series AS "watchlistSeries", u.timezone
     FROM show_progress p
     JOIN app_users u ON u.firebase_uid=p.firebase_uid
     LEFT JOIN watchlist w
       ON w.firebase_uid=p.firebase_uid AND w.series_id=p.series_id
     WHERE p.firebase_uid=$1 AND p.series_id=$2`,
    [uid, seriesId],
  );
  if (!rows[0]) return;

  const show = await getTvShowClassificationData(seriesId);
  const seasons = Array.isArray(show.seasons)
    ? show.seasons.filter((season) => Number(season.season_number) > 0)
    : [];
  // All-or-nothing on purpose: a tolerated season failure undercounts released
  // episodes, which reads as "caught up" and drops the show off the watchlist.
  // Throwing leaves the stored classification stale for the sweep to retry.
  const seasonResults = await Promise.all(
    seasons.map((season) => getTvSeason(seriesId, season.season_number)),
  );
  const watched = new Set(Array.isArray(rows[0].watchedEpisodes)
    ? rows[0].watchedEpisodes.map(String)
    : []);
  // The user's own calendar date, so an episode counts as aired from local
  // midnight on its air date — the same rule the app applies.
  const today = localDateString(rows[0].timezone);
  let releasedEpisodeCount = 0;
  let watchedReleasedCount = 0;
  for (const season of seasonResults) {
    for (const episode of Array.isArray(season.episodes) ? season.episodes : []) {
      if (!hasAired(episode.air_date, today)) continue;
      releasedEpisodeCount += 1;
      if (watched.has(`S${season.season_number}E${episode.episode_number}`)) {
        watchedReleasedCount += 1;
      }
    }
  }

  // A watched episode can be absent from TMDB's currently released episode
  // list (for example after a season is renumbered or while an imported
  // episode is not yet aired there). That still means the user started the
  // show, so do not classify it as unstarted just because no released episode
  // matched.
  const isStarted = Number(rows[0].watchedCount || 0) > 0 ||
    watched.size > 0 ||
    rows[0].lastWatched != null;
  const isEnded = ['ended', 'canceled', 'cancelled'].includes(
    String(show.status || '').toLowerCase(),
  );
  const classification = !isStarted
    ? 'unstarted'
    : releasedEpisodeCount > 0 &&
      watchedReleasedCount === releasedEpisodeCount
    ? (isEnded ? 'finished' : 'upToDate')
    : 'watching';

  // `updated_at` is deliberately not touched: it means "when the user's
  // progress last changed" and both progress reads order by it. A sweep that
  // bumped it reshuffled every row into reclassification order — stalest
  // first — which is the reverse of the recency those queries ask for.
  // `classification_checked_at` already records when this check ran.
  await pool.query(
    `UPDATE show_progress
     SET classification=$3,classification_checked_at=NOW(),
         released_episode_count=$4,is_ended=$5,classification_date=$6
     WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId, classification, releasedEpisodeCount, isEnded, today],
  );

  if (releasedEpisodeCount === 0) return;
  const isCaughtUp = watchedReleasedCount === releasedEpisodeCount;
  const isActive = rows[0].watchlistSeries != null;
  if (isCaughtUp && isActive) {
    await pool.query(
      'DELETE FROM watchlist WHERE firebase_uid=$1 AND series_id=$2',
      [uid, seriesId],
    );
  } else if (!isCaughtUp && isStarted && !isActive) {
    const stored = rows[0].watchlistSeries;
    const series = stored || {
      id: seriesId,
      name: rows[0].showName || show.name || 'TV show',
      overview: show.overview || '',
      posterPath: rows[0].posterPath || show.poster_path || null,
      backdropPath: rows[0].backdropPath || show.backdrop_path || null,
      rating: Number(show.vote_average || 0),
      firstAirDate: show.first_air_date || '',
    };
    await pool.query(
      `INSERT INTO watchlist(firebase_uid,series_id,series)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT(firebase_uid,series_id) DO NOTHING`,
      [uid, seriesId, JSON.stringify(series)],
    );
  }
}

module.exports = { refreshStaleClassifications, router };
