// Follow people and compare (FEATURE_PLAN.md section 19). The rules are in social-logic.js; this file is the routes and
// the database around them. Everything lives under /me/social, because that is what the sign-in check covers.
//
//   GET    /me/social                        my username, privacy, counts, a suggested username
//   GET    /me/social/username/available?name=   is it free (and valid)
//   PUT    /me/social/username               { username } claim or change it
//   PATCH  /me/social/privacy                { public: bool }; going public accepts the waiting requests
//   GET    /me/social/search?q=              usernames starting with q
//   POST   /me/social/following/:username    follow (a private profile answers `pending`)
//   DELETE /me/social/following/:username    unfollow, or take back a pending request
//   DELETE /me/social/followers/:username    remove a follower
//   GET    /me/social/following | /followers | /requests
//   POST   /me/social/requests/:username/accept   DELETE /me/social/requests/:username   (decline)
//   GET    /me/social/blocks   POST|DELETE /me/social/blocks/:username
//   GET    /me/social/users/:username        a profile: counts, the relation, and (when allowed) stats and show lists
//   GET    /me/social/users/:username/compare    you against them
//   GET    /me/social/users/:username/avatar
//
// A person who blocked you, or whom you blocked, does not exist as far as these routes can tell (404). Ratings are never
// shown to anyone else. Search, username checks and writes are rate limited.
const { pool } = require('./db');
const { loadStats } = require('./stats');
const { createRateLimiter, limitRoute } = require('./rate-limit');
const {
  canViewProfile, compare, normalizeUsername, suggestUsername, usernameProblem,
} = require('./social-logic');

const MINUTE_MS = 60 * 1000;
const SHOWS_IN_LIST = 300;
const SEARCH_RESULTS = 20;

const lookups = createRateLimiter({ limit: 30, windowMs: MINUTE_MS });
const writes = createRateLimiter({ limit: 60, windowMs: MINUTE_MS });
setInterval(() => { lookups.sweep(); writes.sweep(); }, 10 * MINUTE_MS).unref();

const handle = (fn) => async (request, response, next) => {
  try {
    await fn(request, response);
  } catch (error) {
    next(error);
  }
};

// The person with this username, or null (also for a username that is not valid).
async function findUser(db, username) {
  const name = normalizeUsername(username);
  if (!name) return null;
  const { rows } = await db.query(
    `SELECT firebase_uid AS uid, username, display_name AS "displayName", profile_public AS "isPublic"
     FROM app_users WHERE lower(username) = $1`,
    [name],
  );
  return rows[0] || null;
}

