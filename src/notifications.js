// New-episode push notifications (FEATURE_PLAN.md section 7).
//
// The app uploads its FCM token (PUT /me/devices). A sweep every few minutes looks at each user
// who has a token and notifications on, and for every episode of a show they follow that airs on
// their local date, once their local morning has started, sends one push through Firebase Cloud
// Messaging. `notifications_sent` makes each (user, episode) go out at most once.
const { pool } = require('./db');
const { localDateString, localHour, zonedDateTimeToUtc } = require('./local-date');

// Shows with no air time (every streaming show) are announced at this local hour on the air date.
const FALLBACK_HOUR = 9;
// A push goes out when its moment has passed, for this long afterwards (a restart, a failed send).
const CATCH_UP_MS = 24 * 60 * 60 * 1000;
// Local hours [SILENT_FROM, 24) and [0, SILENT_UNTIL) are delivered without sound.
const SILENT_FROM = 23;
const SILENT_UNTIL = 7;
const POSTER_BASE = 'https://image.tmdb.org/t/p/w185';
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

// When TVMaze could not be asked, the latest a push waits for it on the air date (user's zone).
const UNANSWERED_FALLBACK_HOUR = 21;

// When this episode should be announced: its air time in the network's zone when TVMaze knows
// both, otherwise FALLBACK_HOUR on the air date in the user's own zone. When TVMaze did not answer
// (slow or down) the air time is not known to be missing, so the push waits, worked out again at
// every sweep, until UNANSWERED_FALLBACK_HOUR: a 9 p.m. episode used to go out at 9 a.m.
function announceAt(item, userTimeZone) {
  const airDate = item.episode?.airDate;
  const fallbackHour = item.tvMazeAnswered === false ? UNANSWERED_FALLBACK_HOUR : FALLBACK_HOUR;
  return zonedDateTimeToUtc(airDate, item.airTime, item.timezone)
    || zonedDateTimeToUtc(airDate, `${fallbackHour}:00`, userTimeZone || 'UTC');
}

function episodeLabel(season, episode) {
  const two = (n) => String(n).padStart(2, '0');
  return `S${two(season)} | E${two(episode)}`;
}

// The real sender. Loaded lazily so tests (and a server without Firebase set up) never touch it.
// Resolves to the tokens FCM says are dead, which the caller deletes.
async function sendThroughFcm(tokens, { title, body, data, tag, silent, imageUrl, posterPath, backdropPath }) {
  const { admin } = require('./firebase');
  const result = await admin.messaging().sendEachForMulticast({
    tokens,
    // Data only: the app draws the notification itself (EpisodeMessagingService.kt), so the poster
    // is a small image and the notification does not expand. A push Firebase draws with an image
    // is always the expandable big-picture kind.
    data: {
      ...data,
      title,
      body,
      tag,
      silent: silent ? '1' : '0',
      ...(imageUrl ? { imageUrl } : {}),
      // So the show page can draw its header at once, before its own details have loaded.
      ...(posterPath ? { posterPath } : {}),
      ...(backdropPath ? { backdropPath } : {}),
    },
    android: { priority: 'high' },
  });
  const dead = [];
  let delivered = 0;
  result.responses.forEach((item, index) => {
    if (item.success) { delivered += 1; return; }
    if (INVALID_TOKEN_CODES.has(item.error?.code)) dead.push(tokens[index]);
  });
  // Nothing delivered and nothing proven dead: a transient failure, so let the caller retry later.
  if (!delivered && !dead.length) {
    throw new Error(result.responses.find((item) => item.error)?.error?.message || 'FCM send failed');
  }
  return dead;
}

