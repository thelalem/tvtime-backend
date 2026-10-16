// The arithmetic of rewatches and passes (rewatch-logic.js): levels, starting a pass, finishing it, and
// taking rewatches back. No database.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addRewatch, cleanRewatches, levelOf, passFor, passStatus, pendingKeys, reconcilePasses,
  removeLastFromSeason, removeLatest, removePassRewatches, rewatchTotal, startPass,
} = require('../src/rewatch-logic');

const watchedSeason = (season, count) => new Set(Array.from({ length: count }, (_, i) => `S${season}E${i + 1}`));
const at = (day) => `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`;

test('a level is 0 when unwatched, otherwise 1 plus the rewatches', () => {
  const watched = new Set(['S1E1', 'S1E2']);
  const rewatches = { S1E1: [{ at: at(1), source: 'manual' }, { at: at(2), source: 'manual' }], S1E3: [{ at: at(1), source: 'manual' }] };
  assert.equal(levelOf('S1E1', watched, rewatches), 3);
  assert.equal(levelOf('S1E2', watched, rewatches), 1);
  assert.equal(levelOf('S1E3', watched, rewatches), 0, 'rewatches of an unwatched episode do not count');
});

test('cleanRewatches drops what is not watched and keeps order', () => {
  const watched = new Set(['S1E1']);
  const cleaned = cleanRewatches({
    S1E1: [{ at: at(5), source: 'pass', pass: 7 }, { at: at(2), source: 'x' }],
    S1E2: [{ at: at(1), source: 'manual' }],
    S1E3: 'junk',
  }, watched);
  assert.deepEqual(Object.keys(cleaned), ['S1E1']);
  assert.deepEqual(cleaned.S1E1.map((entry) => entry.at), [at(2), at(5)]);
  assert.equal(cleaned.S1E1[0].source, 'manual', 'an unknown source becomes manual');
  assert.equal(cleaned.S1E1[1].pass, 7);
});

test('a pass covers the watched episodes of one season and aims one level above the lowest', () => {
  const watched = new Set([...watchedSeason(1, 3), 'S2E1']);
  const pass = startPass(watched, {}, 1, 1000);
  assert.deepEqual(pass, { season: 1, target: 2, startedAt: 1000, episodes: ['S1E1', 'S1E2', 'S1E3'] });
  assert.equal(startPass(watched, {}, 5, 1000), null, 'nothing watched in that season');
});

test('the target is one above the lowest level, and episodes already there count as done', () => {
  const watched = watchedSeason(1, 3);
  const rewatches = { S1E1: [{ at: at(1), source: 'manual' }] }; // E1 is at 2x, E2 and E3 at 1x
  const pass = startPass(watched, rewatches, 1, 1);
  assert.equal(pass.target, 2);
  assert.deepEqual(passStatus(pass, watched, rewatches), { total: 3, done: 1, complete: false });
  assert.deepEqual(pendingKeys(pass, watched, rewatches), ['S1E2', 'S1E3']);

  // A season at 2x across the board starts a 3x pass.
  let all = {};
  for (const key of watched) all = addRewatch(all, key, at(2), { source: 'pass' });
  assert.equal(startPass(watched, all, 1, 2).target, 3);
});

test('a pass finishes when its last episode is done, and not before', () => {
  const watched = watchedSeason(1, 2);
  const pass = startPass(watched, {}, 1, 10);
  let rewatches = addRewatch({}, 'S1E1', at(3), { source: 'pass', pass: pass.startedAt });
  assert.equal(reconcilePasses([pass], watched, rewatches).open.length, 1);
  rewatches = addRewatch(rewatches, 'S1E2', at(4), { source: 'pass', pass: pass.startedAt });
  const result = reconcilePasses([pass], watched, rewatches);
  assert.deepEqual(result, { open: [], finished: [1] });
});

