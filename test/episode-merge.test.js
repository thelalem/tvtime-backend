const test = require('node:test');
const assert = require('node:assert/strict');
const { markEpisodes, mergeImportedActions } = require('../src/episode-merge');

const empty = () => ({ watched: new Set(), dates: {}, unwatched: {} });
const act = (key, watched, at) => ({ key, watched, at });
const state = (s) => ({ watched: [...s.watched].sort(), dates: s.dates, unwatched: s.unwatched });

test('applies a record when nothing is known about the episode', () => {
  const next = mergeImportedActions(empty(), [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  assert.deepEqual(state(next), {
    watched: ['S1E1'],
    dates: { S1E1: '2026-06-30T16:18:00.000Z' },
    unwatched: {},
  });
});

test('an unwatch is remembered with its date', () => {
  const next = mergeImportedActions(empty(), [act('S1E1', false, '2026-08-01T00:00:00Z')]);
  assert.deepEqual(state(next), { watched: [], dates: {}, unwatched: { S1E1: '2026-08-01T00:00:00.000Z' } });
});

test('THE BUG: an older watch cannot resurrect an episode unwatched later', () => {
  // October export: watched in June, unwatched in August.
  let s = mergeImportedActions(empty(), [
    act('S1E1', true, '2026-06-30T16:18:00Z'),
    act('S1E1', false, '2026-08-01T00:00:00Z'),
  ]);
  assert.deepEqual(state(s).watched, []);
  // Then the older July export, which only knows the June watch.
  s = mergeImportedActions(s, [act('S1E1', true, '2026-06-30T16:18:00Z')]);
  assert.deepEqual(state(s).watched, [], 'stays unwatched');
  assert.equal(s.unwatched.S1E1, '2026-08-01T00:00:00.000Z');
});

test('the result does not depend on the order the exports are imported in', () => {
  const july = [act('S1E1', true, '2026-06-30T16:18:00Z'), act('S1E2', true, '2026-06-30T16:18:00Z')];
  const october = [
    act('S1E1', true, '2026-06-30T16:18:00Z'),
    act('S1E1', false, '2026-08-01T00:00:00Z'),
    act('S1E2', true, '2026-06-30T16:18:00Z'),
    act('S1E3', true, '2026-09-01T00:00:00Z'),
  ];
  const julyThenOctober = mergeImportedActions(mergeImportedActions(empty(), july), october);
  const octoberThenJuly = mergeImportedActions(mergeImportedActions(empty(), october), july);
  assert.deepEqual(state(julyThenOctober), state(octoberThenJuly));
  assert.deepEqual(state(octoberThenJuly).watched, ['S1E2', 'S1E3']);
});

test('a newer watch beats an older unwatch', () => {
  let s = mergeImportedActions(empty(), [act('S1E1', false, '2026-08-01T00:00:00Z')]);
  s = mergeImportedActions(s, [act('S1E1', true, '2026-09-01T00:00:00Z')]);
  assert.deepEqual(state(s), { watched: ['S1E1'], dates: { S1E1: '2026-09-01T00:00:00.000Z' }, unwatched: {} });
});

test('an older record is ignored and so is an equal one (ties keep what is stored)', () => {
  const start = { watched: new Set(['S1E1']), dates: { S1E1: '2026-09-01T00:00:00.000Z' }, unwatched: {} };
  const older = mergeImportedActions(start, [act('S1E1', false, '2026-08-01T00:00:00Z')]);
  assert.deepEqual(state(older), state(start));
  const tie = mergeImportedActions(start, [act('S1E1', false, '2026-09-01T00:00:00Z')]);
  assert.deepEqual(state(tie), state(start));
});

test('an episode watched before dates were recorded takes any incoming record', () => {
  const legacy = { watched: new Set(['S1E1']), dates: {}, unwatched: {} };
  const watchedAgain = mergeImportedActions(legacy, [act('S1E1', true, '2020-01-01T00:00:00Z')]);
  assert.equal(watchedAgain.dates.S1E1, '2020-01-01T00:00:00.000Z');
  const unwatched = mergeImportedActions(legacy, [act('S1E1', false, '2020-01-01T00:00:00Z')]);
  assert.deepEqual(state(unwatched).watched, []);
});

test('records for one episode inside a single import resolve by date, in any order', () => {
  const later = act('S1E1', false, '2026-08-01T00:00:00Z');
  const earlier = act('S1E1', true, '2026-06-01T00:00:00Z');
  assert.deepEqual(state(mergeImportedActions(empty(), [later, earlier])).watched, []);
  assert.deepEqual(state(mergeImportedActions(empty(), [earlier, later])).watched, []);
});

test('bad dates are skipped and inputs are not modified', () => {
  const start = { watched: new Set(['S1E1']), dates: { S1E1: '2026-01-01T00:00:00.000Z' }, unwatched: {} };
  const snapshot = JSON.stringify([...start.watched]) + JSON.stringify(start.dates);
  const next = mergeImportedActions(start, [act('S1E1', false, 'not a date'), act('S1E2', true, '2026-02-01T00:00:00Z')]);
  assert.deepEqual(state(next).watched, ['S1E1', 'S1E2']);
  assert.equal(JSON.stringify([...start.watched]) + JSON.stringify(start.dates), snapshot);
});

test('unmarking in the app is remembered, so an older import cannot undo it', () => {
  let s = markEpisodes(empty(), ['S1E1'], true, '2026-06-01T00:00:00.000Z');
  s = markEpisodes(s, ['S1E1'], false, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(state(s), { watched: [], dates: {}, unwatched: { S1E1: '2026-10-14T00:00:00.000Z' } });
  s = mergeImportedActions(s, [act('S1E1', true, '2026-09-01T00:00:00Z')]);
  assert.deepEqual(state(s).watched, []);
});

test('marking in the app keeps an existing date and clears a remembered unwatch', () => {
  const start = { watched: new Set(['S1E1']), dates: { S1E1: '2026-06-01T00:00:00.000Z' }, unwatched: { S1E2: '2026-07-01T00:00:00.000Z' } };
  const next = markEpisodes(start, ['S1E1', 'S1E2'], true, '2026-10-14T00:00:00.000Z');
  assert.equal(next.dates.S1E1, '2026-06-01T00:00:00.000Z', 'already watched: date untouched');
  assert.equal(next.dates.S1E2, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(next.unwatched, {});
});

test('unmarking something that was never watched records nothing', () => {
  const next = markEpisodes(empty(), ['S1E1'], false, '2026-10-14T00:00:00.000Z');
  assert.deepEqual(state(next), { watched: [], dates: {}, unwatched: {} });
});
