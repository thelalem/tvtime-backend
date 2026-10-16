// What a user records about one episode besides watching it (FEATURE_PLAN.md section 9).
//
// The first version holds a star rating, 1 to 5 (Bad, OK, Good, Great, Wow). The later answers
// ("how did you feel", "who was your favorite", "how did you watch") are further columns of the same
// row, so they need no new table. The watch itself stays in show_progress; this table never says
// whether an episode was watched.
const { pool } = require('./db');
const { invalidateRecommendations } = require('./recommendations');

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) && number >= 0 && number < 10000 ? number : null;
}

function registerEpisodeDataRoutes(router) {
  // Every rating the user gave to one show's episodes, keyed like the progress rows ('S1E2').
  router.get('/me/shows/:seriesId/episode-ratings', async (request, response, next) => {
    const seriesId = parseId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    try {
      const { rows } = await pool.query(
        `SELECT season, episode, rating FROM episode_user_data
         WHERE firebase_uid=$1 AND series_id=$2 AND rating IS NOT NULL`,
        [request.user.uid, seriesId],
      );
      const ratings = {};
      for (const row of rows) ratings[`S${row.season}E${row.episode}`] = row.rating;
      response.json({ ratings });
    } catch (error) { next(error); }
  });

  router.put('/me/shows/:seriesId/episodes/:season/:episode/rating', async (request, response, next) => {
    const seriesId = parseId(request.params.seriesId);
    const season = parseNumber(request.params.season);
    const episode = parseNumber(request.params.episode);
    if (!seriesId || season === null || episode === null) {
      return response.status(400).json({ error: 'invalid_episode' });
    }
    const rating = request.body?.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return response.status(400).json({ error: 'invalid_rating' });
    }
    try {
      await pool.query(
        `INSERT INTO episode_user_data(firebase_uid, series_id, season, episode, rating)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(firebase_uid, series_id, season, episode)
         DO UPDATE SET rating=EXCLUDED.rating, updated_at=NOW()`,
        [request.user.uid, seriesId, season, episode, rating],
      );
      invalidateRecommendations(request.user.uid);
      response.json({ rating });
    } catch (error) { next(error); }
  });

  // Clearing a rating. The row goes only when nothing else is recorded on it.
  router.delete('/me/shows/:seriesId/episodes/:season/:episode/rating', async (request, response, next) => {
    const seriesId = parseId(request.params.seriesId);
    const season = parseNumber(request.params.season);
    const episode = parseNumber(request.params.episode);
    if (!seriesId || season === null || episode === null) {
      return response.status(400).json({ error: 'invalid_episode' });
    }
    try {
      await pool.query(
        `UPDATE episode_user_data SET rating=NULL, updated_at=NOW()
         WHERE firebase_uid=$1 AND series_id=$2 AND season=$3 AND episode=$4`,
        [request.user.uid, seriesId, season, episode],
      );
      await pool.query(
        `DELETE FROM episode_user_data
         WHERE firebase_uid=$1 AND series_id=$2 AND season=$3 AND episode=$4 AND rating IS NULL`,
        [request.user.uid, seriesId, season, episode],
      );
      invalidateRecommendations(request.user.uid);
      response.json({ rating: null });
    } catch (error) { next(error); }
  });
}

module.exports = { registerEpisodeDataRoutes };
