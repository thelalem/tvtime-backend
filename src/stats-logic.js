// The rules behind the stats page (FEATURE_PLAN.md section 17), with no database in them: give it a user's watch
// history and it says what the numbers are. stats.js is the route and the database around it.
//
// Input
//   shows   [{ showId, name, posterPath, runtime, watched: ['S1E1', ...], dates: { S1E1: iso, ... },
//              rewatches: { S1E1: [{ at: iso }, ...] } }]
//   movies  [{ movieId, title, watchedOn: 'YYYY-MM-DD', runtime }]       (only watched ones)
//   timezone  the user's IANA zone: a "day" is a day on their own clock
//   now       a Date (the clock, so tests can fix it)
//
// What counts
// - An episode is a regular one (season 1 and up). Specials (S0E..) are not counted as episodes, as on the Profile.
// - A rewatch is time spent too: it counts as another episode in the totals, the months and the time.
// - Bulk checks: TV Time stamped "mark all previous" and "mark season" with one timestamp, and ticking a whole season
//   in the app does the same. Episodes of one show watched within the same minute, more than BULK_LIMIT of them, are a
//   bulk check. They count in the totals and the months but never toward the biggest binge, the streaks or the
//   busiest day, so ticking a season does not read as sixty episodes in one second.

const BULK_LIMIT = 3;
const MINUTE_MS = 60 * 1000;
const FALLBACK_RUNTIME = 42;
const TOP_COUNT = 5;

const formatters = new Map();
function dayOf(ms, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      });
    } catch (_error) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      });
    }
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

// The day after a YYYY-MM-DD, as YYYY-MM-DD (calendar arithmetic, no timezone involved).
function nextDay(date) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayNumber(date) {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / (24 * 60 * 60 * 1000));
}

const isSpecial = (key) => key.startsWith('S0E');

function runtimeOf(show) {
  return Number.isFinite(show.runtime) && show.runtime > 0 ? show.runtime : FALLBACK_RUNTIME;
}

// Every watch of every episode as an event, with the bulk ones marked.
function episodeEvents(shows) {
  const events = [];
  for (const show of shows) {
    for (const key of Object.keys(show.dates || {})) {
      const ms = Date.parse(show.dates[key]);
      if (Number.isFinite(ms)) events.push({ show, key, ms, rewatch: false });
    }
    for (const [key, list] of Object.entries(show.rewatches || {})) {
      for (const entry of Array.isArray(list) ? list : []) {
        const ms = Date.parse(entry && entry.at);
        if (Number.isFinite(ms)) events.push({ show, key, ms, rewatch: true });
      }
    }
  }
  const groups = new Map();
  for (const event of events) {
    const id = `${event.show.showId}:${Math.floor(event.ms / MINUTE_MS)}`;
    const group = groups.get(id);
    if (group) group.push(event);
    else groups.set(id, [event]);
  }
  let bulk = 0;
  for (const group of groups.values()) {
    if (group.length > BULK_LIMIT) {
      for (const event of group) event.bulk = true;
      bulk += group.filter((event) => !event.rewatch && !isSpecial(event.key)).length;
    }
  }
  return { events, bulk };
}

function longestRun(days) {
  const sorted = [...days].sort();
  let best = null;
  let start = null;
  let previous = null;
  for (const day of sorted) {
    if (previous !== null && dayNumber(day) === dayNumber(previous) + 1) {
      // continues the run
    } else {
      start = day;
    }
    const length = dayNumber(day) - dayNumber(start) + 1;
    if (!best || length > best.days) best = { days: length, from: start, to: day };
    previous = day;
  }
  return best;
}

