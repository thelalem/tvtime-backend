const {
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvShowClassificationData,
  getTvSeason,
} = require('./tmdb');

const cacheLifetimeMs = 24 * 60 * 60 * 1000;
const cacheMaxEntries = 2000;
const upcomingCache = new Map();

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, '').trim()
    : '';
}

function isPlaceholder(value) {
  if (typeof value !== 'string' || !value.trim()) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === 'episode' || normalized.startsWith('episode ');
}

function mapWithConcurrency(items, limit, run) {
  let next = 0;
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    const results = [];
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
    return results;
  })).then((chunks) => chunks.flat());
}

function cachedUpcoming(key, load, forceRefresh) {
  if (forceRefresh) upcomingCache.delete(key);
  const cached = upcomingCache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

  const pending = load().then((value) => {
    upcomingCache.set(key, { value, expiresAt: Date.now() + cacheLifetimeMs });
    while (upcomingCache.size > cacheMaxEntries) {
      upcomingCache.delete(upcomingCache.keys().next().value);
    }
    return value;
  }).catch((error) => {
    upcomingCache.delete(key);
    throw error;
  });
  upcomingCache.set(key, { pending });
  return pending;
}

function seriesModel(show, fallback) {
  const id = Number(show.id ?? fallback.id);
  return {
    id,
    name: show.name || fallback.name || 'TV show',
    overview: show.overview || fallback.overview || '',
    posterPath: show.poster_path ?? show.posterPath ?? fallback.posterPath ?? null,
    backdropPath: show.backdrop_path ?? show.backdropPath ?? fallback.backdropPath ?? null,
    rating: Number(show.vote_average ?? show.rating ?? fallback.rating ?? 0),
    firstAirDate: show.first_air_date || show.firstAirDate || fallback.firstAirDate || '',
    lastUpdated: null,
  };
}

function episodeModel(episode, tvMazeEpisode) {
  const image = tvMazeEpisode?.image;
  const fallback = {
    name: tvMazeEpisode?.name || '',
    overview: cleanText(tvMazeEpisode?.summary),
    stillPath: image?.original || image?.medium || null,
    airDate: tvMazeEpisode?.airdate || null,
    tmdbRating: tvMazeEpisode?.rating?.average == null
      ? null
      : Number(tvMazeEpisode.rating.average),
  };
  const name = isPlaceholder(episode.name) ? fallback.name || episode.name || '' : episode.name;
  const overview = isPlaceholder(episode.overview)
    ? fallback.overview || episode.overview || ''
    : episode.overview;
  const airDate = isPlaceholder(episode.air_date) ? fallback.airDate : episode.air_date;
  const rating = Number(episode.vote_average || 0);
  return {
    id: Number(episode.id || tvMazeEpisode?.id || 0),
    seasonNumber: Number(episode.season_number || 0),
    episodeNumber: Number(episode.episode_number || 0),
    name,
    overview,
    stillPath: isPlaceholder(episode.still_path) ? fallback.stillPath : episode.still_path,
    imdbRating: episode.imdb_rating == null ? null : Number(episode.imdb_rating),
    tmdbRating: rating === 0 ? fallback.tmdbRating : rating,
    airDate,
  };
}