// One pass over every user. `getUpcoming`, `send` and `now` are parameters so tests can drive it.
async function runNotificationSweep({
  db = pool,
  getUpcoming = (args) => require('./upcoming').getUpcomingEpisodes(args),
  send = sendThroughFcm,
  now = new Date(),
} = {}) {
  const { rows: users } = await db.query(
    `SELECT u.firebase_uid AS uid, u.timezone FROM app_users u
     WHERE u.notifications_enabled
       AND EXISTS (SELECT 1 FROM device_tokens d WHERE d.firebase_uid = u.firebase_uid)`,
  );
  let sent = 0;
  for (const user of users) {
    try {
      sent += await notifyUser(db, user, { getUpcoming, send, now });
    } catch (error) {
      console.error(`[notifications] ${user.uid}: ${error.message}`);
    }
  }
  return sent;
}

async function notifyUser(db, user, { getUpcoming, send, now }) {
  // Asked from yesterday: an episode that aired late yesterday in the network's zone can be
  // due only now in the user's.
  const yesterday = localDateString(user.timezone, new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const upcoming = await getUpcoming({ uid: user.uid, today: yesterday, pool: db });
  const airing = upcoming.filter((item) => {
    const at = announceAt(item, user.timezone);
    return at && at <= now && now.getTime() - at.getTime() < CATCH_UP_MS;
  });
  if (!airing.length) return 0;
  const hour = localHour(user.timezone, now);
  const silent = hour >= SILENT_FROM || hour < SILENT_UNTIL;

  const [muted, progress, tokens] = await Promise.all([
    db.query('SELECT series_id FROM muted_shows WHERE firebase_uid=$1', [user.uid]),
    db.query('SELECT series_id, watched_episodes FROM show_progress WHERE firebase_uid=$1', [user.uid]),
    db.query('SELECT token FROM device_tokens WHERE firebase_uid=$1', [user.uid]),
  ]);
  const mutedIds = new Set(muted.rows.map((row) => Number(row.series_id)));
  const watched = new Map(progress.rows.map((row) => [
    Number(row.series_id),
    new Set(Array.isArray(row.watched_episodes) ? row.watched_episodes.map(String) : []),
  ]));
  const deviceTokens = tokens.rows.map((row) => row.token);
  if (!deviceTokens.length) return 0;

  let count = 0;
  for (const item of airing) {
    const seriesId = Number(item.seriesId);
    const season = Number(item.episode.seasonNumber);
    const episode = Number(item.episode.episodeNumber);
    if (mutedIds.has(seriesId) || !(season > 0) || !(episode > 0)) continue;
    if (watched.get(seriesId)?.has(`S${season}E${episode}`)) continue;

    // Claim first, so two overlapping sweeps cannot both send it.
    const claim = await db.query(
      `INSERT INTO notifications_sent(firebase_uid, series_id, season, episode)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`,
      [user.uid, seriesId, season, episode],
    );
    if (!claim.rowCount) continue;

    try {
      const dead = await send(deviceTokens, {
        title: item.seriesName,
        body: episodeLabel(season, episode),
        data: { type: 'new_episode', seriesId: String(seriesId), season: String(season), episode: String(episode) },
        tag: `episode-${seriesId}-${season}-${episode}`,
        silent,
        posterPath: item.posterPath || undefined,
        backdropPath: item.series?.backdropPath || undefined,
        imageUrl: item.posterPath ? `${POSTER_BASE}${item.posterPath}` : undefined,
      });
      if (dead?.length) await db.query('DELETE FROM device_tokens WHERE token = ANY($1)', [dead]);
      count += 1;
    } catch (error) {
      // Release the claim so the next sweep tries again.
      await db.query(
        'DELETE FROM notifications_sent WHERE firebase_uid=$1 AND series_id=$2 AND season=$3 AND episode=$4',
        [user.uid, seriesId, season, episode],
      );
      console.error(`[notifications] send failed for ${user.uid}: ${error.message}`);
    }
  }
  return count;
}

let sweeping = false;
function startNotificationSweeps() {
  if (process.env.NOTIFICATIONS_DISABLED === '1') {
    console.log('[notifications] disabled by NOTIFICATIONS_DISABLED=1');
    return;
  }
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const sent = await runNotificationSweep();
      if (sent) console.log(`[notifications] sent ${sent}`);
    } catch (error) {
      console.error(`[notifications] sweep failed: ${error.message}`);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, SWEEP_INTERVAL_MS).unref();
}

