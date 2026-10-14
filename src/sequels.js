const { pool } = require('./db');
const { getCollection, getMovie } = require('./tmdb');

// Upcoming sequels: for every movie on a user's list (watched or not), the other movies in its TMDB
// collection that have not come out yet and that the user does not already have. A user who has
// Dune on their list sees Dune: Part Three coming; Avengers: Endgame brings Doomsday; and so on.
//
// Collections are curated by TMDB, so a sequel TMDB files elsewhere does not appear, and a movie
// with no release date yet is left out. See FEATURE_PLAN.md, section 4.

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_USERS = 500;
// Older rows were stored before the collection was kept; each is filled in on first use. A cap per
// request keeps a big old list from becoming hundreds of TMDB calls at once.
const BACKFILL_PER_REQUEST = 40;
const BACKFILL_CONCURRENCY = 4;

// uid -> { at, key, list }. `key` is what the list was made for (today's date), so a list made
// yesterday is not served today.
const cache = new Map();

function invalidateUpcomingSequels(uid) {
  cache.delete(uid);
}

// What is stored with a movie so its collection need not be looked up again: the id and name, or
// null for a movie that is in none.
function collectionOf(movie) {
  const collection = movie && movie.belongs_to_collection;
  return collection && collection.id ? { id: collection.id, name: collection.name || '' } : null;
}

async function runLimited(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// The user's listed movies with their collection, filling in rows saved before it was kept.
async function loadListedMovies(uid) {
  const { rows } = await pool.query(
    `SELECT movie_id, movie, movie ? 'collection' AS has_collection
     FROM movie_watchlist WHERE firebase_uid = $1`,
    [uid],
  );
  const missing = rows.filter((row) => !row.has_collection).slice(0, BACKFILL_PER_REQUEST);
  await runLimited(missing, BACKFILL_CONCURRENCY, async (row) => {
    try {
      const collection = collectionOf(await getMovie(row.movie_id));
      await pool.query(
        `UPDATE movie_watchlist SET movie = movie || jsonb_build_object('collection', $3::jsonb)
         WHERE firebase_uid = $1 AND movie_id = $2`,
        [uid, row.movie_id, JSON.stringify(collection)],
      );
      row.movie = { ...row.movie, collection };
    } catch (error) {
      // Left for the next request; one movie TMDB cannot answer must not hide the rest.
      console.error(`[sequels] collection lookup failed for movie ${row.movie_id}: ${error.message}`);
    }
  });
  return rows.map((row) => ({
    id: Number(row.movie_id),
    title: row.movie.title || '',
    releaseDate: row.movie.release_date || '',
    collection: row.movie.collection || null,
  }));
}

async function buildList(uid, today) {
  const [listed, dismissedResult] = await Promise.all([
    loadListedMovies(uid),
    pool.query('SELECT movie_id FROM dismissed_sequels WHERE firebase_uid = $1', [uid]),
  ]);
  const dismissed = new Set(dismissedResult.rows.map((row) => Number(row.movie_id)));
  const have = new Set(listed.map((movie) => movie.id));

  const byCollection = new Map();
  for (const movie of listed) {
    if (!movie.collection) continue;
    const group = byCollection.get(movie.collection.id) || [];
    group.push(movie);
    byCollection.set(movie.collection.id, group);
  }

  const collections = [...byCollection.keys()];
  const loaded = await runLimited(collections, BACKFILL_CONCURRENCY, async (id) => {
    try {
      return await getCollection(id);
    } catch (error) {
      console.error(`[sequels] collection ${id} unavailable: ${error.message}`);
      return null;
    }
  });

  const found = new Map();
  collections.forEach((collectionId, index) => {
    const collection = loaded[index];
    if (!collection || !Array.isArray(collection.parts)) return;
    const mine = byCollection.get(collectionId);
    for (const part of collection.parts) {
      const date = part.release_date || '';
      if (!date || date <= today) continue;
      if (have.has(part.id) || dismissed.has(part.id) || found.has(part.id)) continue;
      // "Sequel to" the movie of this collection the user has that came out latest before it.
      const before = mine
        .filter((movie) => movie.releaseDate && movie.releaseDate <= date)
        .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
      const anchor = before[0] || mine[0];
      found.set(part.id, {
        id: part.id,
        title: part.title || part.original_title || '',
        overview: part.overview || '',
        poster_path: part.poster_path || null,
        backdrop_path: part.backdrop_path || null,
        vote_average: Number(part.vote_average) || 0,
        release_date: date,
        sequel_to: anchor.title,
        collection_name: collection.name || '',
      });
    }
  });

  return [...found.values()].sort(
    (a, b) => a.release_date.localeCompare(b.release_date) || a.title.localeCompare(b.title),
  );
}

async function getUpcomingSequels(uid, today) {
  const entry = cache.get(uid);
  if (entry && entry.key === today && Date.now() - entry.at < CACHE_TTL_MS) return entry.list;

  const list = await buildList(uid, today);
  cache.set(uid, { at: Date.now(), key: today, list });
  while (cache.size > CACHE_MAX_USERS) cache.delete(cache.keys().next().value);
  return list;
}

module.exports = { collectionOf, getUpcomingSequels, invalidateUpcomingSequels };
