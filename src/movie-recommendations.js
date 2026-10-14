const { pool } = require('./db');
const {
  getDiscovery,
  getMovie,
  getMovieRecommendations,
} = require('./tmdb');

// "Movies for you". The same approach as the show version in recommendations.js, seeded from the
// user's movies instead: what they watched, favorited and added.
const PAGE_SIZE = 20;
const SEED_COUNT = 8;
const MAX_RESULTS = 100;
// Fewer ranked movies than this and the list is topped up from popular.
const MIN_RANKED = 40;
const MIN_VOTE_COUNT = 50;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_USERS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

// uid -> { at, list } or { pending }. Short-lived: it only has to absorb the Explore row plus the
// see-all page asking for the same ranking.
const cache = new Map();

function invalidateMovieRecommendations(uid) {
  cache.delete(uid);
}

async function getMovieRecommendationsFor(uid, page) {
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
      // A change while this was running invalidated the entry; do not put the outdated list back.
      if (cache.get(uid) === startedWith) {
        cache.set(uid, { at: Date.now(), list });
        while (cache.size > CACHE_MAX_USERS) cache.delete(cache.keys().next().value);
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

async function loadHistory(uid) {
  const [watchlist, favorites] = await Promise.all([
    pool.query(
      `SELECT movie_id, to_char(watched_on, 'YYYY-MM-DD') AS watched_on
       FROM movie_watchlist WHERE firebase_uid = $1`,
      [uid],
    ),
    pool.query('SELECT movie_id FROM movie_favorites WHERE firebase_uid = $1', [uid]),
  ]);
  return { watchlist: watchlist.rows, favorites: favorites.rows };
}

// How strongly each movie should steer the list: favorite > watched (more so when recent) >
// just added.
function seedWeights({ watchlist, favorites }, now = Date.now()) {
  const weights = new Map();
  const add = (id, amount) => weights.set(id, (weights.get(id) || 0) + amount);

  for (const row of watchlist) {
    const id = Number(row.movie_id);
    add(id, 1);
    if (!row.watched_on) continue;
    add(id, 2);
    const age = now - new Date(`${row.watched_on}T00:00:00Z`).getTime();
    if (age < 30 * DAY_MS) add(id, 1.5);
    else if (age < 180 * DAY_MS) add(id, 0.75);
  }
  for (const row of favorites) add(Number(row.movie_id), 4);
  return weights;
}

async function buildRankedList(uid) {
  const history = await loadHistory(uid);
  const weights = seedWeights(history);

  // Everything the user already has is excluded from the suggestions.
  const known = new Set(weights.keys());

  const seeds = [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_COUNT);

  const ranked = seeds.length ? await rankFromSeeds(seeds, known) : [];
  if (ranked.length >= MIN_RANKED) return ranked.slice(0, MAX_RESULTS);

  // Cold start, or a thin history: fill with popular so the list is never empty.
  const taken = new Set(ranked.map((movie) => movie.id));
  const filled = [...ranked];
  for (const page of [1, 2]) {
    let popular;
    try {
      popular = await getDiscovery('movie_popular', { page });
    } catch (error) {
      if (filled.length) break;
      throw error;
    }
    for (const movie of popular.results || []) {
      if (known.has(movie.id) || taken.has(movie.id)) continue;
      taken.add(movie.id);
      filled.push(movie);
    }
  }
  return filled.slice(0, MAX_RESULTS);
}

async function rankFromSeeds(seeds, known) {
  // One failed lookup should not sink the list, so each seed settles alone.
  const [recommendations, seedMovies] = await Promise.all([
    Promise.allSettled(seeds.map(([id]) => getMovieRecommendations(id))),
    Promise.allSettled(seeds.map(([id]) => getMovie(id))),
  ]);

  // The user's taste in genres: seed genres weighted like the seeds themselves.
  const genreWeight = new Map();
  let genreTotal = 0;
  seeds.forEach(([, weight], index) => {
    const movie = seedMovies[index];
    if (movie.status !== 'fulfilled') return;
    for (const genre of movie.value.genres || []) {
      genreWeight.set(genre.id, (genreWeight.get(genre.id) || 0) + weight);
      genreTotal += weight;
    }
  });

  const candidates = new Map();
  seeds.forEach(([, weight], index) => {
    const result = recommendations[index];
    if (result.status !== 'fulfilled') return;
    for (const movie of result.value.results || []) {
      if (known.has(movie.id)) continue;
      if ((movie.vote_count || 0) < MIN_VOTE_COUNT) continue;
      const candidate = candidates.get(movie.id) || { movie, seedScore: 0 };
      candidate.seedScore += weight;
      candidates.set(movie.id, candidate);
    }
  });

  return [...candidates.values()]
    .map(({ movie, seedScore }) => {
      let genreScore = 0;
      if (genreTotal > 0) {
        for (const id of movie.genre_ids || []) genreScore += genreWeight.get(id) || 0;
        genreScore /= genreTotal;
      }
      const score = seedScore + 2 * genreScore + ((movie.vote_average || 0) / 10) * 0.5;
      return { movie, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ movie }) => movie);
}

module.exports = {
  getMovieRecommendationsFor,
  invalidateMovieRecommendations,
  seedWeights,
};