async function loadSeriesUpcoming(show, today, forceRefresh) {
  const data = await getTvShowClassificationData(show.id, { forceRefresh });
  const seasons = Array.isArray(data.seasons)
    ? data.seasons.filter((season) => Number(season.season_number) > 0)
    : [];
  const candidates = new Set();
  if (seasons.length) {
    candidates.add(Math.max(...seasons.map((season) => Number(season.season_number))));
  }
  const next = data.next_episode_to_air;
  if (Number(next?.season_number) > 0) candidates.add(Number(next.season_number));
  for (const season of seasons) {
    const date = season.air_date;
    if (isDate(date) && date >= today) candidates.add(Number(season.season_number));
  }

  const seasonResults = await mapWithConcurrency([...candidates], 4, async (number) => {
    try {
      return await getTvSeason(show.id, number, { forceRefresh });
    } catch (_error) {
      return null;
    }
  });
  const episodes = seasonResults.flatMap((season) =>
    Array.isArray(season?.episodes) ? season.episodes : []);
  if (next && !episodes.some((episode) =>
    Number(episode.season_number) === Number(next.season_number) &&
    Number(episode.episode_number) === Number(next.episode_number))) {
    episodes.push(next);
  }

  const [tvMazeShow, tvMazeEpisodes] = await Promise.all([
    getTvMazeShow(data.name || show.name).catch(() => null),
    getTvMazeEpisodes(data.name || show.name).catch(() => []),
  ]);
  const upcoming = episodes
    .map((episode) => ({ episode, airDate: episode.air_date }))
    .filter(({ airDate }) => isDate(airDate) && airDate >= today)
    .sort((a, b) => a.airDate.localeCompare(b.airDate) ||
      Number(a.episode.season_number) - Number(b.episode.season_number) ||
      Number(a.episode.episode_number) - Number(b.episode.episode_number));

  const schedule = tvMazeShow?.schedule || {};
  const network = tvMazeShow?.network || tvMazeShow?.webChannel || null;
  const tmdbNetwork = Array.isArray(data.networks) ? data.networks[0] : null;
  const totalEpisodes = seasons.reduce((sum, season) =>
    sum + Number(season.episode_count || 0), 0);
  const previousDate = data.last_episode_to_air?.air_date;
  const result = [];
  for (let index = 0; index < upcoming.length; index += 1) {
    const { episode, airDate } = upcoming[index];
    const matchingTvMaze = tvMazeEpisodes.find((candidate) =>
      Number(candidate.season) === Number(episode.season_number) &&
      Number(candidate.number) === Number(episode.episode_number));
    result.push({
      seriesId: Number(show.id),
      series: seriesModel(data, show),
      episode: episodeModel(episode, matchingTvMaze),
      seriesName: data.name || show.name || 'TV show',
      posterPath: data.poster_path ?? show.posterPath ?? null,
      networkName: network?.name || null,
      networkLogoPath: tmdbNetwork?.logo_path || network?.image?.medium || network?.image?.original || null,
      airTime: schedule.time || null,
      timezone: schedule.timezone || null,
      totalEpisodes,
      isPremiere: Number(episode.season_number) > 0 && Number(episode.episode_number) === 1,
      isLatest: index === 0 && isDate(previousDate) &&
        Math.floor((Date.parse(`${airDate}T00:00:00Z`) -
          Date.parse(`${previousDate}T00:00:00Z`)) / 86400000) > 7,
    });
  }
  return result;
}

async function getUpcomingEpisodes({ uid, today, forceRefresh = false, pool }) {
  if (!isDate(today)) {
    const error = new Error('today must be a local calendar date (YYYY-MM-DD)');
    error.status = 400;
    throw error;
  }
  const [watchlistResult, progressResult] = await Promise.all([
    pool.query('SELECT series AS data FROM watchlist WHERE firebase_uid=$1', [uid]),
    pool.query(
      `SELECT series_id AS id, show_name AS name, poster_path AS "posterPath",
              backdrop_path AS "backdropPath"
       FROM show_progress WHERE firebase_uid=$1`,
      [uid],
    ),
  ]);
  const shows = new Map();
  for (const row of watchlistResult.rows) {
    const data = row.data || {};
    const id = Number(data.id);
    if (Number.isSafeInteger(id) && id > 0) shows.set(id, seriesModel(data, data));
  }
  for (const row of progressResult.rows) {
    const id = Number(row.id);
    if (shows.has(id) || !Number.isSafeInteger(id) || id <= 0) continue;
    shows.set(id, seriesModel(row, row));
  }

  const results = await mapWithConcurrency([...shows.values()], 4, async (show) => {
    const key = `${show.id}:${today}`;
    try {
      return await cachedUpcoming(
        key,
        () => loadSeriesUpcoming(show, today, forceRefresh),
        forceRefresh,
      );
    } catch (error) {
      console.error(`[upcoming] ${show.id}: ${error.message}`);
      return [];
    }
  });
  return results.flat().sort((a, b) => {
    const byDate = a.episode.airDate.localeCompare(b.episode.airDate);
    return byDate || a.seriesName.localeCompare(b.seriesName);
  });
}

module.exports = { getUpcomingEpisodes };
