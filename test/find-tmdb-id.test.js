const test = require('node:test');
const assert = require('node:assert/strict');

// A stand-in for the provider cache table, as in ratings-cache.test.js.
const rows = new Map();
const fakePool = {
  async query(sql, params) {
    if (/^\s*SELECT/i.test(sql)) {
      const [key, ttlMs, emptyTtlMs = ttlMs] = params;
      const row = rows.get(key);
      const life = row && row.data === null ? emptyTtlMs : ttlMs;
      return { rows: row && Date.now() - row.at < life ? [{ data: row.data }] : [] };
    }
    rows.set(params[0], { data: JSON.parse(params[1]), at: Date.now() });
    return { rows: [] };
  },
};
process.env.TMDB_ACCESS_TOKEN = 'test-token';
process.env.TMDB_BASE_URL = 'https://tmdb.test/3';
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };

const requested = [];
const undici = require('undici');
undici.fetch = async (url) => {
  const href = new URL(String(url));
  requested.push(`${href.pathname}?${href.searchParams.get('external_source')}`);
  const known = href.pathname.endsWith('/81189') || href.pathname.endsWith('/tt0163025');
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => href.pathname.endsWith('/search/movie') ? ({
      results: [
        { id: 1, title: 'My Oxford Year Two', release_date: '2025-01-01' },
        { id: 1307078, title: 'My Oxford Year', release_date: '2025-07-31' },
        { id: 3, title: 'My Oxford Year', release_date: '1990-01-01' },
      ],
    }) : ({
      tv_results: known ? [{ id: 1396 }] : [],
      movie_results: known ? [{ id: 331 }] : [],
    }),
  };
};
const { findMovieByTitle, findTmdbId } = require('../src/tmdb');

test('finds a show by TVDB id and a movie by IMDb id, asking TMDB once each', async () => {
  assert.equal(await findTmdbId('tv', '81189'), 1396);
  assert.equal(await findTmdbId('movie', 'tt0163025'), 331);
  assert.equal(await findTmdbId('tv', '81189'), 1396);
  assert.deepEqual(requested, ['/3/find/81189?tvdb_id', '/3/find/tt0163025?imdb_id']);
});

test('an id TMDB does not know is null, and remembered', async () => {
  requested.length = 0;
  assert.equal(await findTmdbId('tv', '5'), null);
  assert.equal(await findTmdbId('tv', '5'), null);
  assert.equal(requested.length, 1);
});

test('a movie is found by exact title and release year, never by a lookalike', async () => {
  assert.equal(await findMovieByTitle('my oxford year!', 2025), 1307078);
  assert.equal(await findMovieByTitle('My Oxford Year', 2024), 1307078, 'a year either side is allowed');
  assert.equal(await findMovieByTitle('My Oxford Year', 2010), null);
  assert.equal(await findMovieByTitle('Oxford', 2025), null);
  assert.equal(await findMovieByTitle('', 2025), null);
});
