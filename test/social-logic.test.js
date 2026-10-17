const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/rate-limit');
const {
  canViewProfile, compare, normalizeUsername, similarity, suggestUsername, usernameProblem,
} = require('../src/social-logic');

test('usernames: lower-cased, an @ is dropped, 3 to 20 of a-z 0-9 _, starting with a letter', () => {
  assert.equal(normalizeUsername('  @Zola_99 '), 'zola_99');
  assert.equal(normalizeUsername('abc'), 'abc');
  for (const bad of ['ab', 'a'.repeat(21), '9lives', '_under', 'has space', 'dash-ed', 'dot.ted', 'émile', '', null, 5, undefined]) {
    assert.equal(normalizeUsername(bad), null, String(bad));
  }
  assert.equal(normalizeUsername('a'.repeat(20)), 'a'.repeat(20));
});

test('usernames: reserved words are refused, in any case', () => {
  assert.equal(usernameProblem('Admin'), 'reserved');
  assert.equal(usernameProblem('@tvtime'), 'reserved');
  assert.equal(usernameProblem('zola'), null);
  assert.equal(usernameProblem('no'), 'invalid');
});

test('suggested usernames come from the name or the start of the e-mail and are always valid', () => {
  assert.equal(suggestUsername('Zelalem Argaw', ''), 'zelalemargaw');
  assert.equal(suggestUsername(null, 'zolzalemarg+test1@gmail.com'), 'zolzalemargtest1');
  assert.equal(suggestUsername('', ''), 'viewer');
  assert.equal(suggestUsername('42', ''), 'user42');
  assert.equal(suggestUsername('é', 'x@y.z'), 'e11', 'accents are stripped and a short name is padded');
  for (const [name, email] of [['Zelalem Argaw', ''], ['', 'a@b.c'], ['!!!', ''], ['A'.repeat(60), ''], ['admin', '']]) {
    assert.ok(normalizeUsername(suggestUsername(name, email)), `${name} ${email}`);
    assert.equal(usernameProblem(suggestUsername(name, email)), null);
  }
});

test('who may view a profile', () => {
  assert.equal(canViewProfile({ isPublic: true }), true);
  assert.equal(canViewProfile({ isPublic: false }), false);
  assert.equal(canViewProfile({ isPublic: false, follows: true }), true);
  assert.equal(canViewProfile({ isPublic: false, isSelf: true }), true);
  assert.equal(canViewProfile({ isPublic: true, blocked: true }), false);
  assert.equal(canViewProfile({ isPublic: false, follows: true, blocked: true }), false);
});

test('similarity: the same shows by the same amount is 100, nothing shared is 0, partly shared is in between', () => {
  const a = new Map([[1, 10], [2, 10]]);
  assert.equal(similarity(a, new Map(a)), 100);
  assert.equal(similarity(a, new Map([[3, 5]])), 0);
  assert.equal(similarity(new Map(), new Map()), 0);
  // show 1: min 5 / max 10; show 2: only one has it (0 / 10); show 3: only the other (0 / 4) => 5 / 24
  assert.equal(similarity(new Map([[1, 10], [2, 10]]), new Map([[1, 5], [3, 4]])), Math.round((5 / 24) * 100));
});

const stats = (over = {}) => ({
  totals: { minutes: { total: 600 }, episodes: 100, movies: 5, rewatches: 2, shows: 10 },
  biggestBinge: { episodes: 8 },
  streak: { longest: { days: 12 } },
  activeDays: 80,
  ...over,
});

test('compare: rows with who is ahead, the shared shows, the shows only they watch, and a score', () => {
  const myShows = [
    { id: 1, name: 'Both A', posterPath: null, episodes: 50 },
    { id: 2, name: 'Both B', posterPath: '/b.jpg', episodes: 4 },
    { id: 3, name: 'Only me', posterPath: null, episodes: 30 },
  ];
  const theirShows = [
    { id: 1, name: 'Both A', posterPath: null, episodes: 20 },
    { id: 2, name: 'Both B', posterPath: '/b.jpg', episodes: 40 },
    { id: 4, name: 'Only they', posterPath: null, episodes: 60 },
    { id: 5, name: 'Small', posterPath: null, episodes: 3 },
    { id: 6, name: 'Zero', posterPath: null, episodes: 0 },
  ];
  const result = compare({
    myStats: stats(),
    theirStats: stats({ totals: { minutes: { total: 900 }, episodes: 100, movies: 1, rewatches: 2, shows: 12 }, activeDays: 80 }),
    myShows,
    theirShows,
  });
  const row = (key) => result.rows.find((r) => r.key === key);
  assert.equal(row('minutes').ahead, 'them');
  assert.equal(row('movies').ahead, 'you');
  assert.equal(row('episodes').ahead, 'tie');
  assert.equal(row('binge').ahead, 'tie');
  assert.deepEqual(result.commonShows.map((s) => [s.name, s.you, s.them]), [['Both B', 4, 40], ['Both A', 50, 20]].sort((a, b) => Math.min(b[1], b[2]) - Math.min(a[1], a[2])));
  assert.equal(result.commonCount, 2);
  assert.deepEqual(result.onlyThem.map((s) => s.name), ['Only they', 'Small'], 'most episodes first; a show they have not watched is left out');
  assert.equal(typeof result.similarity, 'number');
  assert.ok(result.similarity > 0 && result.similarity < 100);
});

test('compare: a person with no history has zeros, not errors', () => {
  const empty = stats({ totals: { minutes: { total: 0 }, episodes: 0, movies: 0, rewatches: 0, shows: 0 }, biggestBinge: null, streak: { longest: null }, activeDays: 0 });
  const result = compare({ myStats: empty, theirStats: empty, myShows: [], theirShows: [] });
  assert.ok(result.rows.every((r) => r.you === 0 && r.them === 0 && r.ahead === 'tie'));
  assert.equal(result.similarity, 0);
  assert.deepEqual(result.commonShows, []);
});

test('rate limiter: allows up to the limit in a window, then refuses until the window passes', () => {
  let clock = 1000;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60000, now: () => clock });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.allow('u1')), [true, true, true, false]);
  assert.equal(limiter.allow('u2'), true, 'another user has their own count');
  clock += 59000;
  assert.equal(limiter.allow('u1'), false);
  clock += 2000;
  assert.equal(limiter.allow('u1'), true);
  limiter.sweep();
  clock += 120000;
  limiter.sweep();
  assert.equal(limiter.size(), 0, 'idle keys are forgotten');
});
