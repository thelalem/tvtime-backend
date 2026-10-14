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

module.exports = { hasAired, isValidTimeZone, localDateString };
