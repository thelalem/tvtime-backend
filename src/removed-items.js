// What the user removed, so an import run again does not bring it back (FEATURE_PLAN.md section 16): a movie taken
// off the list, a movie favorite, a show favorite. Recorded by the delete routes and cleared by the add routes;
// the app's imports read `GET /me/removed-items` first and leave these out.
const { pool } = require('./db');

async function markRemoved(uid, kind, itemId, db = pool) {
  await db.query(
    `INSERT INTO removed_items(firebase_uid, kind, item_id) VALUES ($1, $2, $3)
     ON CONFLICT (firebase_uid, kind, item_id) DO UPDATE SET removed_at = NOW()`,
    [uid, kind, itemId],
  );
}

async function clearRemoved(uid, kind, itemId, db = pool) {
  await db.query('DELETE FROM removed_items WHERE firebase_uid = $1 AND kind = $2 AND item_id = $3', [uid, kind, itemId]);
}

function registerRemovedItemsRoute(router) {
  router.get('/me/removed-items', async (request, response, next) => {
    try {
      const { rows } = await pool.query('SELECT kind, item_id FROM removed_items WHERE firebase_uid = $1', [request.user.uid]);
      const of = (kind) => rows.filter((row) => row.kind === kind).map((row) => Number(row.item_id));
      response.json({ movies: of('movie'), movieFavorites: of('movie_favorite'), favorites: of('favorite') });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { clearRemoved, markRemoved, registerRemovedItemsRoute };
