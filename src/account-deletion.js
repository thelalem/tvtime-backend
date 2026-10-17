// Deleting an account (FEATURE_PLAN.md section 19), as decided with the user: a request locks the account and
// it is deleted 30 days later unless the user signs in and cancels.
//
//   POST /me/account/delete-request   needs a sign-in from the last 10 minutes (the app asks for the password
//                                     again; the web page signs in fresh). -> { deletionRequestedAt, deleteAfter }
//   POST /me/account/cancel-deletion  -> { deletionRequestedAt: null }
//
// While a deletion is pending every other /me route answers 403 `account_pending_deletion` (so another phone
// still signed in cannot keep using the account), except reading /me and removing a device. The request
// removes the account's push tokens, so no phone gets notifications meanwhile; cancelling lets the app
// register its token again on its next start.
//
// The daily clean-up (cleanup.js) calls deleteDueAccounts: the Firebase sign-in first, then the server data
// (every per-user table cascades from app_users). A Firebase failure leaves the row for the next day.
const { pool } = require('./db');

const GRACE_DAYS = 30;
const RECENT_SIGN_IN_SECONDS = 10 * 60;

function deleteAfter(requestedAt) {
  if (!requestedAt) return null;
  return new Date(new Date(requestedAt).getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// What a pending account may still do.
function allowedWhilePending(method, path) {
  return (method === 'GET' && path === '/me') ||
    (method === 'POST' && (path === '/me/account/cancel-deletion' || path === '/me/account/delete-request')) ||
    (method === 'DELETE' && path === '/me/devices');
}

function registerAccountRoutes(router) {
  router.post('/me/account/delete-request', async (request, response, next) => {
    const authTime = Number(request.user.authTime);
    if (!Number.isFinite(authTime) || Date.now() / 1000 - authTime > RECENT_SIGN_IN_SECONDS) {
      return response.status(401).json({ error: 'recent_sign_in_required' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE app_users SET deletion_requested_at = COALESCE(deletion_requested_at, NOW())
         WHERE firebase_uid = $1 RETURNING deletion_requested_at AS at`,
        [request.user.uid],
      );
      await pool.query('DELETE FROM device_tokens WHERE firebase_uid = $1', [request.user.uid]);
      const at = rows[0] && rows[0].at;
      response.json({ deletionRequestedAt: at, deleteAfter: deleteAfter(at) });
    } catch (error) { next(error); }
  });

  router.post('/me/account/cancel-deletion', async (request, response, next) => {
    try {
      await pool.query('UPDATE app_users SET deletion_requested_at = NULL WHERE firebase_uid = $1', [request.user.uid]);
      response.json({ deletionRequestedAt: null, deleteAfter: null });
    } catch (error) { next(error); }
  });
}

// Deletes the accounts whose 30 days are up. [auth] is firebase-admin's auth (replaced in tests).
async function deleteDueAccounts({ db = pool, auth } = {}) {
  const firebaseAuth = auth || require('./firebase').admin.auth();
  const { rows } = await db.query(
    `SELECT firebase_uid AS uid FROM app_users
     WHERE deletion_requested_at < NOW() - make_interval(days => $1)`,
    [GRACE_DAYS],
  );
  let deleted = 0;
  for (const { uid } of rows) {
    try {
      await firebaseAuth.deleteUser(uid);
    } catch (error) {
      if (!error || error.code !== 'auth/user-not-found') {
        console.error(`[account] could not delete the sign-in of ${uid}: ${error && error.message}`);
        continue;
      }
    }
    // Checked again here: a cancel that came in meanwhile wins.
    const result = await db.query(
      `DELETE FROM app_users WHERE firebase_uid = $1
       AND deletion_requested_at < NOW() - make_interval(days => $2)`,
      [uid, GRACE_DAYS],
    );
    deleted += result.rowCount;
  }
  return deleted;
}

module.exports = {
  GRACE_DAYS, RECENT_SIGN_IN_SECONDS, allowedWhilePending, deleteAfter, deleteDueAccounts, registerAccountRoutes,
};
