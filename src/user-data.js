const express = require('express');
const { admin } = require('./firebase');
const { pool } = require('./db');
const { getTvSeason, getTvShowClassificationData } = require('./tmdb');

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

router.post('/me/refresh-classifications', async (request, response, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT series_id AS "seriesId", classification,
              classification_checked_at AS "classificationCheckedAt"
       FROM show_progress WHERE firebase_uid=$1
       ORDER BY classification_checked_at ASC NULLS FIRST`,
      [request.user.uid],
    );
    // Stalest first, so successive pulls work through a large library instead
    // of re-doing the same leading shows until the budget runs out.
    const due = rows.filter(
      (row) => !isClassificationFresh(row, classificationDebounceMs),
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
    response.status(204).end();
  } catch (error) { next(error); }
});

function collectionTable(name) {
  return name === 'watchlist' || name === 'favorites' ? name : null;
}

function isClassificationFresh(progress, maxAgeMs) {
  if (!progress.classification) return false;
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
  const { rows } = await pool.query(
    `SELECT firebase_uid AS uid, series_id AS "seriesId"
     FROM show_progress
     WHERE classification IS NULL
        OR classification_checked_at IS NULL
        OR classification_checked_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
     ORDER BY classification_checked_at ASC NULLS FIRST`,
    [classificationLifetimeMs],
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
            w.series AS "watchlistSeries"
     FROM show_progress p
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
         released_episode_count=$4,is_ended=$5
     WHERE firebase_uid=$1 AND series_id=$2`,
    [uid, seriesId, classification, releasedEpisodeCount, isEnded],
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
