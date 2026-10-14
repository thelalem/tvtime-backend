const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// A database stand-in (the provider cache writes to it) and a fake TMDB/OMDb behind undici's fetch,
// the way ratings-cache.test.js does it.
const rows = new Map();
const fakePool = {
  async query(sql, params) {
    if (/^\s*SELECT/i.test(sql)) {
      const [key, ttlMs] = params;
      const row = rows.get(key);
      return { rows: row && Date.now() - row.at < ttlMs ? [{ data: row.data }] : [] };
    }
    rows.set(params[0], { data: JSON.parse(params[1]), at: Date.now() });
    return { rows: [] };
  },
};
process.env.TMDB_ACCESS_TOKEN = 'test-token';
process.env.OMDB_API_KEY = 'test-omdb';
process.env.OMDB_BASE_URL = 'https://omdb.test';
process.env.TMDB_BASE_URL = 'https://tmdb.test/3';
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };

const undici = require('undici');
let routes = {};
const requested = [];
undici.fetch = async (url) => {
  const target = new URL(String(url));
  const key = target.host === 'omdb.test'
    ? `omdb:${target.searchParams.get('i')}`
    : target.pathname.replace('/3', '');
  requested.push(target.host === 'omdb.test' ? key : `${key}${target.search}`);
  const body = routes[key];
  return {
    ok: body !== undefined,
    status: body === undefined ? 404 : 200,
    headers: { get: () => null },
    json: async () => body,
  };
};

function fresh() {
  for (const name of ['tmdb.js', 'similar.js', 'persistent-cache.js']) {
    delete require.cache[path.join(__dirname, '..', 'src', name)];
  }
  return { tmdb: require('../src/tmdb'), similar: require('../src/similar') };
}

test.beforeEach(() => {
  rows.clear();
  routes = {};
  requested.length = 0;
});

test('search is one mixed list: people dropped, closest match first, TMDB order otherwise', async () => {
  routes['/search/multi'] = {
    page: 1,
    results: [
      { id: 1, media_type: 'person', name: 'Dark Person' },
      { id: 2, media_type: 'tv', name: 'Dark Matter' },
      { id: 3, media_type: 'movie', title: 'Darkest Hour' },
      { id: 4, media_type: 'tv', name: 'Dark' },
      { id: 5, media_type: 'movie', title: ' dark ' },
      { id: 6, media_type: 'movie', title: 'The Dark Knight' },
    ],
  };
  const { tmdb } = fresh();
  const { results } = await tmdb.searchMulti('Dark');
  assert.deepEqual(
    results.map((item) => [item.id, item.media_type]),
    [[4, 'tv'], [5, 'movie'], [2, 'tv'], [3, 'movie'], [6, 'movie']],
    'exact matches first, then starts-with, then the rest; each keeps its tag',
  );
});

test('a movie and a show with the same id get their own IMDb ratings', async () => {
  routes['/movie/5/external_ids'] = { imdb_id: 'tt0000005' };
  routes['/tv/5/external_ids'] = { imdb_id: 'tt0000006' };
  routes['omdb:tt0000005'] = { Response: 'True', imdbRating: '7.7' };
  routes['omdb:tt0000006'] = { Response: 'True', imdbRating: '8.8' };
  const { tmdb } = fresh();

  const mixed = await tmdb.withImdbRatings({
    results: [
      { id: 5, media_type: 'movie', vote_average: 1 },
      { id: 5, media_type: 'tv', vote_average: 2 },
    ],
  });
  assert.deepEqual(mixed.results.map((item) => item.vote_average), [7.7, 8.8]);
  assert.deepEqual(mixed.results.map((item) => item.tmdb_vote_average), [1, 2]);

  // A list with no tags uses the kind it is given: a movie feed.
  const feed = await tmdb.withImdbRatings({ results: [{ id: 5, vote_average: 1 }] }, 'movie');
  assert.equal(feed.results[0].vote_average, 7.7);
});

test('a movie rating is remembered across a restart, separately from a show with the same id', async () => {
  routes['/movie/5/external_ids'] = { imdb_id: 'tt0000005' };
  routes['omdb:tt0000005'] = { Response: 'True', imdbRating: '7.7' };
  await fresh().tmdb.withImdbRatings({ results: [{ id: 5 }] }, 'movie');
  assert.ok(rows.has('imdbid:movie:5'), 'the movie id mapping is stored under its own key');
  assert.ok(!rows.has('imdbid:5'), 'and does not use the show key');

  const before = requested.length;
  const again = await fresh().tmdb.withImdbRatings({ results: [{ id: 5 }] }, 'movie');
  assert.equal(again.results[0].vote_average, 7.7);
  assert.equal(requested.length, before, 'no provider call after the restart');
});

test('similar movies: movie endpoints, shared genre required, votes required, self removed, topped up', async () => {
  routes['/movie/9'] = { id: 9, genres: [{ id: 28 }] };
  routes['/movie/9/recommendations'] = {
    results: [
      { id: 9, title: 'Itself', genre_ids: [28], vote_count: 500, vote_average: 9 },
      { id: 10, title: 'A', genre_ids: [28, 12], vote_count: 500, vote_average: 7 },
      { id: 11, title: 'No shared genre', genre_ids: [99], vote_count: 500, vote_average: 9 },
      { id: 12, title: 'Too few votes', genre_ids: [28], vote_count: 5, vote_average: 9 },
    ],
  };
  routes['/movie/9/similar'] = {
    results: [{ id: 13, title: 'D', genre_ids: [28], vote_count: 100, vote_average: 6 }],
  };
  routes['/discover/movie'] = {
    results: [
      { id: 14, title: 'E', genre_ids: [28], vote_count: 100 },
      { id: 10, title: 'A again', genre_ids: [28], vote_count: 100 },
    ],
  };
  const { similar } = fresh();
  const { results } = await similar.getSimilarShows(9, 'movie');
  assert.deepEqual(results.map((movie) => movie.id), [10, 13, 14]);
  assert.ok(
    requested.some((entry) => entry.startsWith('/discover/movie?') && entry.includes('with_genres=28')),
    'topped up from the movie discover feed with every genre',
  );
  assert.ok(!requested.some((entry) => entry.startsWith('/tv/')), 'no show endpoint was used');
});

test('similar shows still use the show endpoints', async () => {
  routes['/tv/7'] = { id: 7, genres: [{ id: 35 }] };
  routes['/tv/7/recommendations'] = { results: [{ id: 8, name: 'S', genre_ids: [35], vote_count: 100, vote_average: 7 }] };
  routes['/tv/7/similar'] = { results: [] };
  routes['/discover/tv'] = { results: [] };
  const { results } = await fresh().similar.getSimilarShows(7);
  assert.deepEqual(results.map((show) => show.id), [8]);
  assert.ok(!requested.some((entry) => entry.startsWith('/movie/')));
});
