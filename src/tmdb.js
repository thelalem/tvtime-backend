const { config } = require('./config');

function providerError(message, status, cause) {
  const error = new Error(message);
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

async function requestJson(url, options = {}, unavailableMessage = 'Provider is unavailable') {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    throw providerError(
      cause.name === 'TimeoutError' ? 'Provider timed out' : unavailableMessage,
      cause.name === 'TimeoutError' ? 504 : 502,
      cause,
    );
  }

  if (!response.ok) {
    throw providerError('Provider request failed', 502);
  }
  return response.json();
}

function requireTmdb() {
  if (!config.tmdbAccessToken) {
    throw providerError('TV metadata provider is not configured', 503);
  }
}

function tmdbUrl(path, query = {}) {
  requireTmdb();
  const url = new URL(`${config.tmdbBaseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function tmdbOptions() {
  return {
    headers: {
      Authorization: `Bearer ${config.tmdbAccessToken}`,
      accept: 'application/json',
    },
  };
}

async function tmdbGet(path, query) {
  return requestJson(tmdbUrl(path, query), tmdbOptions(), 'TV metadata provider is unavailable');
}

async function searchTv(query) {
  return tmdbGet('/search/tv', { query });
}

async function getTvShow(showId) {
  return tmdbGet(`/tv/${showId}`, {
    append_to_response: 'aggregate_credits,videos,watch/providers,external_ids',
  });
}

async function getTvSeason(showId, seasonNumber) {
  return tmdbGet(`/tv/${showId}/season/${seasonNumber}`);
}

async function getDiscovery(kind, query = {}) {
  const paths = {
    popular: '/tv/popular',
    top_rated: '/tv/top_rated',
    trending: '/trending/tv/week',
    discover: '/discover/tv',
  };
  if (!paths[kind]) throw providerError('Unknown discovery feed', 400);
  return tmdbGet(paths[kind], query);
}

async function getOmdbSeasonRatings(imdbId, seasonNumber) {
  if (!config.omdbApiKey) {
    return { ratings: {}, configured: false };
  }

  const url = new URL(config.omdbBaseUrl);
  url.searchParams.set('apikey', config.omdbApiKey);
  url.searchParams.set('i', imdbId);
  url.searchParams.set('Season', String(seasonNumber));
  const data = await requestJson(url, {}, 'OMDb is unavailable');
  if (data.Response === 'False' || !Array.isArray(data.Episodes)) {
    return { ratings: {}, configured: true };
  }

  const ratings = {};
  for (const episode of data.Episodes) {
    const episodeNumber = Number.parseInt(episode.Episode, 10);
    const rating = Number.parseFloat(episode.imdbRating);
    if (Number.isInteger(episodeNumber) && Number.isFinite(rating) && rating > 0) {
      ratings[`${seasonNumber}_${episodeNumber}`] = rating;
    }
  }
  return { ratings, configured: true };
}

async function getImdbRatings(showId) {
  const show = await getTvShow(showId);
  const imdbId = show.external_ids && show.external_ids.imdb_id;
  if (!imdbId) return { imdbId: null, ratings: {}, configured: Boolean(config.omdbApiKey) };

  const seasons = Array.isArray(show.seasons) ? show.seasons : [];
  const results = await Promise.all(
    seasons
      .filter((season) => Number(season.season_number) > 0)
      .map((season) => getOmdbSeasonRatings(imdbId, season.season_number)),
  );
  return {
    imdbId,
    configured: Boolean(config.omdbApiKey),
    ratings: Object.assign({}, ...results.map((result) => result.ratings)),
  };
}

async function getTvMazeShow(name) {
  const url = new URL(`${config.tvMazeBaseUrl.replace(/\/$/, '')}/singlesearch/shows`);
  url.searchParams.set('q', name);
  try {
    return await requestJson(url, {}, 'TVMaze is unavailable');
  } catch (error) {
    if (error.status === 502 || error.status === 504) return null;
    throw error;
  }
}

async function getTvMazeEpisodes(name) {
  const show = await getTvMazeShow(name);
  if (!show || !show.id) return [];
  const url = `${config.tvMazeBaseUrl.replace(/\/$/, '')}/shows/${show.id}/episodes?specials=0`;
  try {
    const episodes = await requestJson(url, {}, 'TVMaze is unavailable');
    return Array.isArray(episodes) ? episodes : [];
  } catch (error) {
    if (error.status === 502 || error.status === 504) return [];
    throw error;
  }
}

module.exports = {
  getDiscovery,
  getImdbRatings,
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvSeason,
  getTvShow,
  searchTv,
};
