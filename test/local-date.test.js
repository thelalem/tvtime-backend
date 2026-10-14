const test = require('node:test');
const assert = require('node:assert/strict');
const { hasAired, isValidTimeZone, localDateString } = require('../src/local-date');

// 2026-10-13 22:30 UTC: already the 14th in Addis Ababa (UTC+3), still the
// 13th in UTC and New York.
const instant = new Date('2026-10-13T22:30:00Z');

test('local date follows the user timezone', () => {
  assert.equal(localDateString('Africa/Addis_Ababa', instant), '2026-10-14');
  assert.equal(localDateString('UTC', instant), '2026-10-13');
  assert.equal(localDateString('America/New_York', instant), '2026-10-13');
  assert.equal(localDateString('Pacific/Kiritimati', instant), '2026-10-14'); // UTC+14
  assert.equal(localDateString('Pacific/Pago_Pago', instant), '2026-10-13'); // UTC-11
});

test('daylight saving is applied from the zone, not a fixed offset', () => {
  const winter = new Date('2026-01-15T23:30:00Z');
  const summer = new Date('2026-07-15T23:30:00Z');
  assert.equal(localDateString('Europe/London', winter), '2026-01-15'); // GMT
  assert.equal(localDateString('Europe/London', summer), '2026-07-16'); // BST
});

test('a missing or unknown zone falls back to UTC', () => {
  for (const zone of [undefined, null, '', 'Not/AZone', 42]) {
    assert.equal(localDateString(zone, instant), '2026-10-13', String(zone));
  }
});

test('zone validation accepts IANA names and rejects junk', () => {
  assert.equal(isValidTimeZone('Africa/Addis_Ababa'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone('A'.repeat(65)), false);
  assert.equal(isValidTimeZone('../../etc/passwd'), false);
});

test('an episode has aired from local midnight on its air date', () => {
  assert.equal(hasAired('2026-10-14', '2026-10-14'), true);
  assert.equal(hasAired('2026-10-13', '2026-10-14'), true);
  assert.equal(hasAired('2026-10-15', '2026-10-14'), false);
});

test('the same air date lands on different instants for different zones', () => {
  // 00:30 on the 14th in Addis Ababa is 21:30 on the 13th UTC.
  const lateEvening = new Date('2026-10-13T21:30:00Z');
  assert.equal(hasAired('2026-10-14', localDateString('Africa/Addis_Ababa', lateEvening)), true);
  assert.equal(hasAired('2026-10-14', localDateString('UTC', lateEvening)), false);
});

test('missing or malformed air dates have not aired', () => {
  for (const value of [undefined, null, '', 'TBA', '2026-10', 20261014]) {
    assert.equal(hasAired(value, '2026-10-14'), false, String(value));
  }
});
