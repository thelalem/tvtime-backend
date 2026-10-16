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
    json: async () => href.pathname.endsWith('/10736237') ? ({
      tv_episode_results: [{ show_id: 281666, season_number: 1, episode_number: 3, name: 'x' }],
    }) : href.pathname.endsWith('/search/movie') ? ({
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
const { findEpisodeByTvdbId, findMovieByTitle, findTmdbId, pickMovieByTitle } = require('../src/tmdb');

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
  assert.equal(await findMovieByTitle('my oxford year!', { year: 2025 }), 1307078);
  assert.equal(await findMovieByTitle('My Oxford Year', { year: 2024 }), 1307078, 'a year either side is allowed');
  assert.equal(await findMovieByTitle('My Oxford Year', { year: 2010 }), null);
  assert.equal(await findMovieByTitle('Oxford', { year: 2025 }), null);
  assert.equal(await findMovieByTitle('', { year: 2025 }), null);
});

test('an episode is placed by its TVDB id, and an unknown one is null', async () => {
  assert.deepEqual(await findEpisodeByTvdbId('10736237'), { show: 281666, season: 1, episode: 3 });
  assert.equal(await findEpisodeByTvdbId('4'), null);
});

const movie = (id, title, date, votes, original) => ({ id, title, original_title: original || title, release_date: date, vote_count: votes });

test('without a year: one exact title wins; several only when one clearly dominates; none when unclear', () => {
  const titanic = [movie(1, 'Titanic', '1997-11-18', 25000), movie(2, 'Titanic', '1953-04-11', 300), movie(3, 'Titanic II', '2010-01-01', 900)];
  assert.equal(pickMovieByTitle(titanic, 'Titanic'), 1, 'the best-known dominates the other exact title');
  const angels = [movie(10, "Charlie's Angels", '2000-11-02', 4600), movie(11, "Charlie's Angels", '2019-11-14', 2900)];
  assert.equal(pickMovieByTitle(angels, "Charlie's Angels"), null, 'too close: ambiguous');
  assert.equal(pickMovieByTitle(angels, "Charlie's Angels", { before: '2019-12-01' }), null, 'both were out by then');
  assert.equal(pickMovieByTitle(angels, "Charlie's Angels", { before: '2005-01-01' }), 10, 'only one was out by the day it was watched');
  assert.equal(pickMovieByTitle([movie(20, 'Avengers: Endgame', '2019-04-24', 25000)], 'Avengers Endgame'), 20);
  assert.equal(pickMovieByTitle([movie(30, 'Something Else', '2019-01-01', 5)], 'Avengers: Endgame'), null);
  assert.equal(pickMovieByTitle([], 'Titanic'), null);
});

test('titles in another language match the original title; accents and punctuation do not matter', () => {
  const wandering = [movie(40, 'The Wandering Earth', '2019-02-05', 3000, '流浪地球')];
  assert.equal(pickMovieByTitle(wandering, '流浪地球'), 40);
  assert.equal(pickMovieByTitle([movie(41, 'Amélie', '2001-04-25', 9000)], 'Amelie', { year: 2001 }), 41);
  assert.equal(pickMovieByTitle([movie(42, "F*ck Valentine's Day", '2019-02-14', 40)], 'F*ck Valentines Day'), 42);
});
