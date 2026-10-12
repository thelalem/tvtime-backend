const express = require('express');
const { admin } = require('./firebase');
const { pool } = require('./db');
const { getTvSeason, getTvShowClassificationData } = require('./tmdb');

const router = express.Router();
const classificationRefreshes = new Map();
const classificationLifetimeMs = 24 * 60 * 60 * 1000;

router.use(async (request, response, next) => {
  if (request.path !== '/me' && !request.path.startsWith('/me/')) return next();
  const match = /^Bearer\s+(.+)$/i.exec(request.get('authorization') || '');
  if (!match) return response.status(401).json({ error: 'unauthenticated' });
  try {
    const token = await admin.auth().verifyIdToken(match[1]);
    request.user = { uid: token.uid, email: token.email || '' };
    await pool.query(
      `INSERT INTO app_users(firebase_uid, email) VALUES ($1, $2)
       ON CONFLICT(firebase_uid) DO UPDATE SET email = EXCLUDED.email`,
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
  const displayName = typeof request.body.displayName === 'string'
    ? request.body.displayName.trim() : null;
  if (displayName !== null && displayName.length > 120) {
    return response.status(400).json({ error: 'display_name_too_long' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE app_users SET display_name = COALESCE($2, display_name), updated_at = NOW()
       WHERE firebase_uid = $1
       RETURNING firebase_uid AS id, email, display_name AS "displayName",
                 photo_url AS "photoUrl", created_at AS "createdAt"`,
      [request.user.uid, displayName],
    );
    response.json(rows[0]);
  } catch (error) { next(error); }
});

router.post('/me/avatar', async (request, response, next) => {
  const { contentType, imageBase64 } = request.body;
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
    for (const row of rows) scheduleClassificationRefresh(request.user.uid, row);
    response.json(rows);
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
  const bodyId = Number(request.body.id || request.body.seriesId);
  if (!table) return response.status(404).json({ error: 'not_found' });
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 || bodyId !== seriesId) {
    return response.status(400).json({ error: 'invalid_series' });
  }
  try {
    const data = { ...request.body, id: seriesId };
    const { rows } = await pool.query(
      `INSERT INTO ${table}(firebase_uid, series_id, series) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT(firebase_uid,series_id) DO UPDATE
       SET series=${table}.series || EXCLUDED.series
       RETURNING series AS data, added_at AS "addedAt"`,
      [request.user.uid, seriesId, JSON.stringify(data)],
    );
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
    response.status(204).end();
  } catch (error) { next(error); }
});

router.put('/me/progress/:seriesId', async (request, response, next) => {
  const seriesId = Number.parseInt(request.params.seriesId, 10);
  const body = request.body;
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0 ||
      !Number.isInteger(body.currentSeason) || !Number.isInteger(body.currentEpisode) ||
      !Array.isArray(body.watchedEpisodes) || !body.watchedEpisodeDates ||
      typeof body.watchedEpisodeDates !== 'object') {
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
        last_watched=EXCLUDED.last_watched,
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
    scheduleClassificationRefresh(request.user.uid, rows[0]);
  } catch (error) { next(error); }
});

router.delete('/me/progress/:seriesId', async (request, response, next) => {
  try {
    await pool.query('DELETE FROM show_progress WHERE firebase_uid=$1 AND series_id=$2',
      [request.user.uid, Number.parseInt(request.params.seriesId, 10)]);
    response.status(204).end();
  } catch (error) { next(error); }
});

function collectionTable(name) {
  return name === 'watchlist' || name === 'favorites' ? name : null;
}

function scheduleClassificationRefresh(uid, progress) {
  const checkedAt = progress.classificationCheckedAt
    ? new Date(progress.classificationCheckedAt).getTime()
    : 0;
  if (progress.classification && Number.isFinite(checkedAt) &&
      Date.now() - checkedAt < classificationLifetimeMs) return;

  const key = `${uid}:${progress.seriesId}`;
  if (classificationRefreshes.has(key)) return;
  const refresh = refreshClassification(uid, progress.seriesId)
    .catch((error) => console.error(
      `[classification] ${progress.seriesId}: ${error.message}`,
    ))
    .finally(() => classificationRefreshes.delete(key));
  classificationRefreshes.set(key, refresh);
}

async function refreshClassification(uid, seriesId) {
  const { rows } = await pool.query(
    `SELECT watched_episodes AS "watchedEpisodes"
     FROM show_progress WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId],
  );
  if (!rows[0]) return;

  const show = await getTvShowClassificationData(seriesId);
  const seasons = Array.isArray(show.seasons)
    ? show.seasons.filter((season) => Number(season.season_number) > 0)
    : [];
  const seasonResults = await Promise.all(
    seasons.map((season) => getTvSeason(seriesId, season.season_number)),
  );
  const watched = new Set(Array.isArray(rows[0].watchedEpisodes)
    ? rows[0].watchedEpisodes.map(String)
    : []);
  const today = new Date();
  let releasedEpisodeCount = 0;
  let watchedReleasedCount = 0;
  for (const season of seasonResults) {
    for (const episode of Array.isArray(season.episodes) ? season.episodes : []) {
      const airDate = episode.air_date ? new Date(episode.air_date) : null;
      if (!airDate || Number.isNaN(airDate.getTime()) || airDate > today) continue;
      releasedEpisodeCount += 1;
      if (watched.has(`S${season.season_number}E${episode.episode_number}`)) {
        watchedReleasedCount += 1;
      }
    }
  }

  const isEnded = ['ended', 'canceled', 'cancelled'].includes(
    String(show.status || '').toLowerCase(),
  );
  const classification = releasedEpisodeCount === 0
    ? 'unstarted'
    : watchedReleasedCount === 0
    ? 'unstarted'
    : watchedReleasedCount === releasedEpisodeCount
    ? (isEnded ? 'finished' : 'upToDate')
    : 'watching';

  await pool.query(
    `UPDATE show_progress
     SET classification=$3,classification_checked_at=NOW(),
         released_episode_count=$4,is_ended=$5,updated_at=NOW()
     WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId, classification, releasedEpisodeCount, isEnded],
  );
}

module.exports = { router };
