const {
  getDiscovery,
  getMovie,
  searchMulti,
  withImdbRating,
  withImdbRatings,
} = require('./tmdb');
const { getSimilarShows } = require('./similar');

// The signed-out movie routes: feeds, a movie's details, similar movies, and the search that
// returns shows and movies together. Like the show routes, they report IMDb ratings (see
// `withImdbRatings`).

// TMDB serves pages 1..500. Anything else (missing, junk, out of range) is page 1 rather than an
// error, so a client without the parameter keeps working.
function feedPage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page >= 1 && page <= 500 ? page : 1;
}

function registerPublicMovieRoutes(app) {
  // These ids are spliced into the TMDB request path, so only plain numbers pass (the same
  // reasoning as the show routes' `showId` check).
  app.param('movieId', (_request, response, next, value) => {
    if (/^[1-9]\d{0,9}$/.test(value)) return next();
    return response.status(400).json({ detail: 'movieId must be a positive integer' });
  });

  app.get('/api/v1/movies/trending', async (request, response, next) => {
    try {
      const feed = await getDiscovery('movie_trending', { page: feedPage(request.query.page) });
      response.json(await withImdbRatings(feed, 'movie'));
    } catch (error) { next(error); }
  });

  app.get('/api/v1/movies/popular', async (request, response, next) => {
    try {
      const feed = await getDiscovery('movie_popular', { page: feedPage(request.query.page) });
      response.json(await withImdbRatings(feed, 'movie'));
    } catch (error) { next(error); }
  });

  app.get('/api/v1/movies/:movieId', async (request, response, next) => {
    try {
      response.json(await withImdbRating(await getMovie(request.params.movieId), 'movie'));
    } catch (error) { next(error); }
  });

  app.get('/api/v1/movies/:movieId/similar', async (request, response, next) => {
    try {
      const similar = await getSimilarShows(request.params.movieId, 'movie');
      response.json(await withImdbRatings(similar, 'movie'));
    } catch (error) { next(error); }
  });

  // One list of shows and movies, closest match first; each result carries `media_type`.
  app.get('/api/v1/search', async (request, response, next) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (!query || query.length > 100) {
      return response.status(400).json({ detail: 'q must contain 1 to 100 characters' });
    }
    try {
      return response.json(await withImdbRatings(await searchMulti(query)));
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { feedPage, registerPublicMovieRoutes };
