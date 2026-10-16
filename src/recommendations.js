const { pool } = require('./db');
const {
  getDiscovery,
  getTvRecommendations,
  getTvShowClassificationData,
} = require('./tmdb');

const PAGE_SIZE = 20;
const SEED_COUNT = 8;
const MAX_RESULTS = 100;
// Fewer ranked shows than this and the list is topped up from popular.
const MIN_RANKED = 40;
const MIN_VOTE_COUNT = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_USERS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

// uid -> { at, list, pending }. Short-lived on purpose: it only has to absorb
// the Explore row plus the see-all page asking for the same ranking.
const cache = new Map();

function invalidateRecommendations(uid) {
  cache.delete(uid);
}

async function getRecommendations(uid, page) {
  const list = await rankedListFor(uid);
  const start = (page - 1) * PAGE_SIZE;
  return {
    page,
    total_pages: Math.max(1, Math.ceil(list.length / PAGE_SIZE)),
    total_results: list.length,
    results: list.slice(start, start + PAGE_SIZE),
  };
}

function rankedListFor(uid) {
  const entry = cache.get(uid);
  if (entry && (entry.pending || Date.now() - entry.at < CACHE_TTL_MS)) {
    return entry.pending || Promise.resolve(entry.list);
  }

  const startedWith = {};
  const pending = buildRankedList(uid)
    .then((list) => {
      // A watchlist change while this was running invalidated the entry; do not
      // put the now-outdated list back.
      if (cache.get(uid) === startedWith) {
        cache.set(uid, { at: Date.now(), list });
        pruneCache();
      }
      return list;
    })
    .catch((error) => {
      if (cache.get(uid) === startedWith) cache.delete(uid);
      throw error;
    });
  startedWith.pending = pending;
  cache.set(uid, startedWith);
  return pending;
}

function pruneCache() {
  while (cache.size > CACHE_MAX_USERS) cache.delete(cache.keys().next().value);
}

async function loadHistory(uid) {
  const [watchlist, favorites, progress, states, rated] = await Promise.all([
    pool.query('SELECT series_id, added_at FROM watchlist WHERE firebase_uid = $1', [uid]),
    pool.query('SELECT series_id FROM favorites WHERE firebase_uid = $1', [uid]),
    pool.query(
      `SELECT series_id, watched_count, total_episodes, last_watched
       FROM show_progress WHERE firebase_uid = $1`,
      [uid],
    ),
    pool.query('SELECT series_id FROM show_states WHERE firebase_uid = $1', [uid]),
    // How the user rated the episodes they rated (episode-data.js), per show.
    pool.query(
      `SELECT series_id, AVG(rating)::float AS average, COUNT(*)::int AS count
       FROM episode_user_data WHERE firebase_uid = $1 AND rating IS NOT NULL
       GROUP BY series_id`,
      [uid],
    ),
  ]);
  // A show the user stopped watching or removed is a weak signal at best, so it is not a seed;
  // it is still known (see `known` below), so it is never suggested back to them.
  const inactive = new Set(states.rows.map((row) => Number(row.series_id)));
  return {
    watchlist: watchlist.rows,
    favorites: favorites.rows.filter((row) => !inactive.has(Number(row.series_id))),
    progress: progress.rows.filter((row) => !inactive.has(Number(row.series_id))),
    ratings: new Map(rated.rows.map((row) => [
      Number(row.series_id),
      { average: Number(row.average), count: Number(row.count) },
    ])),
    inactive,
  };
}

// What the user's own episode ratings do to a show's weight as a seed:
//   an average of 4.5 or more   -> twice the weight
//   3.5 up to 4.5               -> one and a half times
//   above 2 up to 3.5, or none  -> unchanged
//   2 or less (two ratings at least, so one bad episode does not decide it) -> no weight at all:
//       the show stops steering the list, though it is still never suggested back.
// A favorite is never dropped, only halved, because choosing it was the stronger statement.
function ratingFactor(info, isFavorite) {
  if (!info) return 1;
  if (info.average >= 4.5) return 2;
  if (info.average >= 3.5) return 1.5;
  if (info.average <= 2 && info.count >= 2) return isFavorite ? 0.5 : 0;
  return 1;
}

