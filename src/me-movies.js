const { pool } = require('./db');
const { getMovie, withImdbRatings } = require('./tmdb');
const { localDateString } = require('./local-date');

// The calendar day after `date` (YYYY-MM-DD).
function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
const {
  getMovieRecommendationsFor,
  invalidateMovieRecommendations,
} = require('./movie-recommendations');
const { collectionOf, getUpcomingSequels, invalidateUpcomingSequels } = require('./sequels');

// A user's movies: the movie watchlist (a watched movie is always on it, watched is just a date on
// the row), favorites, "Movies for you" and the numbers for the profile. See FEATURE_PLAN.md,
// section 4, for the rules these routes implement.
//
// Registered on the user-data router right after its sign-in check, and before its generic
// `/me/:collection/:seriesId` routes, which would otherwise answer these paths with a 404.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // An impossible date such as 2020-13-01 parses to an Invalid Date, which cannot be formatted;
  // one such as 2020-02-30 rolls over to another day, so it no longer matches what was sent.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// What is stored for a movie: TMDB's own list-item shape (so the app reads it like any movie
// list), plus the runtime the profile's "Movie time" needs and the genres recommendations use.
function compactMovie(movie) {
  return {
    id: movie.id,
    title: movie.title || movie.original_title || '',
    overview: movie.overview || '',
    poster_path: movie.poster_path || null,
    backdrop_path: movie.backdrop_path || null,
    vote_average: Number(movie.vote_average) || 0,
    release_date: movie.release_date || '',
    runtime: Number.isFinite(movie.runtime) ? movie.runtime : null,
    genre_ids: (movie.genres || []).map((genre) => genre.id),
    // The series it belongs to, or null: what Upcoming sequels are looked up from.
    collection: collectionOf(movie),
  };
}

// What changes when a movie is added, removed, ticked or favorited.
function invalidateMovieCaches(uid) {
  invalidateMovieRecommendations(uid);
  invalidateUpcomingSequels(uid);
}

function toResponse(row) {
  return { ...row.data, addedAt: row.addedAt, watchedOn: row.watchedOn };
}

class MovieNotFound extends Error {}

// The movie as TMDB has it. The server fetches it instead of trusting a client-sent copy, because
// the release date decides whether a movie can be ticked and the runtime feeds the stats.
async function loadMovie(movieId) {
  try {
    return compactMovie(await getMovie(movieId));
  } catch (error) {
    if (error.providerStatus === 404) throw new MovieNotFound();
    throw error;
  }
}

async function userToday(uid) {
  const { rows } = await pool.query(
    'SELECT timezone FROM app_users WHERE firebase_uid = $1',
    [uid],
  );
  return localDateString(rows[0] && rows[0].timezone);
}

