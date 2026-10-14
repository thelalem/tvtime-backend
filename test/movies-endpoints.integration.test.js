// Runs the real movie routes and SQL against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is
// set (and deliberately NOT DATABASE_URL, so running the tests can never be pointed at a production
// database by accident):
//
//   docker compose up -d db
//   TEST_DATABASE_URL=postgres://tv_time:tv_time_dev@localhost:5432/tv_time npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('movie endpoint integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

// Firebase and TMDB are replaced; the database is real. A bearer token is simply taken to be the
// user's uid.
const movies = {
  101: { id: 101, title: 'Old Movie', release_date: '2000-01-01', runtime: 100, genres: [{ id: 18 }, { id: 35 }], vote_average: 7, belongs_to_collection: { id: 900, name: 'Old Series' } },
  102: { id: 102, title: 'Future Movie', release_date: '2999-01-01', runtime: 120, genres: [{ id: 18 }] },
  103: { id: 103, title: 'No Date Movie', release_date: '', runtime: null, genres: [], belongs_to_collection: { id: 901, name: 'Other Series' } },
  104: { id: 104, title: 'Another Old One', release_date: '1999-05-05', runtime: 90, genres: [{ id: 35 }] },
  201: { id: 201, title: 'Suggested A', release_date: '2010-01-01', runtime: 95, genres: [{ id: 18 }] },
};
// TMDB's collections: every part, including ones not out yet.
const collections = {
  900: {
    id: 900,
    name: 'Old Series',
    parts: [
      { id: 101, title: 'Old Movie', release_date: '2000-01-01' },
      { id: 105, title: 'Out Already', release_date: '2005-05-05' },
      { id: 106, title: 'Far Future Sequel', release_date: '2999-01-01', poster_path: '/p106.jpg', vote_average: 0 },
      { id: 107, title: 'Nearer Future Sequel', release_date: '2998-06-01', overview: 'Soon' },
      { id: 108, title: 'No Date Yet', release_date: '' },
      { id: 104, title: 'Another Old One', release_date: '2999-12-31' },
    ],
  },
  901: {
    id: 901,
    name: 'Other Series',
    parts: [
      { id: 103, title: 'No Date Movie', release_date: '' },
      { id: 109, title: 'Other Series Sequel', release_date: '2997-03-03' },
      { id: 106, title: 'Far Future Sequel', release_date: '2999-01-01' },
    ],
  },
};
const recommendationsOf = {
  101: [
    { id: 101, title: 'Itself', vote_count: 900, genre_ids: [18], vote_average: 8 },
    { id: 201, title: 'Suggested A', vote_count: 900, genre_ids: [18], vote_average: 8 },
    { id: 202, title: 'Suggested B', vote_count: 5, genre_ids: [18], vote_average: 9 },
  ],
};
const tmdbCalls = { getMovie: 0, getCollection: 0 };
const tmdbStub = {
  getMovie: async (id) => {
    tmdbCalls.getMovie += 1;
    if (!movies[id]) {
      const error = new Error('Provider request failed');
      error.providerStatus = 404;
      throw error;
    }
    return movies[id];
  },
  getMovieRecommendations: async (id) => ({ results: recommendationsOf[id] || [] }),
  getCollection: async (id) => {
    tmdbCalls.getCollection += 1;
    if (!collections[id]) throw new Error('no such collection');
    return collections[id];
  },
  getDiscovery: async () => ({
    results: [
      { id: 101, title: 'Popular but tracked', vote_count: 9999, genre_ids: [18] },
      { id: 301, title: 'Popular', vote_count: 9999, genre_ids: [35] },
    ],
  }),
  withImdbRatings: async (list) => list,
  // user-data.js needs these names to load; the movie tests never call them.
  getTvSeason: async () => ({}),
  getTvShowClassificationData: async () => ({}),
};
const stubs = {
  './firebase': {
    admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token, email: `${token}@example.test` }) }) },
  },
  './upcoming': { getUpcomingEpisodes: async () => [] },
  './tmdb': tmdbStub,
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  const owner = parent && parent.filename ? parent.filename : '';
  const wantsStub = /(user-data|me-movies|movie-recommendations|recommendations|sequels)\.js$/.test(owner);
  if (wantsStub && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};

const express = require('express');
const { localDateString } = require('../src/local-date');
const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { router } = require('../src/user-data');
const { seedWeights } = require('../src/movie-recommendations');

const users = [];
let server;
let base;