// How strongly each show the user has engaged with should steer the list:
// favorite > recently watched or completed > mostly watched > just added.
function seedWeights({ watchlist, favorites, progress, ratings = new Map() }) {
  const weights = new Map();
  const add = (id, amount) => weights.set(id, (weights.get(id) || 0) + amount);
  const now = Date.now();

  for (const row of watchlist) add(Number(row.series_id), 1);
  for (const row of favorites) add(Number(row.series_id), 4);
  for (const row of progress) {
    const watched = Number(row.watched_count) || 0;
    if (watched <= 0) continue;
    const total = Number(row.total_episodes) || 0;
    const ratio = total > 0 ? Math.min(1, watched / total) : 0;
    const id = Number(row.series_id);
    add(id, 1.5 * ratio);
    if (ratio >= 0.95) add(id, 1);
    if (row.last_watched) {
      const age = now - new Date(row.last_watched).getTime();
      if (age < 30 * DAY_MS) add(id, 1.5);
      else if (age < 180 * DAY_MS) add(id, 0.75);
    }
  }
  // The user's ratings scale what the engagement above added up to. A zero stays in the map (so the
  // show is still "known" and never suggested) but is not used as a seed.
  const favoriteIds = new Set(favorites.map((row) => Number(row.series_id)));
  for (const [id, weight] of weights) {
    weights.set(id, weight * ratingFactor(ratings.get(id), favoriteIds.has(id)));
  }
  return weights;
}

async function buildRankedList(uid) {
  const history = await loadHistory(uid);
  const weights = seedWeights(history);

  // Everything the user already has is excluded from the suggestions.
  const known = new Set(weights.keys());
  for (const row of history.progress) known.add(Number(row.series_id));
  for (const id of history.inactive || []) known.add(id);

  const seeds = [...weights.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_COUNT);

  const ranked = seeds.length ? await rankFromSeeds(seeds, known) : [];
  if (ranked.length >= MIN_RANKED) return ranked.slice(0, MAX_RESULTS);

  // Cold start, or a thin history on an obscure show: fill with popular so the
  // list is never empty.
  const taken = new Set(ranked.map((show) => show.id));
  const filled = [...ranked];
  for (const page of [1, 2]) {
    let popular;
    try {
      popular = await getDiscovery('popular', { page });
    } catch (error) {
      if (filled.length) break;
      throw error;
    }
    for (const show of popular.results || []) {
      if (known.has(show.id) || taken.has(show.id)) continue;
      taken.add(show.id);
      filled.push(show);
    }
  }
  return filled.slice(0, MAX_RESULTS);
}

async function rankFromSeeds(seeds, known) {
  // One failed lookup should not sink the list, so each seed settles alone.
  const [recommendations, seedShows] = await Promise.all([
    Promise.allSettled(seeds.map(([id]) => getTvRecommendations(id))),
    Promise.allSettled(seeds.map(([id]) => getTvShowClassificationData(id))),
  ]);

  // The user's taste in genres: seed genres weighted like the seeds themselves.
  const genreWeight = new Map();
  let genreTotal = 0;
  seeds.forEach(([, weight], index) => {
    const show = seedShows[index];
    if (show.status !== 'fulfilled') return;
    for (const genre of show.value.genres || []) {
      genreWeight.set(genre.id, (genreWeight.get(genre.id) || 0) + weight);
      genreTotal += weight;
    }
  });

  const candidates = new Map();
  seeds.forEach(([, weight], index) => {
    const result = recommendations[index];
    if (result.status !== 'fulfilled') return;
    for (const show of result.value.results || []) {
      if (known.has(show.id)) continue;
      if ((show.vote_count || 0) < MIN_VOTE_COUNT) continue;
      const candidate = candidates.get(show.id) || { show, seedScore: 0 };
      candidate.seedScore += weight;
      candidates.set(show.id, candidate);
    }
  });

  return [...candidates.values()]
    .map(({ show, seedScore }) => {
      let genreScore = 0;
      if (genreTotal > 0) {
        for (const id of show.genre_ids || []) genreScore += genreWeight.get(id) || 0;
        genreScore /= genreTotal;
      }
      const score = seedScore + 2 * genreScore + ((show.vote_average || 0) / 10) * 0.5;
      return { show, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ show }) => show);
}

module.exports = { getRecommendations, invalidateRecommendations, loadHistory, ratingFactor, seedWeights };