async function isBlocked(db, a, b) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM blocks WHERE (blocker_uid = $1 AND blocked_uid = $2) OR (blocker_uid = $2 AND blocked_uid = $1)`,
    [a, b],
  );
  return rowCount > 0;
}

// How `me` and `them` are connected: my follow of them (accepted, pending or none) and whether they follow me.
async function relationBetween(db, me, them) {
  const { rows } = await db.query(
    `SELECT follower_uid AS "from", status FROM follows
     WHERE (follower_uid = $1 AND followee_uid = $2) OR (follower_uid = $2 AND followee_uid = $1)`,
    [me, them],
  );
  const mine = rows.find((row) => row.from === me);
  return { following: mine ? mine.status : null, followedBy: rows.some((row) => row.from === them && row.status === 'accepted') };
}

async function counts(db, uid) {
  const { rows } = await db.query(
    `SELECT (SELECT COUNT(*) FROM follows WHERE follower_uid = $1 AND status = 'accepted')::int AS following,
            (SELECT COUNT(*) FROM follows WHERE followee_uid = $1 AND status = 'accepted')::int AS followers,
            (SELECT COUNT(*) FROM follows WHERE followee_uid = $1 AND status = 'pending')::int AS "pendingRequests"`,
    [uid],
  );
  return rows[0];
}

// The shows a person watches (the ones with progress, less those they removed), most recent first; at most [limit]
// (null: all of them, which compare needs: shows in common beyond the most recent 300 counted as not shared).
async function watchedShows(db, uid, limit) {
  const result = await db.query(
    `SELECT series_id AS id, show_name AS name, poster_path AS "posterPath", watched_count AS episodes
     FROM show_progress WHERE firebase_uid = $1 AND watched_count > 0
       AND series_id NOT IN (SELECT series_id FROM show_states WHERE firebase_uid = $1 AND state = 'removed')
     ORDER BY last_watched DESC NULLS LAST LIMIT $2`,
    [uid, limit],
  );
  return result.rows.map((row) => ({ ...row, id: Number(row.id) }));
}

// What a profile shows: the watched shows and the favorites.
async function showLists(db, uid) {
  const [shows, favoriteShows, favoriteMovies] = await Promise.all([
    watchedShows(db, uid, SHOWS_IN_LIST),
    db.query(
      `SELECT series_id AS id, series->>'name' AS name, series->>'posterPath' AS "posterPath"
       FROM favorites WHERE firebase_uid = $1 ORDER BY added_at DESC LIMIT 100`,
      [uid],
    ),
    db.query(
      `SELECT movie_id AS id, movie->>'title' AS name, movie->>'poster_path' AS "posterPath"
       FROM movie_favorites WHERE firebase_uid = $1 ORDER BY added_at DESC LIMIT 100`,
      [uid],
    ),
  ]);
  const rows = (result) => result.rows.map((row) => ({ ...row, id: Number(row.id) }));
  return { shows, favoriteShows: rows(favoriteShows), favoriteMovies: rows(favoriteMovies) };
}

// Stats as another person sees them: ratings stay private.
const publicStats = (stats) => ({ ...stats, ratings: null });

// Loads the target of a /users/:username route for `me`: null (answer 404) when they do not exist or either blocked the
// other; otherwise the person, how we are connected, and whether `me` may see their profile.
async function viewTarget(me, username) {
  const target = await findUser(pool, username);
  if (!target) return null;
  const isSelf = target.uid === me;
  if (!isSelf && await isBlocked(pool, me, target.uid)) return null;
  const relation = isSelf ? { following: null, followedBy: false } : await relationBetween(pool, me, target.uid);
  const canView = canViewProfile({
    isSelf, isPublic: target.isPublic, follows: relation.following === 'accepted',
  });
  return { target, isSelf, relation, canView };
}

function registerSocialRoutes(router, { onFollow = async () => {} } = {}) {
  const lookupLimit = limitRoute(lookups, MINUTE_MS);
  const writeLimit = limitRoute(writes, MINUTE_MS);

  router.get('/me/social', handle(async (request, response) => {
    const uid = request.user.uid;
    const { rows } = await pool.query(
      `SELECT username, profile_public AS "isPublic", display_name AS "displayName", email
       FROM app_users WHERE firebase_uid = $1`,
      [uid],
    );
    const me = rows[0] || {};
    response.json({
      username: me.username || null,
      isPublic: me.isPublic !== false,
      suggestion: me.username ? null : suggestUsername(me.displayName, me.email),
      ...await counts(pool, uid),
    });
  }));

  router.get('/me/social/username/available', lookupLimit, handle(async (request, response) => {
    const name = normalizeUsername(request.query.name);
    const problem = usernameProblem(request.query.name);
    if (problem) return response.json({ available: false, reason: problem });
    const { rows } = await pool.query(
      `SELECT firebase_uid FROM app_users WHERE lower(username) = $1
       UNION ALL SELECT firebase_uid FROM username_holds WHERE username = $1 AND released_at > NOW() - INTERVAL '14 days'`,
      [name],
    );
    if (rows.some((row) => row.firebase_uid !== request.user.uid)) {
      return response.json({ available: false, reason: 'taken' });
    }
    return response.json({ available: true, username: name });
  }));

  router.put('/me/social/username', writeLimit, handle(async (request, response) => {
    const problem = usernameProblem((request.body || {}).username);
    if (problem) return response.status(400).json({ error: problem });
    const name = normalizeUsername(request.body.username);
    const uid = request.user.uid;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Someone else gave this name up less than 14 days ago: it is still theirs.
      const held = await db.query(
        `SELECT 1 FROM username_holds
         WHERE username = $1 AND firebase_uid <> $2 AND released_at > NOW() - INTERVAL '14 days'`,
        [name, uid],
      );
      if (held.rowCount) {
        await db.query('ROLLBACK');
        return response.status(409).json({ error: 'taken' });
      }
      const before = await db.query('SELECT username FROM app_users WHERE firebase_uid = $1 FOR UPDATE', [uid]);
      if (!before.rowCount) {
        await db.query('ROLLBACK');
        return response.status(404).json({ error: 'no_account' });
      }
      await db.query('UPDATE app_users SET username = $2, updated_at = NOW() WHERE firebase_uid = $1', [uid, name]);
      const old = before.rows[0].username && before.rows[0].username.toLowerCase();
      if (old && old !== name) {
        await db.query(
          `INSERT INTO username_holds(username, firebase_uid) VALUES ($1, $2)
           ON CONFLICT (username) DO UPDATE SET firebase_uid = EXCLUDED.firebase_uid, released_at = NOW()`,
          [old, uid],
        );
      }
      // Taking a name back (or a new one) ends its hold.
      await db.query('DELETE FROM username_holds WHERE username = $1', [name]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return response.status(409).json({ error: 'taken' });
      throw error;
    } finally {
      db.release();
    }
    return response.json({ username: name });
  }));

  router.patch('/me/social/privacy', writeLimit, handle(async (request, response) => {
    const isPublic = (request.body || {}).public;
    if (typeof isPublic !== 'boolean') return response.status(400).json({ error: 'invalid_privacy' });
    const uid = request.user.uid;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('UPDATE app_users SET profile_public = $2, updated_at = NOW() WHERE firebase_uid = $1', [uid, isPublic]);
      // Going public: whoever was waiting is let in.
      if (isPublic) await db.query(`UPDATE follows SET status = 'accepted' WHERE followee_uid = $1 AND status = 'pending'`, [uid]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
    response.json({ isPublic });
  }));

  router.get('/me/social/search', lookupLimit, handle(async (request, response) => {
    const query = String(request.query.q || '').trim().replace(/^@/, '').toLowerCase();
    if (query.length < 2 || query.length > 20) return response.json({ results: [] });
    const like = `${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const { rows } = await pool.query(
      `SELECT u.username, u.display_name AS "displayName", f.status AS following,
              (r.follower_uid IS NOT NULL) AS "followedBy"
       FROM app_users u
       LEFT JOIN follows f ON f.follower_uid = $1 AND f.followee_uid = u.firebase_uid
       LEFT JOIN follows r ON r.followee_uid = $1 AND r.follower_uid = u.firebase_uid AND r.status = 'accepted'
       WHERE lower(u.username) LIKE $2 ESCAPE '\\' AND u.firebase_uid <> $1
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_uid = $1 AND b.blocked_uid = u.firebase_uid)
                                                   OR (b.blocker_uid = u.firebase_uid AND b.blocked_uid = $1))
       ORDER BY lower(u.username) LIMIT $3`,
      [request.user.uid, like, SEARCH_RESULTS],
    );
    response.json({ results: rows });
  }));

  // --- follow, unfollow, remove a follower --------------------------------------------------------------------
  router.post('/me/social/following/:username', writeLimit, handle(async (request, response) => {
    const me = request.user.uid;
    const [target, mine] = await Promise.all([
      findUser(pool, request.params.username),
      pool.query('SELECT username FROM app_users WHERE firebase_uid = $1', [me]),
    ]);
    if (!target || await isBlocked(pool, me, target.uid)) return response.status(404).json({ error: 'not_found' });
    if (target.uid === me) return response.status(400).json({ error: 'cannot_follow_yourself' });
    // Follower lists and requests show people by username: a follow from someone without one was counted (a request
    // dot) but could never be seen, accepted or declined.
    if (!mine.rows[0] || !mine.rows[0].username) return response.status(409).json({ error: 'username_required' });
    // The block check is part of the insert: checked apart from it, a block made in between left the follow in place.
    const { rows } = await pool.query(
      `INSERT INTO follows(follower_uid, followee_uid, status)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM blocks WHERE (blocker_uid = $1 AND blocked_uid = $2)
                                                OR (blocker_uid = $2 AND blocked_uid = $1))
       ON CONFLICT (follower_uid, followee_uid) DO NOTHING RETURNING status`,
      [me, target.uid, target.isPublic ? 'accepted' : 'pending'],
    );
    if (rows.length) {
      // A new follow (not a repeat of one already there): the person hears about it, without the reply waiting on
      // the push service.
      onFollow({ followerUid: me, followeeUid: target.uid, status: rows[0].status })
        .catch((error) => console.error(`[social] follow push failed: ${error.message}`));
      return response.status(201).json({ status: rows[0].status });
    }
    const current = await relationBetween(pool, me, target.uid);
    if (!current.following) return response.status(404).json({ error: 'not_found' }); // blocked meanwhile
    return response.json({ status: current.following });
  }));

  router.delete('/me/social/following/:username', writeLimit, handle(async (request, response) => {
    const target = await findUser(pool, request.params.username);
    if (target) {
      await pool.query('DELETE FROM follows WHERE follower_uid = $1 AND followee_uid = $2', [request.user.uid, target.uid]);
    }
    response.status(204).end();
  }));

  router.delete('/me/social/followers/:username', writeLimit, handle(async (request, response) => {
    const target = await findUser(pool, request.params.username);
    if (target) {
      await pool.query('DELETE FROM follows WHERE follower_uid = $1 AND followee_uid = $2', [target.uid, request.user.uid]);
    }
    response.status(204).end();
  }));

  const listOf = (column, other, status) => handle(async (request, response) => {
    const { rows } = await pool.query(
      `SELECT u.username, u.display_name AS "displayName", f.created_at AS since,
              EXISTS (SELECT 1 FROM follows back WHERE back.follower_uid = $1 AND back.followee_uid = u.firebase_uid
                      AND back.status = 'accepted') AS "followedByYou"
       FROM follows f JOIN app_users u ON u.firebase_uid = f.${other}
       WHERE f.${column} = $1 AND f.status = '${status}' AND u.username IS NOT NULL
       ORDER BY f.created_at DESC LIMIT 500`,
      [request.user.uid],
    );
    response.json({ people: rows });
  });
  router.get('/me/social/following', listOf('follower_uid', 'followee_uid', 'accepted'));
  router.get('/me/social/followers', listOf('followee_uid', 'follower_uid', 'accepted'));
  router.get('/me/social/requests', listOf('followee_uid', 'follower_uid', 'pending'));

  router.post('/me/social/requests/:username/accept', writeLimit, handle(async (request, response) => {
    const target = await findUser(pool, request.params.username);
    if (!target) return response.status(404).json({ error: 'not_found' });
    const { rowCount } = await pool.query(
      `UPDATE follows SET status = 'accepted' WHERE follower_uid = $1 AND followee_uid = $2 AND status = 'pending'`,
      [target.uid, request.user.uid],
    );
    if (!rowCount) return response.status(404).json({ error: 'no_request' });
    return response.json({ status: 'accepted' });
  }));

  router.delete('/me/social/requests/:username', writeLimit, handle(async (request, response) => {
    const target = await findUser(pool, request.params.username);
    if (target) {
      await pool.query(
        `DELETE FROM follows WHERE follower_uid = $1 AND followee_uid = $2 AND status = 'pending'`,
        [target.uid, request.user.uid],
      );
    }
    response.status(204).end();
  }));

  // --- blocks ---------------------------------------------------------------------------------------------------
  router.get('/me/social/blocks', handle(async (request, response) => {
    const { rows } = await pool.query(
      `SELECT u.username, u.display_name AS "displayName" FROM blocks b
       JOIN app_users u ON u.firebase_uid = b.blocked_uid WHERE b.blocker_uid = $1 AND u.username IS NOT NULL
       ORDER BY b.created_at DESC`,
      [request.user.uid],
    );
    response.json({ people: rows });
  }));

  router.post('/me/social/blocks/:username', writeLimit, handle(async (request, response) => {
    const me = request.user.uid;
    const target = await findUser(pool, request.params.username);
    if (!target) return response.status(404).json({ error: 'not_found' });
    if (target.uid === me) return response.status(400).json({ error: 'cannot_block_yourself' });
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO blocks(blocker_uid, blocked_uid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, target.uid]);
      await db.query(
        `DELETE FROM follows WHERE (follower_uid = $1 AND followee_uid = $2) OR (follower_uid = $2 AND followee_uid = $1)`,
        [me, target.uid],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
    response.status(204).end();
  }));

  router.delete('/me/social/blocks/:username', writeLimit, handle(async (request, response) => {
    const target = await findUser(pool, request.params.username);
    if (target) await pool.query('DELETE FROM blocks WHERE blocker_uid = $1 AND blocked_uid = $2', [request.user.uid, target.uid]);
    response.status(204).end();
  }));

  // --- another person's profile and the comparison ---------------------------------------------------------------
  router.get('/me/social/users/:username', lookupLimit, handle(async (request, response) => {
    const seen = await viewTarget(request.user.uid, request.params.username);
    if (!seen) return response.status(404).json({ error: 'not_found' });
    const { target, isSelf, relation, canView } = seen;
    const body = {
      username: target.username,
      displayName: target.displayName,
      isPublic: target.isPublic,
      isSelf,
      relation,
      canView,
      ...await counts(pool, target.uid),
    };
    delete body.pendingRequests; // only the person themselves knows how many are waiting
    if (canView) {
      body.stats = publicStats(await loadStats(target.uid));
      Object.assign(body, await showLists(pool, target.uid));
    }
    response.json(body);
  }));

  router.get('/me/social/users/:username/compare', lookupLimit, handle(async (request, response) => {
    const me = request.user.uid;
    const seen = await viewTarget(me, request.params.username);
    if (!seen) return response.status(404).json({ error: 'not_found' });
    if (seen.isSelf) return response.status(400).json({ error: 'cannot_compare_yourself' });
    if (!seen.canView) return response.status(403).json({ error: 'private' });
    const [myStats, theirStats, myShows, theirShows] = await Promise.all([
      loadStats(me), loadStats(seen.target.uid), watchedShows(pool, me, null), watchedShows(pool, seen.target.uid, null),
    ]);
    response.json({
      username: seen.target.username,
      displayName: seen.target.displayName,
      approximate: Boolean(myStats.approximate || theirStats.approximate),
      ...compare({ myStats, theirStats, myShows, theirShows }),
    });
  }));

  router.get('/me/social/users/:username/avatar', handle(async (request, response) => {
    const seen = await viewTarget(request.user.uid, request.params.username);
    if (!seen || !seen.canView) return response.status(404).end();
    const { rows } = await pool.query(
      'SELECT avatar, avatar_content_type FROM app_users WHERE firebase_uid = $1', [seen.target.uid],
    );
    if (!rows[0] || !rows[0].avatar) return response.status(404).end();
    response.set('Content-Type', rows[0].avatar_content_type || 'image/jpeg');
    response.set('Cache-Control', 'private, max-age=300');
    return response.send(rows[0].avatar);
  }));
}

module.exports = { registerSocialRoutes };