function currentRun(days, today) {
  // A streak is alive if the last day was today or yesterday.
  let cursor = days.has(today) ? today : null;
  if (cursor === null) {
    const yesterday = new Date(dayNumber(today) * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!days.has(yesterday)) return 0;
    cursor = yesterday;
  }
  let length = 0;
  while (days.has(cursor)) {
    length += 1;
    cursor = new Date(dayNumber(cursor) * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  return length;
}

function computeStats({ shows = [], movies = [], timezone = 'UTC', now = new Date() } = {}) {
  const { events, bulk } = episodeEvents(shows);
  const today = dayOf(now.getTime(), timezone);

  // Totals.
  let episodes = 0;
  let specials = 0;
  let rewatchCount = 0;
  let minutesEpisodes = 0;
  let minutesRewatches = 0;
  const perShow = new Map();
  for (const show of shows) {
    const regular = (show.watched || []).filter((key) => !isSpecial(key)).length;
    specials += (show.watched || []).length - regular;
    const rewatches = Object.entries(show.rewatches || {})
      .filter(([key]) => !isSpecial(key))
      .reduce((sum, [, list]) => sum + (Array.isArray(list) ? list.length : 0), 0);
    episodes += regular;
    rewatchCount += rewatches;
    minutesEpisodes += regular * runtimeOf(show);
    minutesRewatches += rewatches * runtimeOf(show);
    perShow.set(show.showId, { show, episodes: regular, rewatches });
  }
  const movieMinutes = movies.reduce((sum, movie) => sum + (Number.isFinite(movie.runtime) ? movie.runtime : 0), 0);

  // Days with something watched, the biggest binge and the months.
  const activeDays = new Set();
  const binge = new Map(); // `${showId}:${day}` -> distinct episode keys
  const months = new Map();
  const month = (key) => {
    if (!months.has(key)) months.set(key, { month: key, episodes: 0, rewatches: 0, movies: 0, minutes: 0 });
    return months.get(key);
  };
  let first = null;
  let latest = null;
  for (const event of events) {
    const day = dayOf(event.ms, timezone);
    if (!event.bulk) {
      activeDays.add(day);
      const id = `${event.show.showId}:${day}`;
      if (!binge.has(id)) binge.set(id, { show: event.show, day, keys: new Set() });
      binge.get(id).keys.add(event.key);
    }
    if (!isSpecial(event.key)) {
      const bucket = month(day.slice(0, 7));
      if (event.rewatch) bucket.rewatches += 1;
      else bucket.episodes += 1;
      bucket.minutes += runtimeOf(event.show);
    }
    if (!event.rewatch) {
      if (!first || event.ms < first.ms) first = { ms: event.ms, kind: 'episode', title: event.show.name, key: event.key, day };
      if (!latest || event.ms > latest.ms) latest = { ms: event.ms, kind: 'episode', title: event.show.name, key: event.key, day };
    }
  }
  for (const movie of movies) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(movie.watchedOn || '')) continue;
    activeDays.add(movie.watchedOn);
    const bucket = month(movie.watchedOn.slice(0, 7));
    bucket.movies += 1;
    bucket.minutes += Number.isFinite(movie.runtime) ? movie.runtime : 0;
    const ms = Date.parse(`${movie.watchedOn}T12:00:00Z`);
    if (!first || ms < first.ms) first = { ms, kind: 'movie', title: movie.title, key: null, day: movie.watchedOn };
    if (!latest || ms > latest.ms) latest = { ms, kind: 'movie', title: movie.title, key: null, day: movie.watchedOn };
  }

  let biggestBinge = null;
  for (const entry of binge.values()) {
    const count = [...entry.keys].filter((key) => !isSpecial(key)).length;
    if (count > 0 && (!biggestBinge || count > biggestBinge.episodes)) {
      biggestBinge = { episodes: count, showId: entry.show.showId, showName: entry.show.name, date: entry.day };
    }
  }

  // Months in order, with the empty ones between the first and the last filled in.
  const monthList = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const filled = [];
  for (let i = 0; i < monthList.length; i += 1) {
    filled.push(monthList[i]);
    const next = monthList[i + 1];
    if (!next) break;
    let [y, m] = monthList[i].month.split('-').map(Number);
    for (;;) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key >= next.month) break;
      filled.push({ month: key, episodes: 0, rewatches: 0, movies: 0, minutes: 0 });
    }
  }
  const busiestMonth = filled.reduce((best, item) => (item.minutes > (best ? best.minutes : 0) ? item : best), null);

  const shaped = [...perShow.values()].filter((entry) => entry.episodes + entry.rewatches > 0);
  const card = (entry) => ({
    showId: entry.show.showId, name: entry.show.name, posterPath: entry.show.posterPath || null,
    episodes: entry.episodes, rewatches: entry.rewatches,
    minutes: (entry.episodes + entry.rewatches) * runtimeOf(entry.show),
  });
  const topShows = [...shaped]
    .sort((a, b) => (b.episodes + b.rewatches) * runtimeOf(b.show) - (a.episodes + a.rewatches) * runtimeOf(a.show))
    .slice(0, TOP_COUNT).map(card);
  const mostRewatched = shaped.filter((entry) => entry.rewatches > 0)
    .sort((a, b) => b.rewatches - a.rewatches).slice(0, TOP_COUNT).map(card);

  const describe = (watch) => (watch ? { date: watch.day, kind: watch.kind, title: watch.title, key: watch.key } : null);
  return {
    timezone,
    totals: {
      shows: shaped.length,
      episodes,
      specials,
      rewatches: rewatchCount,
      movies: movies.length,
      minutes: {
        episodes: minutesEpisodes,
        rewatches: minutesRewatches,
        movies: movieMinutes,
        total: minutesEpisodes + minutesRewatches + movieMinutes,
      },
    },
    firstWatch: describe(first),
    latestWatch: describe(latest),
    biggestBinge,
    streak: { longest: longestRun(activeDays), current: currentRun(activeDays, today) },
    activeDays: activeDays.size,
    months: filled,
    busiestMonth: busiestMonth && busiestMonth.minutes > 0 ? busiestMonth : null,
    topShows,
    mostRewatched,
    bulkEpisodes: bulk,
  };
}

module.exports = { BULK_LIMIT, FALLBACK_RUNTIME, computeStats, dayOf, nextDay };
