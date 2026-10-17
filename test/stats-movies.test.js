const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStats } = require('../src/stats-logic');

const NOW = new Date('2026-10-17T10:00:00Z');
const movie = (movieId, extra = {}) => ({
  movieId, title: `Movie ${movieId}`, watchedOn: '2026-10-01', runtime: 100, posterPath: `/p${movieId}.jpg`,
  releaseDate: '2010-05-01', genreIds: [28], ...extra,
});
const stats = (movies) => computeStats({ shows: [], movies, timezone: 'UTC', now: NOW }).movieStats;

test('movie stats: nothing watched is all zeros and empty lists', () => {
  const result = stats([]);
  assert.equal(result.watched, 0);
  assert.equal(result.minutes, 0);
  assert.equal(result.averageRuntime, 0);
  assert.deepEqual(result.months, []);
  assert.equal(result.busiestMonth, null);
  assert.equal(result.longest, null);
  assert.equal(result.shortest, null);
  assert.equal(result.firstDate, null);
});

test('movie stats: count, time, average and this year, ignoring movies with no watch date', () => {
  const result = stats([
    movie(1, { runtime: 90, watchedOn: '2026-03-02' }),
    movie(2, { runtime: 150, watchedOn: '2025-12-30' }),
    movie(3, { watchedOn: null }),
  ]);
  assert.equal(result.watched, 2);
  assert.equal(result.minutes, 240);
  assert.equal(result.averageRuntime, 120);
  assert.equal(result.thisYear, 1);
  assert.equal(result.firstDate, '2025-12-30');
  assert.equal(result.latestDate, '2026-03-02');
});

test('movie stats: a movie without a runtime adds no minutes and is left out of the average and the extremes', () => {
  const result = stats([movie(1, { runtime: 120 }), movie(2, { runtime: null }), movie(3, { runtime: 0 })]);
  assert.equal(result.watched, 3);
  assert.equal(result.minutes, 120);
  assert.equal(result.averageRuntime, 120);
  assert.equal(result.unknownRuntime, 2);
  assert.equal(result.longest.movieId, 1);
  assert.equal(result.shortest.movieId, 1);
});

test('movie stats: longest and shortest with their poster and runtime', () => {
  const result = stats([movie(1, { runtime: 95 }), movie(2, { runtime: 181 }), movie(3, { runtime: 70 })]);
  assert.deepEqual(result.longest, {
    movieId: 2, title: 'Movie 2', posterPath: '/p2.jpg', runtime: 181, date: '2026-10-01',
  });
  assert.equal(result.shortest.movieId, 3);
  assert.equal(result.shortest.runtime, 70);
});

test('movie stats: months run from the first to the last with empty ones between, and the busiest is named', () => {
  const result = stats([
    movie(1, { watchedOn: '2026-01-10', runtime: 100 }),
    movie(2, { watchedOn: '2026-04-02', runtime: 90 }),
    movie(3, { watchedOn: '2026-04-20', runtime: 110 }),
  ]);
  assert.deepEqual(result.months.map((item) => [item.month, item.movies, item.minutes]), [
    ['2026-01', 1, 100], ['2026-02', 0, 0], ['2026-03', 0, 0], ['2026-04', 2, 200],
  ]);
  assert.equal(result.busiestMonth.month, '2026-04');
});

test('movie stats: genres are named from the ids, a movie counts once per genre, the top five by count', () => {
  const result = stats([
    movie(1, { genreIds: [28, 12, 28] }),
    movie(2, { genreIds: [28, 35] }),
    movie(3, { genreIds: [35, 99999] }),
    movie(4, { genreIds: [18, 53, 27, 878, 14] }),
  ]);
  assert.deepEqual(result.genres.slice(0, 2), [{ name: 'Action', movies: 2 }, { name: 'Comedy', movies: 2 }]);
  assert.equal(result.genres.length, 5);
  assert.ok(!result.genres.some((genre) => genre.name === undefined), 'an unknown id is skipped');
});

test('movie stats: decades from the release year, oldest first, and a missing date is skipped', () => {
  const result = stats([
    movie(1, { releaseDate: '1994-09-23' }),
    movie(2, { releaseDate: '1999-03-31' }),
    movie(3, { releaseDate: '2021-01-01' }),
    movie(4, { releaseDate: '' }),
  ]);
  assert.deepEqual(result.decades, [{ decade: 1990, movies: 2 }, { decade: 2020, movies: 1 }]);
});

test('movie stats: the totals header and the movie section agree', () => {
  const all = computeStats({
    shows: [], movies: [movie(1, { runtime: 100 }), movie(2, { runtime: 80 })], timezone: 'UTC', now: NOW,
  });
  assert.equal(all.totals.movies, all.movieStats.watched);
  assert.equal(all.totals.minutes.movies, all.movieStats.minutes);
});
