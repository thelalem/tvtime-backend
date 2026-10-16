const test = require('node:test');
const assert = require('node:assert/strict');
const { streamingReleaseTime } = require('../src/upcoming');
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

test('a published time, a TV network or another service is left alone', () => {
  assert.equal(streamingReleaseTime({ ...tulsaKing, schedule: { time: '21:00' } }), null);
  assert.equal(streamingReleaseTime({ ...tulsaKing, network: { name: 'CBS' } }), null);
  assert.equal(streamingReleaseTime({ ...tulsaKing, webChannel: { name: 'Netflix' } }), null);
  assert.equal(streamingReleaseTime(null), null);
});
