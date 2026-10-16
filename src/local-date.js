// A user's "today", worked out from the IANA timezone their device reports.
//
// Episode air dates are date-only ("2026-10-14"), so "has it aired?" reduces to
// comparing that string with the user's local calendar date. Both are
// YYYY-MM-DD, so a plain string comparison orders them correctly.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch (_error) {
    return false;
  }
}

// `YYYY-MM-DD` for `now` in `timeZone`. A missing or unknown zone (an app
// version that predates the setting, or a name this runtime does not know)
// falls back to UTC, which is what the server used before it knew timezones.
function localDateString(timeZone, now = new Date()) {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

// Whether an episode with this air date has aired by the user's local `today`.
// An absent or malformed date has not, matching how the app treats it.
function hasAired(airDate, today) {
  return typeof airDate === 'string' && DATE_ONLY.test(airDate) && airDate <= today;
}

// Milliseconds [timeZone] is ahead of UTC at the instant [ms].
function zoneOffsetMs(timeZone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const pick = (type) => Number(parts.find((part) => part.type === type).value);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant (a Date) at which the wall clock in [timeZone] reads [date] [time] ("YYYY-MM-DD",
// "HH:MM"). Null for input that is not a date and time or a zone this runtime does not know.
function zonedDateTimeToUtc(date, time, timeZone) {
  if (!DATE_ONLY.test(date || '') || !/^\d{1,2}:\d{2}$/.test(time || '') || !isValidTimeZone(timeZone)) {
    return null;
  }
  const [hour, minute] = time.split(':').map(Number);
  const [year, month, day] = date.split('-').map(Number);
  if (hour > 23 || minute > 59) return null;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The offset depends on the instant it is measured at, so settle it in two steps (this also
  // lands correctly across a daylight-saving change).
  let guess = wallAsUtc - zoneOffsetMs(timeZone, wallAsUtc);
  guess = wallAsUtc - zoneOffsetMs(timeZone, guess);
  return new Date(guess);
}

// Hour of day (0-23) on the wall clock of [timeZone] at [now]; UTC for an unknown zone.
function localHour(timeZone, now = new Date()) {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false })
    .formatToParts(now).find((part) => part.type === 'hour').value;
  return Number(hour) % 24;
}

module.exports = { hasAired, isValidTimeZone, localDateString, localHour, zonedDateTimeToUtc };