function parseSeriesId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function registerNotificationRoutes(router) {
  // The app uploads its FCM token on start, whenever FCM rotates it, and after the user allows
  // notifications.
  router.put('/me/devices', async (request, response, next) => {
    const { token, platform } = request.body || {};
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
      return response.status(400).json({ error: 'invalid_token' });
    }
    const os = platform === 'ios' ? 'ios' : 'android';
    try {
      await pool.query(
        `INSERT INTO device_tokens(token, firebase_uid, platform) VALUES ($1,$2,$3)
         ON CONFLICT(token) DO UPDATE
         SET firebase_uid=EXCLUDED.firebase_uid, platform=EXCLUDED.platform, updated_at=NOW()`,
        [token, request.user.uid, os],
      );
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Sign-out: this phone stops receiving this account's notifications.
  router.delete('/me/devices', async (request, response, next) => {
    const token = request.body?.token || request.query.token;
    if (typeof token !== 'string' || !token) return response.status(400).json({ error: 'invalid_token' });
    try {
      await pool.query('DELETE FROM device_tokens WHERE token=$1 AND firebase_uid=$2', [token, request.user.uid]);
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/me/notification-settings', async (request, response, next) => {
    try {
      const uid = request.user.uid;
      const [user, muted] = await Promise.all([
        pool.query('SELECT notifications_enabled AS enabled FROM app_users WHERE firebase_uid=$1', [uid]),
        pool.query(
          'SELECT series_id, name, poster_path FROM muted_shows WHERE firebase_uid=$1 ORDER BY series_id',
          [uid],
        ),
      ]);
      response.json({
        enabled: user.rows[0]?.enabled ?? true,
        mutedShows: muted.rows.map((row) => Number(row.series_id)),
        muted: muted.rows.map((row) => ({
          id: Number(row.series_id),
          name: row.name || null,
          posterPath: row.poster_path || null,
        })),
      });
    } catch (error) { next(error); }
  });

  router.patch('/me/notification-settings', async (request, response, next) => {
    const { enabled } = request.body || {};
    if (typeof enabled !== 'boolean') return response.status(400).json({ error: 'invalid_enabled' });
    try {
      await pool.query('UPDATE app_users SET notifications_enabled=$2 WHERE firebase_uid=$1',
        [request.user.uid, enabled]);
      response.json({ enabled });
    } catch (error) { next(error); }
  });

  router.put('/me/notification-settings/muted/:seriesId', async (request, response, next) => {
    const seriesId = parseSeriesId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    try {
      // The body (optional) is the show, kept so the Muted shows list can draw it.
      const name = typeof request.body?.name === 'string' ? request.body.name.slice(0, 200) : null;
      const poster = typeof request.body?.posterPath === 'string' ? request.body.posterPath.slice(0, 200) : null;
      await pool.query(
        `INSERT INTO muted_shows(firebase_uid, series_id, name, poster_path) VALUES ($1,$2,$3,$4)
         ON CONFLICT(firebase_uid, series_id) DO UPDATE
         SET name=COALESCE(EXCLUDED.name, muted_shows.name),
             poster_path=COALESCE(EXCLUDED.poster_path, muted_shows.poster_path)`,
        [request.user.uid, seriesId, name, poster],
      );
      response.json({ muted: true });
    } catch (error) { next(error); }
  });

  router.delete('/me/notification-settings/muted/:seriesId', async (request, response, next) => {
    const seriesId = parseSeriesId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    try {
      await pool.query('DELETE FROM muted_shows WHERE firebase_uid=$1 AND series_id=$2',
        [request.user.uid, seriesId]);
      response.json({ muted: false });
    } catch (error) { next(error); }
  });
}

module.exports = { registerNotificationRoutes, runNotificationSweep, startNotificationSweeps };
