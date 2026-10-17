const test = require('node:test');
const assert = require('node:assert/strict');
const { BULK_LIMIT, computeStats, dayOf } = require('../src/stats-logic');

const NOW = new Date('2026-10-17T12:00:00Z');
const show = (id, name, watched, dates, extra = {}) => ({
  showId: id, name, posterPath: null, runtime: 40, watched, dates, rewatches: {}, ...extra,
});
const stats = (shows, movies = [], timezone = 'UTC') => computeStats({ shows, movies, timezone, now: NOW });

test('totals: regular episodes, specials apart, rewatches count as time, runtime per show', () => {
  const a = show(1, 'A', ['S1E1', 'S1E2', 'S0E1'], {
    S1E1: '2026-01-01T20:00:00Z', S1E2: '2026-01-02T20:00:00Z', S0E1: '2026-01-03T20:00:00Z',
  }, { rewatches: { S1E1: [{ at: '2026-02-01T20:00:00Z' }], S0E1: [{ at: '2026-02-02T20:00:00Z' }] } });
  const b = show(2, 'B', ['S1E1'], { S1E1: '2026-01-05T20:00:00Z' }, { runtime: 22 });
  const result = stats([a, b], [
    { movieId: 9, title: 'M', watchedOn: '2026-03-01', runtime: 100 },
    { movieId: 8, title: 'N', watchedOn: '2026-03-02', runtime: null },
  ]);
  assert.equal(result.totals.episodes, 3);
  assert.equal(result.totals.specials, 1);
  assert.equal(result.totals.rewatches, 1, 'a special rewatch is not counted');
  assert.equal(result.totals.movies, 2);
  assert.equal(result.totals.minutes.episodes, 2 * 40 + 22);
  assert.equal(result.totals.minutes.rewatches, 40);
  assert.equal(result.totals.minutes.movies, 100, 'a movie without a runtime adds no minutes');
  assert.equal(result.totals.minutes.total, 102 + 40 + 100);
  assert.equal(result.totals.shows, 2);
});

test('a missing runtime falls back to 42 minutes', () => {
  const result = stats([show(1, 'A', ['S1E1'], { S1E1: '2026-01-01T20:00:00Z' }, { runtime: null })]);
  assert.equal(result.totals.minutes.episodes, 42);
});

test('biggest binge: the most episodes of one show in one day, on the user own clock', () => {
  const keys = ['S1E1', 'S1E2', 'S1E3', 'S1E4', 'S1E5'];
  const dates = {};
  keys.forEach((key, i) => { dates[key] = `2026-05-10T${String(10 + i).padStart(2, '0')}:00:00Z`; }); // spread hours: not bulk
  const other = show(2, 'B', ['S1E1', 'S1E2'], { S1E1: '2026-05-11T10:00:00Z', S1E2: '2026-05-11T12:00:00Z' });
  const result = stats([show(1, 'A', keys, dates), other]);
  assert.deepEqual(result.biggestBinge, { episodes: 5, showId: 1, showName: 'A', date: '2026-05-10' });

  // 23:30 and 00:30 UTC are one evening in Los Angeles but two days in UTC.
  const late = show(3, 'C', ['S1E1', 'S1E2'], { S1E1: '2026-05-10T23:30:00Z', S1E2: '2026-05-11T00:30:00Z' });
  assert.equal(stats([late], [], 'UTC').biggestBinge.episodes, 1);
  assert.equal(stats([late], [], 'America/Los_Angeles').biggestBinge.episodes, 2);
});

test('a bulk check is in the totals and months but never in the binge, the streak or the active days', () => {
  const keys = Array.from({ length: 12 }, (_, i) => `S1E${i + 1}`);
  const stamp = '2026-04-04T09:15:00Z';
  const bulk = show(1, 'Bulk', keys, Object.fromEntries(keys.map((key) => [key, stamp])));
  const result = stats([bulk]);
  assert.equal(result.totals.episodes, 12);
  assert.equal(result.months.find((m) => m.month === '2026-04').episodes, 12);
  assert.equal(result.biggestBinge, null);
  assert.equal(result.streak.longest, null);
  assert.equal(result.activeDays, 0);
  assert.equal(result.bulkEpisodes, 12);
  // exactly BULK_LIMIT episodes in one minute is still a normal watch
  const few = show(2, 'Few', keys.slice(0, BULK_LIMIT), Object.fromEntries(keys.slice(0, BULK_LIMIT).map((key) => [key, stamp])));
  assert.equal(stats([few]).biggestBinge.episodes, BULK_LIMIT);
});

