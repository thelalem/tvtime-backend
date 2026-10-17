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
const { findEpisodeByTvdbId, findMovieByTitle, findTmdbId, pickMovieByTitle, pickShowByTitle } = require('../src/tmdb');

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

test('no exact title: the search result of that year (or out by the watch day), if it is the only one or dominates', () => {
  assert.equal(pickMovieByTitle([movie(50, "National Lampoon's Van Wilder", '2002-04-05', 900)], 'Van Wilder', { year: 2002 }), 50);
  assert.equal(pickMovieByTitle([movie(51, 'Thunderbolts*', '2025-04-30', 3000)], 'Thunderbolts*: *The New Avengers', { year: 2025 }), 51);
  assert.equal(pickMovieByTitle([
    movie(52, 'The Fantastic 4: First Steps', '2025-07-23', 2500),
    movie(53, 'Marvel Studios\' The Fantastic Four: First Steps - World Premiere', '2025-07-21', 3),
  ], 'The Fantastic Four: First Steps', { year: 2025 }), 52, 'the film dominates its premiere special');
  assert.equal(pickMovieByTitle([movie(54, 'Wish Dragon', '2021-01-15', 400)], '许愿神龙', { before: '2022-01-01' }), 54);
  assert.equal(pickMovieByTitle([movie(54, 'Wish Dragon', '2021-01-15', 400)], '许愿神龙'), null, 'no year and no watch day: too vague');
  assert.equal(pickMovieByTitle([movie(55, 'Some Film', '2001-01-01', 400)], 'Other Film', { year: 2020 }), null, 'not that year');
  assert.equal(pickMovieByTitle([movie(56, 'A', '2020-01-01', 400), movie(57, 'B', '2020-01-01', 300)], 'Something', { year: 2020 }), null, 'two close');
  assert.equal(pickMovieByTitle([movie(58, 'Up', '2009-05-28', 9000)], 'Upp', { year: 2009 }), null, 'too short to trust');
  assert.equal(pickMovieByTitle([
    movie(59, "Charlie's Angels", '2000-11-02', 4600), movie(60, "Charlie's Angels", '2000-01-01', 4000),
  ], "Charlie's Angels", { before: '2010-01-01' }), null, 'exact but ambiguous titles are not handed to the fallback');
});

test('a show by title: one exact name (or a dominant one), never a lookalike', () => {
  const show = (id, name, votes) => ({ id, name, original_name: name, vote_count: votes });
  assert.equal(pickShowByTitle([show(2288, 'Prison Break', 3000), show(303464, 'Prison Break: Black Creek', 0)], 'Prison Break'), 2288);
  assert.equal(pickShowByTitle([show(272059, 'TO BE HERO X', 90), show(68135, 'To Be Hero', 40)], 'To Be Hero X'), 272059);
  assert.equal(pickShowByTitle([show(95594, 'Fast & Furious Spy Racers', 200)], 'The Fast and the Furious'), null);
  assert.equal(pickShowByTitle([show(1, 'Shameless', 3000), show(2, 'Shameless', 400)], 'Shameless'), 1, 'US dominates UK');
  assert.equal(pickShowByTitle([show(1, 'The Office', 3000), show(2, 'The Office', 2000)], 'The Office'), null, 'too close');
});
