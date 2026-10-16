const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseDateFor, streamingReleaseTime } = require('../src/upcoming');
const { zonedDateTimeToUtc } = require('../src/local-date');

// Tulsa King as TVMaze returned it (Oct 2026): Paramount+, no air time.
const tulsaKing = { schedule: { time: '', days: ['Friday'] }, network: null, webChannel: { name: 'Paramount+', country: null } };

test('Paramount+ and Prime Video shows get 03:00 New York time', () => {
  assert.deepEqual(streamingReleaseTime(tulsaKing), { airTime: '03:00', timezone: 'America/New_York' });
  assert.ok(streamingReleaseTime({ schedule: { time: '' }, webChannel: { name: 'Prime Video' } }));
});

test('which is 07:00 UTC in summer time and 08:00 in winter', () => {
  const { airTime, timezone } = streamingReleaseTime(tulsaKing);
  assert.equal(zonedDateTimeToUtc('2026-10-16', airTime, timezone).toISOString(), '2026-10-16T07:00:00.000Z');
  assert.equal(zonedDateTimeToUtc('2026-12-04', airTime, timezone).toISOString(), '2026-12-04T08:00:00.000Z');
});

test('Netflix, Hulu and Peacock release at 03:00 New York time too', () => {
  for (const name of ['Netflix', 'Hulu', 'Peacock']) {
    assert.deepEqual(streamingReleaseTime({ ...tulsaKing, webChannel: { name } }),
      { airTime: '03:00', timezone: 'America/New_York' }, name);
  }
});

test('Disney+ releases at 21:00 New York time, 01:00 UTC the next day in summer', () => {
  const { airTime, timezone } = streamingReleaseTime({ ...tulsaKing, webChannel: { name: 'Disney+' } });
  assert.equal(zonedDateTimeToUtc('2026-10-13', airTime, timezone).toISOString(), '2026-10-14T01:00:00.000Z');
  assert.equal(zonedDateTimeToUtc('2026-12-08', airTime, timezone).toISOString(), '2026-12-09T02:00:00.000Z');
});

test("Apple TV releases at 21:00 New York time on TMDB's date, the day before TVMaze's", () => {
  for (const name of ['Apple TV', 'Apple TV+']) {
    assert.deepEqual(streamingReleaseTime({ ...tulsaKing, webChannel: { name } }),
      { airTime: '21:00', timezone: 'America/New_York', tvMazeDayOffset: -1 }, name);
  }
  const apple = streamingReleaseTime({ ...tulsaKing, webChannel: { name: 'Apple TV' } });
  // Dark Matter 2x09: TMDB Thursday 22 October 2026, TVMaze Friday the 23rd.
  assert.equal(releaseDateFor(apple, '2026-10-22', '2026-10-23'), '2026-10-22');
  assert.equal(releaseDateFor(apple, '2026-10-22', undefined), '2026-10-22', 'no TVMaze episode');
  assert.equal(releaseDateFor(apple, null, '2026-10-23'), '2026-10-22', 'no TMDB date');
  // Other services keep the air date.
  assert.equal(releaseDateFor(streamingReleaseTime(tulsaKing), '2026-10-16', '2026-10-16'), '2026-10-16');
  assert.equal(releaseDateFor(null, '2026-10-21', '2026-10-21'), '2026-10-21');
  // Severance 2x01, listed Friday 17 January 2025, out Thursday the 16th at 21:00 EST.
  assert.equal(zonedDateTimeToUtc('2025-01-16', '21:00', 'America/New_York').toISOString(), '2025-01-17T02:00:00.000Z');
});

test('a published time, a TV network or another service is left alone', () => {
  assert.equal(streamingReleaseTime({ ...tulsaKing, schedule: { time: '21:00' } }), null);
  assert.equal(streamingReleaseTime({ ...tulsaKing, network: { name: 'CBS' } }), null);
  assert.equal(streamingReleaseTime({ ...tulsaKing, webChannel: { name: 'Crunchyroll' } }), null);
  assert.equal(streamingReleaseTime(null), null);
});
