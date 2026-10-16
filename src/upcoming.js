const {
  getImdbId,
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
// A pull-to-refresh reloads a show from TMDB and TVMaze only when no pull did in
// this long. Every pull used to reload every show in the library, skipping all
// caches: a few in a row queued TVMaze (18 calls per 10 s) for minutes, and
// other users' lists and the notification sweep missed their deadlines. The
// cache is shared, so anyone's pull counts.
const forcedRefreshWindowMs = 5 * 60 * 1000;
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

// TVMaze gives streaming shows no air time. Most services release new episodes
// at midnight Pacific, 3 a.m. Eastern: 07:00 UTC in summer, 08:00 in winter, so
// the time is kept in New York's zone rather than as a fixed UTC hour. Disney+
// releases at 9 p.m. Eastern on the listed date. Apple TV releases at 9 p.m.
// Eastern the evening before the date TVMaze and TMDB list (Severance 2x01:
// listed Friday 17 January 2025, out Thursday the 16th), so its day moves back.
const earlyMorning = { airTime: '03:00', timezone: 'America/New_York' };
const streamingReleaseTimes = new Map([
  ['paramount+', earlyMorning],
  ['prime video', earlyMorning],
  ['amazon prime video', earlyMorning],
  ['netflix', earlyMorning],
  ['hulu', earlyMorning],
  ['peacock', earlyMorning],
  ['disney+', { airTime: '21:00', timezone: 'America/New_York' }],
  ['apple tv', { airTime: '21:00', timezone: 'America/New_York', dayOffset: -1 }],
  ['apple tv+', { airTime: '21:00', timezone: 'America/New_York', dayOffset: -1 }],
]);

/// The usual release time of a show TVMaze has no air time for, or null.
function streamingReleaseTime(tvMazeShow) {
  if (!tvMazeShow || tvMazeShow.schedule?.time || tvMazeShow.network) return null;
  const name = String(tvMazeShow.webChannel?.name || '').trim().toLowerCase();
  return streamingReleaseTimes.get(name) || null;
}

/// [date] (YYYY-MM-DD) moved by [days] calendar days.
function addDays(date, days) {
  if (!isDate(date) || !days) return date;
  const moved = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000);
  return moved.toISOString().slice(0, 10);
}

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
    // The entry is kept, not deleted: if this load fails, the list it was meant
    // to replace is still better than none.
    return beginUpcomingLoad(key, load, { forced: true });
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

/// `forced`: a pull-to-refresh, which bypasses the provider caches; when it
/// lands, `freshAt` marks the entry as fresh from TMDB and TVMaze.
function beginUpcomingLoad(key, load, { forced = false } = {}) {
  const previous = upcomingCache.get(key);
  const pending = load()
    .then((value) => {
      const now = Date.now();
      upcomingCache.set(key, {
        value,
        storedAt: now,
        freshAt: forced ? now : previous?.freshAt,
      });
      pruneUpcomingCache();
      return value;
    })
    .catch((error) => {
      // A stale value outlives the failed refresh that was meant to replace
      // it: still better than an empty list, and the next request retries.
      if (previous?.storedAt == null) upcomingCache.delete(key);
      else {
        upcomingCache.set(key, {
          value: previous.value,
          storedAt: previous.storedAt,
          freshAt: previous.freshAt,
        });
      }
      throw error;
    });
  upcomingCache.set(key, { ...previous, pending, pendingForced: forced });
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
  // By IMDb id where TMDB has one, so a remake is not mistaken for the show it
  // shares a name with (tmdb.js, getTvMazeShow).
  const imdbIdLookup = getImdbId(show.id).catch(() => null);
  // Deadlined separately, not as one race over both: the show lookup is what
  // carries the airtime and the network, and bundling it with the longer
  // episode list threw that away whenever the list was the slow half. Each
  // `catch` is attached before its deadline, so a rejection arriving after the
  // deadline has been answered is still handled.
  //
  // A failure or a missed deadline is told apart from TVMaze answering "no
  // such show": notifications wait for a real answer before falling back to
  // 9 a.m., which used to announce a 9 p.m. episode twelve hours early.
  const noAnswer = Symbol('no TVMaze answer');
  const [tvMazeShowAnswer, tvMazeEpisodes] = await Promise.all([
    withDeadline(
      imdbIdLookup
        .then((imdbId) => getTvMazeShow(name, { forceRefresh, imdbId }))
        .catch(() => noAnswer),
      tvMazeEnrichmentTimeoutMs,
      noAnswer,
    ),
    withDeadline(
      imdbIdLookup
        .then((imdbId) => getTvMazeEpisodes(name, { forceRefresh, imdbId }))
        .catch(() => []),
      tvMazeEnrichmentTimeoutMs,
      [],
    ),
  ]);
  const tvMazeAnswered = tvMazeShowAnswer !== noAnswer;
  const tvMazeShow = tvMazeAnswered ? tvMazeShowAnswer : null;

  const schedule = tvMazeShow?.schedule || {};
  const network = tvMazeShow?.network || tvMazeShow?.webChannel || null;
  const releaseTime = streamingReleaseTime(tvMazeShow);
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
    const episodeData = episodeModel(episode, matchingTvMaze);
    result.push({
      seriesId: Number(show.id),
      series: seriesModel(data, show),
      episode: episodeData,
      seriesName: data.name || show.name || 'TV show',
      posterPath: data.poster_path ?? show.posterPath ?? null,
      networkName: network?.name || null,
      networkLogoPath: tmdbNetwork?.logo_path || network?.image?.medium || network?.image?.original || null,
      airTime: schedule.time || releaseTime?.airTime || null,
      // TVMaze keeps the zone on the network's country, not in the schedule, so a show with an air
      // time but no zone (most streaming shows have neither) cannot be placed on the clock.
      timezone: schedule.timezone || network?.country?.timezone || releaseTime?.timezone || null,
      // True when the time is the service's usual release time, not one TVMaze published.
      airTimeEstimated: releaseTime != null,
      // The date in `timezone` that `airTime` falls on. Usually the air date; for Apple TV the
      // evening before it. Older apps ignore it and use the air date.
      releaseDate: addDays(episodeData.airDate, releaseTime?.dayOffset || 0),
      // False when TVMaze could not be asked: no air time means "unknown yet",
      // not "streaming, no time" (notifications.js, announceAt).
      tvMazeAnswered,
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
      const key = `${show.id}`;
      const entry = upcomingCache.get(key);
      // A pull while another pull's load of this show runs waits for that one;
      // one within the window is a normal read (forcedRefreshWindowMs).
      const joining = forceRefresh && entry?.pending != null && entry.pendingForced === true;
      const fresh = entry?.freshAt != null && Date.now() - entry.freshAt < forcedRefreshWindowMs;
      const force = forceRefresh && !joining && !fresh;
      const episodes = joining
        ? await entry.pending
        : await cachedUpcoming(key, () => loadSeriesEpisodes(show, force), force);
      return await buildSeriesUpcoming(show, episodes, today, force);
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

module.exports = { getUpcomingEpisodes, streamingReleaseTime };
