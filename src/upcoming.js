const {
  getTvMazeEpisodes,
  getTvMazeShow,
  getTvShowClassificationData,
  getTvSeason,
} = require('./tmdb');

// When an entry is due for a refresh, and how long it may still be served
// while that refresh runs. Air dates tolerate being a few hours old, and the
// alternative is making whoever opens the app first after a restart wait on
// the whole library before seeing anything.
const cacheLifetimeMs = 6 * 60 * 60 * 1000;
const cacheStaleLimitMs = 7 * 24 * 60 * 60 * 1000;
const cacheMaxEntries = 2000;
const upcomingCache = new Map();

// Shows resolved at once. Almost every one of them is now answered from cache
// or by a single TMDB read, so the old limit of 4 just serialised work that no
// longer needs throttling here — the provider limiters in `tmdb.js` are what
// actually protect the upstreams.
const showConcurrency = 8;

// TVMaze supplies enrichment only — airtime, network, episode text fallbacks —
// and its search endpoint intermittently stalls for ten seconds or more before
// a retry succeeds. One such stall used to decide how long the whole endpoint
// took, so enrichment gets a deadline and is simply left out when it is missed.
//
// Sits between the two measured populations: a normal call answers in 100-500ms
// warm and up to ~2.5s on a cold connection, while a stalled one runs past 10s.
// A missed deadline costs one response its airtime for that show — the request
// it abandoned still settles into the provider cache, so the next read has it.
const tvMazeEnrichmentTimeoutMs = 5000;

/// Resolves to [fallback] if [promise] has not settled within [ms].
function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

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
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  ).then(() => results);
}

/// Serves a show's episodes from cache, refreshing behind the response once the
/// entry is past [cacheLifetimeMs] rather than making the caller wait for it.
///
/// Only a cold entry — never loaded, or stale beyond [cacheStaleLimitMs] — is
/// awaited. A pull-to-refresh always waits, since the point of it is new data.
function cachedUpcoming(key, load, forceRefresh) {
  if (forceRefresh) {
    upcomingCache.delete(key);
    return beginUpcomingLoad(key, load);
  }

  const cached = upcomingCache.get(key);
  const age = cached?.storedAt == null ? Infinity : Date.now() - cached.storedAt;
  if (age < cacheLifetimeMs) return Promise.resolve(cached.value);

  // One load in flight per show is enough, whether it was started by a caller
  // that is waiting or by a revalidation that nobody is.
  const pending = cached?.pending ?? beginUpcomingLoad(key, load);
  if (age >= cacheStaleLimitMs) return pending;

  // Returning the stale value leaves `pending` unawaited, so its rejection has
  // to be absorbed here or it surfaces as an unhandled rejection.
  pending.catch(() => {});
  return Promise.resolve(cached.value);
}

function beginUpcomingLoad(key, load) {
  const previous = upcomingCache.get(key);
  const pending = load()
    .then((value) => {
      upcomingCache.set(key, { value, storedAt: Date.now() });
      pruneUpcomingCache();
      return value;
    })
    .catch((error) => {
      // A stale value outlives the failed refresh that was meant to replace
      // it: still better than an empty list, and the next request retries.
      if (previous?.storedAt == null) upcomingCache.delete(key);
      else upcomingCache.set(key, { value: previous.value, storedAt: previous.storedAt });
      throw error;
    });
  upcomingCache.set(key, { ...previous, pending });
  return pending;
}

