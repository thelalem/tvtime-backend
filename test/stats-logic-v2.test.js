const test = require('node:test');
const assert = require('node:assert/strict');
const { addDays, computeStats, weekStart } = require('../src/stats-logic');

// Saturday 17 October 2026: the current week runs Monday 12 to Sunday 18 October.
const NOW = new Date('2026-10-17T12:00:00Z');
const show = (id, name, dates, extra = {}) => ({
  showId: id, name, posterPath: null, runtime: 40, watched: Object.keys(dates), dates, rewatches: {}, ...extra,
});
const stats = (shows, extra = {}) => computeStats({ shows, movies: [], timezone: 'UTC', now: NOW, ...extra });
const at = (day, hour = 20) => `${day}T${String(hour).padStart(2, '0')}:00:00Z`;

test('weekStart is the Monday of the week, and addDays moves a calendar date', () => {
  assert.equal(weekStart('2026-10-17'), '2026-10-12');
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(weekStart('2026-10-18'), '2026-10-12');
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('weeks: the last 12, Monday to Sunday, current week last; bulk checks, specials and older weeks are left out', () => {
  const dates = {
    S1E1: at('2026-10-13', 10), S1E2: at('2026-10-14', 10), // this week
    S1E3: at('2026-10-05', 10), // last week
    S0E1: at('2026-10-13', 12), // a special
    S1E4: at('2025-01-01', 10), // far too old for the chart
  };
  const bulkKeys = ['S2E1', 'S2E2', 'S2E3', 'S2E4', 'S2E5'];
  for (const key of bulkKeys) dates[key] = at('2026-10-15', 9); // five in one minute: a bulk check
  const result = stats([show(1, 'A', dates)]);
  assert.equal(result.weeks.length, 12);
  assert.equal(result.weeks[11].start, '2026-10-12');
  assert.equal(result.weeks[0].start, addDays('2026-10-12', -77));
  assert.equal(result.weeks[11].episodes, 2);
  assert.equal(result.weeks[11].minutes, 80);
  assert.equal(result.weeks[10].episodes, 1);
  assert.equal(result.weeks.reduce((sum, week) => sum + week.episodes, 0), 3);
});

test('the last 7 days are today and the six days before it', () => {
  const dates = { S1E1: at('2026-10-11'), S1E2: at('2026-10-10'), S1E3: at('2026-10-17', 8) };
  const result = stats([show(1, 'A', dates)]);
  assert.deepEqual(result.last7Days, { episodes: 2, minutes: 80 });
});

test('rewatches count in the weeks and the last 7 days but not in the pace', () => {
  const a = show(1, 'A', { S1E1: at('2026-05-01') }, { rewatches: { S1E1: [{ at: at('2026-10-14') }, { at: at('2026-10-15') }] } });
  const result = stats([a, show(2, 'B', { S1E1: at('2026-10-14', 9) }, { unwatchedReleased: 5 })]);
  assert.equal(result.weeks[11].episodes, 3);
  assert.equal(result.last7Days.episodes, 3);
  assert.equal(result.backlog.episodesPerWeek, 0.13, 'one first watch in eight weeks');
});

test('marathons: each show best day, the biggest first, at most five', () => {
  const day = (date, count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`S1E${i + 1}`, at(date, 8 + i)]));
  const shows = [
    show(1, 'Small', day('2026-02-01', 2)),
    show(2, 'Big', { ...day('2026-03-01', 6), ...Object.fromEntries([['S2E1', at('2026-03-09', 9)]]) }),
    show(3, 'Medium', day('2026-04-01', 4)),
    ...[4, 5, 6, 7].map((id) => show(id, `Filler ${id}`, day('2026-05-01', 3))),
  ];
  const result = stats(shows);
  assert.equal(result.marathons.length, 5);
  assert.deepEqual(result.marathons.slice(0, 3).map((m) => [m.name, m.episodes, m.minutes, m.date]), [
    ['Big', 6, 240, '2026-03-01'],
    ['Medium', 4, 160, '2026-04-01'],
    ['Filler 4', 3, 120, '2026-05-01'],
  ]);
  assert.equal(result.biggestBinge.episodes, 6);
});

test('backlog: aired episodes left on started, active shows; the pace and the catch-up date', () => {
  const recent = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`S1E${i + 1}`, at(addDays('2026-10-16', -i * 3), 20)]));
  const shows = [
    show(1, 'A', recent(10), { unwatchedReleased: 6 }),
    show(2, 'B', recent(6), { unwatchedReleased: 4, runtime: 20 }),
    show(3, 'Stopped', recent(1), { unwatchedReleased: 99, active: false }),
    show(4, 'Unstarted', {}, { unwatchedReleased: 12 }),
    show(5, 'NotClassifiedYet', recent(1), { unwatchedReleased: null }),
    show(6, 'Caught up', recent(1), { unwatchedReleased: 0 }),
  ];
  const result = stats(shows);
  assert.equal(result.backlog.remainingEpisodes, 10);
  assert.equal(result.backlog.shows, 2);
  assert.equal(result.backlog.minutes, 6 * 40 + 4 * 20);
  assert.equal(result.backlog.unknownShows, 1);
  // 10 + 6 + 1 + 1 + 1 first watches within 8 weeks (the days run back three at a time, all well inside 56 days):
  // 19 episodes, 2.375 a week. A stopped show's watching still counts toward the pace.
  assert.equal(result.backlog.episodesPerWeek, 2.38);
  assert.equal(result.backlog.catchUpDate, addDays('2026-10-17', Math.ceil((10 / (19 / 8)) * 7)));
});

test('backlog: nothing left, or no recent watching, gives no catch-up date', () => {
  const none = stats([show(1, 'A', { S1E1: at('2026-10-16') }, { unwatchedReleased: 0 })]);
  assert.equal(none.backlog.remainingEpisodes, 0);
  assert.equal(none.backlog.catchUpDate, null);
  const idle = stats([show(1, 'A', { S1E1: at('2025-01-01') }, { unwatchedReleased: 8 })]);
  assert.equal(idle.backlog.remainingEpisodes, 8);
  assert.equal(idle.backlog.episodesPerWeek, 0);
  assert.equal(idle.backlog.catchUpDate, null);
});

test('genres and networks count shows with something watched; library and ratings pass through', () => {
  const shows = [
    show(1, 'A', { S1E1: at('2026-10-01') }, { genres: ['Drama', 'Mystery'], networks: ['Netflix'] }),
    show(2, 'B', { S1E1: at('2026-10-02') }, { genres: ['Drama'], networks: ['Netflix', 'CBS'] }),
    show(3, 'Never watched', {}, { genres: ['Comedy'], networks: ['HBO'] }),
  ];
  const result = stats(shows, { library: { added: 9, inProduction: 4 }, ratings: { count: 3, shows: 2 } });
  assert.deepEqual(result.topGenres, [{ name: 'Drama', shows: 2 }, { name: 'Mystery', shows: 1 }]);
  assert.deepEqual(result.topNetworks, [{ name: 'Netflix', shows: 2 }, { name: 'CBS', shows: 1 }]);
  assert.deepEqual(result.library, { added: 9, inProduction: 4 });
  assert.deepEqual(result.ratings, { count: 3, shows: 2 });
  assert.equal(stats([]).library, null);
});