function registerMeMovieRoutes(router) {
  router.param('movieId', (_request, response, next, value) => {
    if (/^[1-9]\d{0,9}$/.test(value)) return next();
    return response.status(400).json({ error: 'invalid_movie_id' });
  });

  // Turns a thrown MovieNotFound into the 404 the app expects; anything else goes to the error
  // handler like the other routes.
  const handle = (run) => async (request, response, next) => {
    try {
      await run(request, response);
    } catch (error) {
      if (error instanceof MovieNotFound) {
        return response.status(404).json({ error: 'movie_not_found' });
      }
      return next(error);
    }
    return undefined;
  };

  const SELECT_ROW = `SELECT movie AS data, added_at AS "addedAt",
    to_char(watched_on, 'YYYY-MM-DD') AS "watchedOn"`;

  // --- watchlist ---------------------------------------------------------------------------

  router.get('/me/movies/watchlist', handle(async (request, response) => {
    const { rows } = await pool.query(
      `${SELECT_ROW} FROM movie_watchlist WHERE firebase_uid = $1 ORDER BY added_at DESC`,
      [request.user.uid],
    );
    response.json(rows.map(toResponse));
  }));

  // Adding is idempotent: adding a movie that is already there only refreshes its stored copy and
  // keeps its added date and watched date.
  router.put('/me/movies/watchlist/:movieId', handle(async (request, response) => {
    const movie = await loadMovie(request.params.movieId);
    const { rows } = await pool.query(
      `INSERT INTO movie_watchlist(firebase_uid, movie_id, movie) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (firebase_uid, movie_id) DO UPDATE SET movie = EXCLUDED.movie
       RETURNING movie AS data, added_at AS "addedAt",
                 to_char(watched_on, 'YYYY-MM-DD') AS "watchedOn"`,
      [request.user.uid, movie.id, JSON.stringify(movie)],
    );
    invalidateMovieCaches(request.user.uid);
    response.json(toResponse(rows[0]));
  }));

  // A clean wipe: the row goes, and the watched date goes with it. (The app asks the user to
  // confirm first.) Favorites are a separate list and are left alone.
  router.delete('/me/movies/watchlist/:movieId', handle(async (request, response) => {
    await pool.query(
      'DELETE FROM movie_watchlist WHERE firebase_uid = $1 AND movie_id = $2',
      [request.user.uid, request.params.movieId],
    );
    invalidateMovieCaches(request.user.uid);
    response.status(204).end();
  }));

  // --- watched -----------------------------------------------------------------------------

  // Ticking a movie. Adds it to the watchlist if it is not there. `date` is the day the user
  // chose (today, the release date or a custom day); it cannot be in the future, and a movie that
  // has not been released yet cannot be ticked at all.
  router.put('/me/movies/watchlist/:movieId/watched', handle(async (request, response) => {
    const date = (request.body || {}).date;
    if (!isRealDate(date)) {
      return response.status(400).json({ error: 'invalid_date' });
    }
    // One day of slack, as the episode route allows: the zone on file can lag the
    // phone's (a new account, a failed report), and just after midnight in
    // UTC+3 the phone's today was refused as "in the future", for ticks and
    // for Trakt imports alike.
    const latest = nextDay(await userToday(request.user.uid));
    if (date > latest) {
      return response.status(400).json({ error: 'date_in_future' });
    }

    const movie = await loadMovie(request.params.movieId);
    // No release date on record is not treated as unreleased; TMDB lacks one for some old titles.
    if (movie.release_date && movie.release_date > latest) {
      return response.status(409).json({ error: 'not_released', releaseDate: movie.release_date });
    }

    const { rows } = await pool.query(
      `INSERT INTO movie_watchlist(firebase_uid, movie_id, movie, watched_on)
       VALUES ($1, $2, $3::jsonb, $4::date)
       ON CONFLICT (firebase_uid, movie_id)
       DO UPDATE SET movie = EXCLUDED.movie, watched_on = EXCLUDED.watched_on
       RETURNING movie AS data, added_at AS "addedAt",
                 to_char(watched_on, 'YYYY-MM-DD') AS "watchedOn"`,
      [request.user.uid, movie.id, JSON.stringify(movie), date],
    );
    invalidateMovieCaches(request.user.uid);
    return response.json(toResponse(rows[0]));
  }));

  // Un-ticking: the movie stays on the watchlist as not watched, and its date is cleared.
  router.delete('/me/movies/watchlist/:movieId/watched', handle(async (request, response) => {
    const { rows } = await pool.query(
      `UPDATE movie_watchlist SET watched_on = NULL
       WHERE firebase_uid = $1 AND movie_id = $2
       RETURNING movie AS data, added_at AS "addedAt",
                 to_char(watched_on, 'YYYY-MM-DD') AS "watchedOn"`,
      [request.user.uid, request.params.movieId],
    );
    if (!rows.length) return response.status(404).json({ error: 'not_in_watchlist' });
    invalidateMovieCaches(request.user.uid);
    return response.json(toResponse(rows[0]));
  }));

  // --- favorites ---------------------------------------------------------------------------

  router.get('/me/movies/favorites', handle(async (request, response) => {
    const { rows } = await pool.query(
      `SELECT movie AS data, added_at AS "addedAt", NULL::text AS "watchedOn"
       FROM movie_favorites WHERE firebase_uid = $1 ORDER BY added_at DESC`,
      [request.user.uid],
    );
    response.json(rows.map(toResponse));
  }));

  router.put('/me/movies/favorites/:movieId', handle(async (request, response) => {
    const movie = await loadMovie(request.params.movieId);
    const { rows } = await pool.query(
      `INSERT INTO movie_favorites(firebase_uid, movie_id, movie) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (firebase_uid, movie_id) DO UPDATE SET movie = EXCLUDED.movie
       RETURNING movie AS data, added_at AS "addedAt", NULL::text AS "watchedOn"`,
      [request.user.uid, movie.id, JSON.stringify(movie)],
    );
    invalidateMovieCaches(request.user.uid);
    response.json(toResponse(rows[0]));
  }));

  router.delete('/me/movies/favorites/:movieId', handle(async (request, response) => {
    await pool.query(
      'DELETE FROM movie_favorites WHERE firebase_uid = $1 AND movie_id = $2',
      [request.user.uid, request.params.movieId],
    );
    invalidateMovieCaches(request.user.uid);
    response.status(204).end();
  }));

  // --- recommendations and stats -------------------------------------------------------------

  router.get('/me/movies/recommendations', handle(async (request, response) => {
    const page = Number.parseInt(request.query.page, 10);
    const list = await getMovieRecommendationsFor(
      request.user.uid,
      Number.isInteger(page) && page >= 1 && page <= 500 ? page : 1,
    );
    response.json(await withImdbRatings(list, 'movie'));
  }));

  // Sequels of the movies on the user's list that are not out yet, soonest first, each saying
  // which movie it follows. Ones the user hid, and ones they already have, are left out.
  router.get('/me/movies/upcoming-sequels', handle(async (request, response) => {
    const today = await userToday(request.user.uid);
    response.json(await getUpcomingSequels(request.user.uid, today));
  }));

  // Hiding a sequel from Upcoming. Idempotent in both directions.
  router.put('/me/movies/sequels/:movieId/dismissed', handle(async (request, response) => {
    await pool.query(
      `INSERT INTO dismissed_sequels(firebase_uid, movie_id) VALUES ($1, $2)
       ON CONFLICT (firebase_uid, movie_id) DO NOTHING`,
      [request.user.uid, request.params.movieId],
    );
    invalidateUpcomingSequels(request.user.uid);
    response.status(204).end();
  }));

  router.delete('/me/movies/sequels/:movieId/dismissed', handle(async (request, response) => {
    await pool.query(
      'DELETE FROM dismissed_sequels WHERE firebase_uid = $1 AND movie_id = $2',
      [request.user.uid, request.params.movieId],
    );
    invalidateUpcomingSequels(request.user.uid);
    response.status(204).end();
  }));

  // The two numbers for the profile's Stats cards. A movie without a known runtime counts as
  // watched but adds no minutes.
  router.get('/me/movies/stats', handle(async (request, response) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE watched_on IS NOT NULL)::int AS "watchedCount",
              COALESCE(SUM((movie->>'runtime')::int) FILTER (WHERE watched_on IS NOT NULL), 0)::int
                AS "watchedMinutes"
       FROM movie_watchlist WHERE firebase_uid = $1`,
      [request.user.uid],
    );
    response.json(rows[0]);
  }));
}

module.exports = { compactMovie, isRealDate, registerMeMovieRoutes };