function pruneUpcomingCache() {
  if (upcomingCache.size <= cacheMaxEntries) return;
  // Oldest first (Map iterates in insertion order). In-flight entries stay —
  // something is already awaiting them, and skipping them also keeps this from
  // spinning when every entry is pending.
  for (const [key, entry] of upcomingCache) {
    if (upcomingCache.size <= cacheMaxEntries) break;
    if (!entry.pending) upcomingCache.delete(key);
  }
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

/// The episodes a show could have upcoming, with nothing in it that depends on
/// the current date.
///
/// Keeping the date out means one cache entry serves every caller on every day.
/// Keyed on `${id}:${today}`, the whole cache fell off a cliff at midnight and
/// whoever opened the app first that morning paid for the entire library.
async function loadSeriesEpisodes(show, forceRefresh) {
  const data = await getTvShowClassificationData(show.id, { forceRefresh });
  const seasons = Array.isArray(data.seasons)
    ? data.seasons.filter((season) => Number(season.season_number) > 0)
    : [];
  const next = data.next_episode_to_air;

  // TMDB only marks a show ended or canceled once its finale has aired, so one
  // with no next episode scheduled has nothing upcoming and neither its
  // seasons nor TVMaze are worth a request. Most of a long-lived watchlist sits
  // in this state.
  const status = String(data.status || '').trim().toLowerCase();
  if (!next && (status === 'ended' || status === 'canceled' || status === 'cancelled')) {
    return { data, episodes: [] };
  }

  const candidates = new Set();
  if (seasons.length) {
    candidates.add(Math.max(...seasons.map((season) => Number(season.season_number))));
  }
  if (Number(next?.season_number) > 0) candidates.add(Number(next.season_number));
  // Measured against the server's date rather than the caller's local one, so
  // this stays date-independent enough to cache. A season starting today is in
  // any case the latest season, which is already a candidate.
  const builtOn = new Date().toISOString().slice(0, 10);
  for (const season of seasons) {
    const date = season.air_date;
    if (isDate(date) && date >= builtOn) candidates.add(Number(season.season_number));
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

  return { data, episodes };
}

/// Builds one show's response items against the caller's local date.
async function buildSeriesUpcoming(show, { data, episodes }, today, forceRefresh) {
  const upcoming = episodes
    .map((episode) => ({ episode, airDate: episode.air_date }))
    .filter(({ airDate }) => isDate(airDate) && airDate >= today)
    .sort((a, b) => a.airDate.localeCompare(b.airDate) ||
      Number(a.episode.season_number) - Number(b.episode.season_number) ||
      Number(a.episode.episode_number) - Number(b.episode.episode_number));

  // TVMaze supplies the airtime, the network and episode text fallbacks. With
  // nothing upcoming none of that is ever read, yet it used to be fetched
  // regardless — three rate-limited calls for every show in the library,
  // which is what made this endpoint take the best part of a minute.
  if (!upcoming.length) return [];

  const name = data.name || show.name;
  // Deadlined separately, not as one race over both: the show lookup is what
  // carries the airtime and the network, and bundling it with the longer
  // episode list threw that away whenever the list was the slow half. Each
  // `catch` is attached before its deadline, so a rejection arriving after the
  // deadline has been answered is still handled.
  const [tvMazeShow, tvMazeEpisodes] = await Promise.all([
    withDeadline(
      getTvMazeShow(name, { forceRefresh }).catch(() => null),
      tvMazeEnrichmentTimeoutMs,
      null,
    ),
    withDeadline(
      getTvMazeEpisodes(name, { forceRefresh }).catch(() => []),
      tvMazeEnrichmentTimeoutMs,
      [],
    ),
  ]);

  const schedule = tvMazeShow?.schedule || {};
  const network = tvMazeShow?.network || tvMazeShow?.webChannel || null;
  const tmdbNetwork = Array.isArray(data.networks) ? data.networks[0] : null;
  const seasons = Array.isArray(data.seasons)
    ? data.seasons.filter((season) => Number(season.season_number) > 0)
    : [];
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
      // TVMaze keeps the zone on the network's country, not in the schedule, so a show with an air
      // time but no zone (every streaming show has neither) cannot be placed on the clock.
      timezone: schedule.timezone || network?.country?.timezone || null,
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
    pool.query(
      `SELECT w.series AS data FROM watchlist w
       WHERE w.firebase_uid=$1
         AND NOT EXISTS (SELECT 1 FROM show_states s
                         WHERE s.firebase_uid=w.firebase_uid AND s.series_id=w.series_id)`,
      [uid],
    ),
    // A show the user stopped watching or removed (show-states.js) has no upcoming episodes for
    // them, even though its progress is kept.
    pool.query(
      `SELECT p.series_id AS id, p.show_name AS name, p.poster_path AS "posterPath",
              p.backdrop_path AS "backdropPath"
       FROM show_progress p
       WHERE p.firebase_uid=$1
         AND NOT EXISTS (SELECT 1 FROM show_states s
                         WHERE s.firebase_uid=p.firebase_uid AND s.series_id=p.series_id)`,
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

  const results = await mapWithConcurrency([...shows.values()], showConcurrency, async (show) => {
    try {
      const episodes = await cachedUpcoming(
        `${show.id}`,
        () => loadSeriesEpisodes(show, forceRefresh),
        forceRefresh,
      );
      return await buildSeriesUpcoming(show, episodes, today, forceRefresh);
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
