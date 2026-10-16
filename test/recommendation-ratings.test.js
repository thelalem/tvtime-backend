// How the user's own episode ratings scale a show's weight as a recommendation seed
// (recommendations.js). Pure: the database and TMDB are stubbed out, since only the weighing is tested.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('recommendations.js')) {
    if (request === './db') return { pool: { query: async () => ({ rows: [] }) } };
    if (request === './tmdb') return {};
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const { ratingFactor, seedWeights } = require('../src/recommendations');

const row = (id) => ({ series_id: id });
// One show the user has engaged with: on the watchlist and fully watched, a while ago.
const history = (extra = {}) => ({
  watchlist: [row(1), row(2), row(3)],
  favorites: [],
  progress: [1, 2, 3].map((id) => ({ series_id: id, watched_count: 10, total_episodes: 10, last_watched: null })),
  ...extra,
});

test('the factor: loved shows count double, liked ones more, middling ones the same', () => {
  assert.equal(ratingFactor({ average: 5, count: 1 }, false), 2);
  assert.equal(ratingFactor({ average: 4.5, count: 3 }, false), 2);
  assert.equal(ratingFactor({ average: 4, count: 2 }, false), 1.5);
  assert.equal(ratingFactor({ average: 3, count: 4 }, false), 1);
  assert.equal(ratingFactor(undefined, false), 1, 'no ratings, no change');
});

test('the factor: a show rated 2 or less stops being a seed, but one bad episode is not enough', () => {
  assert.equal(ratingFactor({ average: 1.5, count: 2 }, false), 0);
  assert.equal(ratingFactor({ average: 2, count: 5 }, false), 0);
  assert.equal(ratingFactor({ average: 1, count: 1 }, false), 1, 'a single rating cannot drop a show');
});

test('a favorite is only halved, never dropped', () => {
  assert.equal(ratingFactor({ average: 1, count: 4 }, true), 0.5);
});

test('ratings scale the seed weights, and a dropped show stays in the map', () => {
  const plain = seedWeights(history());
  const weights = seedWeights(history({
    ratings: new Map([
      [1, { average: 5, count: 3 }],
      [2, { average: 1.5, count: 3 }],
    ]),
  }));
  assert.equal(weights.get(1), plain.get(1) * 2);
  assert.equal(weights.get(2), 0, 'kept at zero, so it is still never suggested back');
  assert.equal(weights.get(3), plain.get(3), 'unrated: unchanged');
});

test('a favorite with bad ratings keeps half its weight', () => {
  const base = history({ favorites: [row(1)] });
  const plain = seedWeights(base);
  const weights = seedWeights({ ...base, ratings: new Map([[1, { average: 1, count: 5 }]]) });
  assert.equal(weights.get(1), plain.get(1) * 0.5);
});