test('un-ticking an episode shrinks the pass; emptying it ends it without a finished season', () => {
  const pass = startPass(watchedSeason(1, 2), {}, 1, 10);
  const afterOne = new Set(['S1E1']);
  assert.deepEqual(passStatus(pass, afterOne, {}), { total: 1, done: 0, complete: false });
  assert.deepEqual(reconcilePasses([pass], new Set(), {}), { open: [], finished: [] });
  // If the remaining episodes are all done the pass is complete.
  const done = addRewatch({}, 'S1E1', at(2), { source: 'pass', pass: 10 });
  assert.deepEqual(reconcilePasses([pass], afterOne, done).finished, [1]);
});

test('passFor finds the pass a rewatch belongs to, only while the episode still needs it', () => {
  const watched = watchedSeason(1, 2);
  const pass = startPass(watched, {}, 1, 10);
  assert.equal(passFor([pass], 'S1E1', watched, {}), pass);
  const done = addRewatch({}, 'S1E1', at(2), { source: 'pass', pass: 10 });
  assert.equal(passFor([pass], 'S1E1', watched, done), null, 'already at the target: a further watch is manual');
  assert.equal(passFor([pass], 'S2E1', watched, {}), null, 'another season');
});

test('removeLatest takes off the newest rewatch and forgets an empty list', () => {
  let rewatches = addRewatch({}, 'S1E1', at(2), { source: 'manual' });
  rewatches = addRewatch(rewatches, 'S1E1', at(9), { source: 'manual' });
  rewatches = addRewatch(rewatches, 'S1E1', at(5), { source: 'manual' }); // inserted out of order
  assert.deepEqual(rewatches.S1E1.map((entry) => entry.at), [at(2), at(5), at(9)]);
  rewatches = removeLatest(rewatches, 'S1E1');
  assert.deepEqual(rewatches.S1E1.map((entry) => entry.at), [at(2), at(5)]);
  rewatches = removeLatest(removeLatest(rewatches, 'S1E1'), 'S1E1');
  assert.equal('S1E1' in rewatches, false);
  assert.equal(removeLatest(rewatches, 'S1E1'), null, 'nothing left to remove');
});

test('cancelling a pass takes back exactly what it added', () => {
  const pass = { season: 1, target: 2, startedAt: 500, episodes: ['S1E1', 'S1E2'] };
  let rewatches = addRewatch({}, 'S1E1', at(1), { source: 'manual' }); // an earlier, separate rewatch
  rewatches = addRewatch(rewatches, 'S1E1', at(3), { source: 'pass', pass: 500 });
  rewatches = addRewatch(rewatches, 'S1E2', at(3), { source: 'pass', pass: 500 });
  const { rewatches: after, removed } = removePassRewatches(rewatches, pass);
  assert.equal(removed, 2);
  assert.deepEqual(after.S1E1.map((entry) => entry.source), ['manual']);
  assert.equal('S1E2' in after, false);
});

test('removing the last rewatch of a season takes one watch off each episode that has one', () => {
  let rewatches = {};
  for (const key of ['S1E1', 'S1E2']) rewatches = addRewatch(rewatches, key, at(1), { source: 'pass' });
  rewatches = addRewatch(rewatches, 'S1E1', at(2), { source: 'pass' }); // E1 is at 3x
  rewatches = addRewatch(rewatches, 'S2E1', at(1), { source: 'pass' });
  const { rewatches: after, removed } = removeLastFromSeason(rewatches, 1);
  assert.equal(removed, 2);
  assert.equal(after.S1E1.length, 1);
  assert.equal('S1E2' in after, false);
  assert.equal(after.S2E1.length, 1, 'another season is untouched');
});

test('the total counts every rewatch', () => {
  let rewatches = addRewatch({}, 'S1E1', at(1), { source: 'manual' });
  rewatches = addRewatch(rewatches, 'S1E1', at(2), { source: 'manual' });
  rewatches = addRewatch(rewatches, 'S3E4', at(2), { source: 'manual' });
  assert.equal(rewatchTotal(rewatches), 3);
  assert.equal(rewatchTotal(undefined), 0);
});