function newUser() {
  const uid = `it-movies-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  users.push(uid);
  return uid;
}

async function api(uid, method, route, body) {
  const response = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${uid}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const today = () => localDateString('UTC');

test.before(async () => {
  await initializeDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  app.use((error, _request, response, _next) => {
    response.status(error.status || 500).json({ detail: error.message });
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (users.length) await pool.query('DELETE FROM app_users WHERE firebase_uid = ANY($1)', [users]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('adding is idempotent and keeps the added date and watched date', async () => {
  const uid = newUser();
  const first = await api(uid, 'PUT', '/me/movies/watchlist/101');
  assert.equal(first.status, 200);
  assert.equal(first.body.title, 'Old Movie');
  assert.equal(first.body.watchedOn, null);
  assert.equal(first.body.runtime, 100);

  await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: '2020-02-02' });
  const again = await api(uid, 'PUT', '/me/movies/watchlist/101');
  assert.equal(again.body.addedAt, first.body.addedAt);
  assert.equal(again.body.watchedOn, '2020-02-02', 're-adding must not clear the watched date');

  const list = await api(uid, 'GET', '/me/movies/watchlist');
  assert.equal(list.body.length, 1);
});

test('ticking a movie that is not on the list adds it, with the chosen date', async () => {
  const uid = newUser();
  const ticked = await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: today() });
  assert.equal(ticked.status, 200);
  assert.equal(ticked.body.watchedOn, today());

  const list = await api(uid, 'GET', '/me/movies/watchlist');
  assert.deepEqual(list.body.map((movie) => movie.id), [101]);
});

test('the release date is a valid choice, and so is any past day', async () => {
  const uid = newUser();
  const onRelease = await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: '2000-01-01' });
  assert.equal(onRelease.status, 200);
  assert.equal(onRelease.body.watchedOn, '2000-01-01');
});

test('an unreleased movie cannot be ticked, and is not added by the attempt', async () => {
  const uid = newUser();
  const refused = await api(uid, 'PUT', '/me/movies/watchlist/102/watched', { date: today() });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'not_released');
  assert.equal(refused.body.releaseDate, '2999-01-01');
  assert.deepEqual((await api(uid, 'GET', '/me/movies/watchlist')).body, []);

  // Adding it to the watchlist is still allowed.
  assert.equal((await api(uid, 'PUT', '/me/movies/watchlist/102')).status, 200);
});

test('a movie with no release date on record can still be ticked', async () => {
  const uid = newUser();
  const ticked = await api(uid, 'PUT', '/me/movies/watchlist/103/watched', { date: today() });
  assert.equal(ticked.status, 200);
});

test('bad dates are refused: malformed, impossible, or in the future', async () => {
  const uid = newUser();
  for (const date of [undefined, '', 'yesterday', '2020-13-01', '2020-02-30', '20-02-02']) {
    const response = await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date });
    assert.equal(response.status, 400, String(date));
    assert.equal(response.body.error, 'invalid_date', String(date));
  }
  const future = await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: '2999-01-01' });
  assert.equal(future.status, 400);
  assert.equal(future.body.error, 'date_in_future');
  assert.deepEqual((await api(uid, 'GET', '/me/movies/watchlist')).body, []);
});

test("'today' follows the user's timezone, not the server's", async () => {
  const uid = newUser();
  await api(uid, 'GET', '/me'); // creates the user row
  await pool.query('UPDATE app_users SET timezone = $2 WHERE firebase_uid = $1', [uid, 'Pacific/Kiritimati']);
  const localToday = localDateString('Pacific/Kiritimati');
  const ticked = await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: localToday });
  assert.equal(ticked.status, 200, `UTC+14 today (${localToday}) must be accepted`);
});

test('un-ticking clears the date and keeps the movie on the watchlist', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: today() });
  const unticked = await api(uid, 'DELETE', '/me/movies/watchlist/101/watched');
  assert.equal(unticked.status, 200);
  assert.equal(unticked.body.watchedOn, null);

  const list = await api(uid, 'GET', '/me/movies/watchlist');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].watchedOn, null);

  const missing = await api(uid, 'DELETE', '/me/movies/watchlist/104/watched');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_in_watchlist');
});

test('removing is a clean wipe of the list and the watched date, but not of favorites', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: today() });
  await api(uid, 'PUT', '/me/movies/favorites/101');

  const removed = await api(uid, 'DELETE', '/me/movies/watchlist/101');
  assert.equal(removed.status, 204);
  assert.deepEqual((await api(uid, 'GET', '/me/movies/watchlist')).body, []);
  assert.deepEqual((await api(uid, 'GET', '/me/movies/stats')).body, { watchedCount: 0, watchedMinutes: 0 });
  assert.equal((await api(uid, 'GET', '/me/movies/favorites')).body.length, 1);

  // Adding it again starts from scratch: not watched.
  const readded = await api(uid, 'PUT', '/me/movies/watchlist/101');
  assert.equal(readded.body.watchedOn, null);
});

test('favorites can be added, listed and removed', async () => {
  const uid = newUser();
  const added = await api(uid, 'PUT', '/me/movies/favorites/104');
  assert.equal(added.status, 200);
  assert.equal(added.body.title, 'Another Old One');
  assert.deepEqual((await api(uid, 'GET', '/me/movies/favorites')).body.map((m) => m.id), [104]);
  assert.equal((await api(uid, 'DELETE', '/me/movies/favorites/104')).status, 204);
  assert.deepEqual((await api(uid, 'GET', '/me/movies/favorites')).body, []);
});

test('stats count watched movies and add up their runtimes', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: today() }); // 100 min
  await api(uid, 'PUT', '/me/movies/watchlist/104/watched', { date: today() }); // 90 min
  await api(uid, 'PUT', '/me/movies/watchlist/103/watched', { date: today() }); // no runtime
  await api(uid, 'PUT', '/me/movies/watchlist/102'); // on the list, not watched
  const stats = await api(uid, 'GET', '/me/movies/stats');
  assert.deepEqual(stats.body, { watchedCount: 3, watchedMinutes: 190 });

  const empty = await api(newUser(), 'GET', '/me/movies/stats');
  assert.deepEqual(empty.body, { watchedCount: 0, watchedMinutes: 0 }, 'zero, not missing');
});

test('movies belong to the user who added them', async () => {
  const mine = newUser();
  const theirs = newUser();
  await api(mine, 'PUT', '/me/movies/watchlist/101/watched', { date: today() });
  assert.deepEqual((await api(theirs, 'GET', '/me/movies/watchlist')).body, []);
  assert.equal((await api(theirs, 'GET', '/me/movies/stats')).body.watchedCount, 0);
});

test('an unknown movie is a 404, and a junk id a 400', async () => {
  const uid = newUser();
  const missing = await api(uid, 'PUT', '/me/movies/watchlist/999999');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'movie_not_found');
  assert.equal((await api(uid, 'PUT', '/me/movies/watchlist/abc')).status, 400);
  assert.equal((await api(uid, 'PUT', '/me/movies/watchlist/0')).status, 400);
});

test('the movie routes need a signed-in user', async () => {
  const response = await fetch(`${base}/api/v1/me/movies/watchlist`);
  assert.equal(response.status, 401);
});

test('Movies for you: a new account gets popular movies; a tracked movie never appears', async () => {
  const fresh = await api(newUser(), 'GET', '/me/movies/recommendations');
  assert.equal(fresh.status, 200);
  assert.ok(fresh.body.results.length > 0, 'cold start is not empty');

  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: today() });
  const mine = await api(uid, 'GET', '/me/movies/recommendations');
  const ids = mine.body.results.map((movie) => movie.id);
  assert.ok(!ids.includes(101), 'the movie the user already has is never suggested');
  assert.ok(ids.includes(201), 'a recommendation of a seed is suggested');
  assert.ok(!ids.includes(202), 'a movie with too few votes is dropped');
});

test('adding a movie refreshes the suggestions at once', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101');
  const before = (await api(uid, 'GET', '/me/movies/recommendations')).body.results.map((m) => m.id);
  assert.ok(before.includes(201));

  await api(uid, 'PUT', '/me/movies/favorites/201');
  const after = (await api(uid, 'GET', '/me/movies/recommendations')).body.results.map((m) => m.id);
  assert.ok(!after.includes(201), 'cache was invalidated: the favorite is no longer suggested');
});

test('seed weights: favorite > recently watched > watched > just added', () => {
  const now = Date.parse('2026-10-14T00:00:00Z');
  const weights = seedWeights({
    watchlist: [
      { movie_id: '1', watched_on: null },
      { movie_id: '2', watched_on: '2020-01-01' },
      { movie_id: '3', watched_on: '2026-10-10' },
    ],
    favorites: [{ movie_id: '4' }],
  }, now);
  assert.equal(weights.get(1), 1);
  assert.equal(weights.get(2), 3);
  assert.equal(weights.get(3), 4.5);
  assert.equal(weights.get(4), 4);
  assert.ok(weights.get(3) > weights.get(2) && weights.get(2) > weights.get(1));
});

test('upcoming sequels: future parts of the collections of every listed movie, soonest first', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101'); // on the list, not even watched
  const { status, body } = await api(uid, 'GET', '/me/movies/upcoming-sequels');
  assert.equal(status, 200);
  // 104 is a future part of the same collection; 105 is already out; 108 has no date.
  assert.deepEqual(body.map((movie) => movie.id), [107, 106, 104]);
  const first = body[0];
  assert.equal(first.title, 'Nearer Future Sequel');
  assert.equal(first.release_date, '2998-06-01');
  assert.equal(first.sequel_to, 'Old Movie');
  assert.equal(first.collection_name, 'Old Series');
  assert.equal(first.overview, 'Soon');
});

test('upcoming sequels: a sequel the user already has is not suggested, and a watched movie counts too', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101/watched', { date: today() });
  await api(uid, 'PUT', '/me/movies/watchlist/104'); // has a future date in the collection
  const ids = (await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.map((movie) => movie.id);
  assert.deepEqual(ids, [107, 106]);
});

test('upcoming sequels: a movie in two collections is listed once; nothing for a movie in none', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101');
  await api(uid, 'PUT', '/me/movies/watchlist/103');
  const ids = (await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.map((movie) => movie.id);
  assert.deepEqual(ids, [109, 107, 106, 104], '106 is in both collections but appears once');

  const lonely = newUser();
  await api(lonely, 'PUT', '/me/movies/watchlist/201'); // no collection
  assert.deepEqual((await api(lonely, 'GET', '/me/movies/upcoming-sequels')).body, []);
  assert.deepEqual((await api(newUser(), 'GET', '/me/movies/upcoming-sequels')).body, []);
});

test('upcoming sequels: hiding one removes it, restoring brings it back, and hiding is per user', async () => {
  const uid = newUser();
  const other = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101');
  await api(other, 'PUT', '/me/movies/watchlist/101');

  assert.equal((await api(uid, 'PUT', '/me/movies/sequels/107/dismissed')).status, 204);
  assert.equal((await api(uid, 'PUT', '/me/movies/sequels/107/dismissed')).status, 204, 'idempotent');
  const mine = (await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.map((movie) => movie.id);
  assert.deepEqual(mine, [106, 104]);
  const theirs = (await api(other, 'GET', '/me/movies/upcoming-sequels')).body.map((movie) => movie.id);
  assert.deepEqual(theirs, [107, 106, 104], 'nobody else is affected');

  assert.equal((await api(uid, 'DELETE', '/me/movies/sequels/107/dismissed')).status, 204);
  const restored = (await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.map((movie) => movie.id);
  assert.deepEqual(restored, [107, 106, 104]);
  assert.equal((await api(uid, 'PUT', '/me/movies/sequels/abc/dismissed')).status, 400);
});

test('upcoming sequels: adding the sequel itself removes it from the suggestions at once', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101');
  assert.ok((await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.some((movie) => movie.id === 104));
  await api(uid, 'PUT', '/me/movies/watchlist/104');
  assert.ok(!(await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.some((movie) => movie.id === 104));
});

test('upcoming sequels: a movie saved before collections were kept is filled in on first use', async () => {
  const uid = newUser();
  await api(uid, 'GET', '/me'); // creates the user row
  const legacy = { id: 101, title: 'Old Movie', release_date: '2000-01-01', runtime: 100, genre_ids: [18] };
  await pool.query(
    'INSERT INTO movie_watchlist(firebase_uid, movie_id, movie) VALUES ($1, 101, $2::jsonb)',
    [uid, JSON.stringify(legacy)],
  );
  const before = tmdbCalls.getMovie;
  const ids = (await api(uid, 'GET', '/me/movies/upcoming-sequels')).body.map((movie) => movie.id);
  assert.deepEqual(ids, [107, 106, 104]);
  assert.equal(tmdbCalls.getMovie, before + 1, 'looked up once');

  const { rows } = await pool.query(
    'SELECT movie FROM movie_watchlist WHERE firebase_uid = $1 AND movie_id = 101',
    [uid],
  );
  assert.deepEqual(rows[0].movie.collection, { id: 900, name: 'Old Series' }, 'saved for next time');
  assert.equal(rows[0].movie.title, 'Old Movie', 'the rest of the row is untouched');
});

test('upcoming sequels: a movie in no collection is remembered as such, not looked up again', async () => {
  const uid = newUser();
  await api(uid, 'GET', '/me');
  await pool.query(
    'INSERT INTO movie_watchlist(firebase_uid, movie_id, movie) VALUES ($1, 104, $2::jsonb)',
    [uid, JSON.stringify({ id: 104, title: 'Another Old One', release_date: '1999-05-05' })],
  );
  await api(uid, 'GET', '/me/movies/upcoming-sequels');
  const { rows } = await pool.query(
    "SELECT movie ? 'collection' AS has, movie->'collection' AS collection FROM movie_watchlist WHERE firebase_uid = $1",
    [uid],
  );
  assert.equal(rows[0].has, true);
  assert.equal(rows[0].collection, null);
});

test('upcoming sequels: the same user asking twice in a row asks TMDB once', async () => {
  const uid = newUser();
  await api(uid, 'PUT', '/me/movies/watchlist/101');
  await api(uid, 'GET', '/me/movies/upcoming-sequels');
  const calls = tmdbCalls.getCollection;
  await api(uid, 'GET', '/me/movies/upcoming-sequels');
  assert.equal(tmdbCalls.getCollection, calls);
});

test('upcoming sequels: they need a signed-in user', async () => {
  const response = await fetch(`${base}/api/v1/me/movies/upcoming-sequels`);
  assert.equal(response.status, 401);
});
