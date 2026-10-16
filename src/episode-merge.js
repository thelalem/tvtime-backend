// "Latest date wins" for an episode's watched state.
//
// An episode is in one of three states: watched (with the date it was marked),
// unwatched (with the date it was unmarked) or unknown. The date of an unwatch
// is kept in its own table, never in a show's progress row, so remembering it
// cannot make an unwatched show look started or tracked anywhere that reads
// progress. Only the code in this file and the endpoints that call it read it.

const EPISODE_KEY = /^S\d{1,4}E\d{1,5}$/;

function toMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function newest(times) {
  const known = times.filter((t) => t !== null);
  return known.length ? Math.max(...known) : null;
}

// Applies imported records (for example from a Trakt export) to what is already
// stored. Per episode the newest thing known — its watched date, or the date it
// was unwatched — decides:
//   * an incoming record newer than that is applied;
//   * an older or equal one is ignored, so an old export cannot undo a newer
//     unwatch (or a newer watch), whichever order exports are imported in;
//   * with nothing known about the episode — including an episode watched
//     before dates were recorded — the record is applied.
//
// `actions` is [{ key, watched, at }] with `at` a Date or ISO string. Returns
// new collections; the inputs are not modified.
function mergeImportedActions({ watched, dates, unwatched }, actions) {
  const nextWatched = new Set(watched);
  const nextDates = { ...dates };
  const nextUnwatched = { ...unwatched };

  for (const action of actions) {
    const at = toMs(action.at);
    if (at === null) continue;
    const { key } = action;
    const known = newest([
      nextWatched.has(key) ? toMs(nextDates[key]) : null,
      toMs(nextUnwatched[key]),
    ]);
    if (known !== null && at <= known) continue;

    const iso = new Date(at).toISOString();
    if (action.watched) {
      nextWatched.add(key);
      nextDates[key] = iso;
      delete nextUnwatched[key];
    } else {
      nextWatched.delete(key);
      delete nextDates[key];
      nextUnwatched[key] = iso;
    }
  }
  return { watched: nextWatched, dates: nextDates, unwatched: nextUnwatched };
}

// A person marking or unmarking episodes in the app. That is always the newest
// information, so there is no comparison; what is kept is the existing behavior
// that marking an already-watched episode leaves its original date alone, plus
// the new memory of an unmark so an older import cannot bring it back.
// [overwriteDate]: the user named a day, so an episode that is already watched takes that day too
// (otherwise its existing date is left alone).
function markEpisodes({ watched, dates, unwatched }, keys, isWatched, nowIso, { overwriteDate = false } = {}) {
  const nextWatched = new Set(watched);
  const nextDates = { ...dates };
  const nextUnwatched = { ...unwatched };

  for (const key of keys) {
    if (isWatched) {
      if (!nextWatched.has(key) || overwriteDate) {
        nextWatched.add(key);
        nextDates[key] = nowIso;
      }
      delete nextUnwatched[key];
    } else {
      if (nextWatched.has(key)) nextUnwatched[key] = nowIso;
      nextWatched.delete(key);
      delete nextDates[key];
    }
  }
  return { watched: nextWatched, dates: nextDates, unwatched: nextUnwatched };
}

// An import that only fills gaps (the TV Time import, "the app's data wins"): an episode the app already
// has watched keeps its date, and one the person un-ticked in the app stays un-ticked, so only episodes the
// app knows nothing about get through.
function onlyUnknownActions({ watched, unwatched }, actions) {
  const have = new Set(watched);
  return actions.filter((action) => !have.has(action.key) && toMs(unwatched[action.key]) === null);
}

// Rewatches an export says an episode had: `counts` is [{ key, count }]. An episode watched in the merged
// result gets rewatches up to that count (never more than it has already, so running again adds nothing).
// The export has no dates for them, so they are put one second apart after the episode's own date.
// Returns a new rewatches object.
function addCountedRewatches(rewatches, watched, dates, counts) {
  const result = { ...rewatches };
  for (const { key, count } of counts) {
    if (!watched.has(key)) continue;
    const base = toMs(dates[key]);
    if (base === null) continue;
    const list = [...(result[key] || [])];
    for (let i = list.length; i < count; i += 1) {
      list.push({ at: new Date(base + (i + 1) * 1000).toISOString(), source: 'manual' });
    }
    if (list.length) result[key] = list;
  }
  return result;
}

module.exports = {
  EPISODE_KEY, addCountedRewatches, markEpisodes, mergeImportedActions, onlyUnknownActions, toMs,
};