test('streaks: the longest run of days, and the current one only if it reaches today or yesterday', () => {
  const day = (d) => `2026-10-${String(d).padStart(2, '0')}T20:00:00Z`;
  const dates = { S1E1: day(1), S1E2: day(2), S1E3: day(3), S1E4: day(5), S1E5: day(15), S1E6: day(16) };
  const result = stats([show(1, 'A', Object.keys(dates), dates)]);
  assert.deepEqual(result.streak.longest, { days: 3, from: '2026-10-01', to: '2026-10-03' });
  assert.equal(result.streak.current, 2, 'the 15th and 16th; today (the 17th) has not happened yet');
  assert.equal(stats([show(1, 'A', ['S1E1'], { S1E1: day(10) })]).streak.current, 0);
  const alsoToday = { ...dates, S1E7: day(17) };
  assert.equal(stats([show(1, 'A', Object.keys(alsoToday), alsoToday)]).streak.current, 3);
});

test('movies count toward streaks, months and first and latest watch', () => {
  const result = stats(
    [show(1, 'A', ['S1E1'], { S1E1: '2026-06-10T20:00:00Z' })],
    [
      { movieId: 1, title: 'Old Movie', watchedOn: '2026-06-09', runtime: 100 },
      { movieId: 2, title: 'New Movie', watchedOn: '2026-06-12', runtime: 90 },
    ],
  );
  assert.deepEqual(result.streak.longest, { days: 2, from: '2026-06-09', to: '2026-06-10' });
  assert.equal(result.firstWatch.title, 'Old Movie');
  assert.equal(result.firstWatch.kind, 'movie');
  assert.equal(result.latestWatch.title, 'New Movie');
  assert.equal(result.months[0].movies, 2);
});

test('months run without gaps from the first to the last; the busiest has the most minutes', () => {
  const result = stats([show(1, 'A', ['S1E1', 'S1E2', 'S1E3'], {
    S1E1: '2025-11-20T20:00:00Z', S1E2: '2026-02-03T20:00:00Z', S1E3: '2026-02-04T20:00:00Z',
  })]);
  assert.deepEqual(result.months.map((m) => m.month), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(result.months[1].episodes, 0);
  assert.equal(result.busiestMonth.month, '2026-02');
  assert.equal(result.busiestMonth.episodes, 2);
});

test('top shows by time, most rewatched, and an empty history gives empty answers', () => {
  const long = show(1, 'Long', ['S1E1', 'S1E2', 'S1E3'], {
    S1E1: '2026-01-01T10:00:00Z', S1E2: '2026-01-02T10:00:00Z', S1E3: '2026-01-03T10:00:00Z',
  });
  const loved = show(2, 'Loved', ['S1E1'], { S1E1: '2026-01-04T10:00:00Z' }, {
    rewatches: { S1E1: [{ at: '2026-02-01T10:00:00Z' }, { at: '2026-03-01T10:00:00Z' }] },
  });
  const result = stats([long, loved]);
  assert.deepEqual(result.topShows.map((s) => s.name), ['Long', 'Loved']);
  assert.deepEqual(result.mostRewatched.map((s) => [s.name, s.rewatches]), [['Loved', 2]]);
  const empty = stats([]);
  assert.equal(empty.totals.episodes, 0);
  assert.equal(empty.biggestBinge, null);
  assert.equal(empty.streak.longest, null);
  assert.deepEqual(empty.months, []);
  assert.equal(empty.busiestMonth, null);
});

test('an unknown timezone falls back to UTC, and bad dates are ignored', () => {
  const result = stats([show(1, 'A', ['S1E1', 'S1E2'], { S1E1: '2026-01-01T10:00:00Z', S1E2: 'not a date' })], [], 'Not/AZone');
  assert.equal(result.activeDays, 1);
  assert.equal(result.totals.episodes, 2, 'still counted as watched');
});

test('a day on the user clock is right on both sides of local midnight, in zones a quarter or half hour off', () => {
  // Days are remembered per quarter hour (stats-logic.js dayOf); local midnight falls on a quarter hour everywhere.
  const cases = [
    ['Asia/Kathmandu', '2026-03-10T18:14:59.999Z', '2026-03-10'], // +05:45
    ['Asia/Kathmandu', '2026-03-10T18:15:00.000Z', '2026-03-11'],
    ['America/St_Johns', '2026-01-10T03:29:59.999Z', '2026-01-09'], // -03:30
    ['America/St_Johns', '2026-01-10T03:30:00.000Z', '2026-01-10'],
    ['Africa/Addis_Ababa', '2026-10-16T20:59:59.999Z', '2026-10-16'],
    ['Africa/Addis_Ababa', '2026-10-16T21:00:00.000Z', '2026-10-17'],
    // Lord Howe moves its clock by half an hour for summer time.
    ['Australia/Lord_Howe', '2026-01-10T13:00:00.000Z', '2026-01-11'], // +11:00 in summer
    ['Australia/Lord_Howe', '2026-07-10T13:29:59.999Z', '2026-07-10'], // +10:30 in winter
    ['Australia/Lord_Howe', '2026-07-10T13:30:00.000Z', '2026-07-11'],
  ];
  for (const [zone, at, day] of cases) {
    // Twice: the second answer comes from what was remembered.
    assert.equal(dayOf(Date.parse(at), zone), day, `${zone} ${at}`);
    assert.equal(dayOf(Date.parse(at), zone), day, `${zone} ${at} (remembered)`);
  }
});
