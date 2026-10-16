// The rules of rewatches and rewatch passes (FEATURE_PLAN.md section 14), with no database in them.
//
// An episode's *level* is how many times it has been watched: 0 when it is not watched, otherwise
// 1 + the number of rewatches recorded for it. Rewatches are kept per episode key ('S1E2') as a list of
// `{ at, source, pass? }`, oldest first: `source` is 'pass' (ticked inside a rewatch pass) or 'manual'
// (watched again on its own), and `pass` names the pass it belonged to by that pass's start time in ms,
// which is what lets "remove this rewatch" take back exactly what one pass added.
//
// A *pass* is a rewatch of one season: `{ season, target, startedAt (ms), episodes }`. `episodes` is the
// season's watched episodes when it started, `target` the level they are being taken to (one above the
// lowest level among them). An episode is done once its level reaches the target, and the pass ends by
// itself when every one of its still-watched episodes is done.

const EPISODE_KEY = /^S(\d{1,4})E(\d{1,5})$/;

function seasonOf(key) {
  const match = EPISODE_KEY.exec(key);
  return match ? Number(match[1]) : null;
}

function episodeNumberOf(key) {
  const match = EPISODE_KEY.exec(key);
  return match ? Number(match[2]) : null;
}

function levelOf(key, watched, rewatches) {
  if (!watched.has(key)) return 0;
  const list = rewatches[key];
  return 1 + (Array.isArray(list) ? list.length : 0);
}

// Rewatches only make sense for watched episodes, so anything else is dropped (an episode that was
// un-ticked forgets its rewatches, and ticking it again starts from one). Also drops bad entries.
function cleanRewatches(rewatches, watched) {
  const result = {};
  for (const [key, list] of Object.entries(rewatches || {})) {
    if (!watched.has(key) || !Array.isArray(list)) continue;
    const entries = list
      .filter((entry) => entry && Number.isFinite(Date.parse(entry.at)))
      .map((entry) => ({
        at: new Date(entry.at).toISOString(),
        source: entry.source === 'pass' ? 'pass' : 'manual',
        ...(Number.isFinite(entry.pass) ? { pass: entry.pass } : {}),
      }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (entries.length) result[key] = entries;
  }
  return result;
}

function rewatchTotal(rewatches) {
  return Object.values(rewatches || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

// The pass a rewatch of [key] would belong to: one open for its season that still wants this episode.
function passFor(passes, key, watched, rewatches) {
  const season = seasonOf(key);
  return passes.find(
    (pass) => pass.season === season && pass.episodes.includes(key) && levelOf(key, watched, rewatches) < pass.target,
  ) || null;
}

// Begins a pass over [season]'s watched episodes, or null when there are none.
function startPass(watched, rewatches, season, nowMs) {
  const episodes = [...watched]
    .filter((key) => seasonOf(key) === season)
    .sort((a, b) => episodeNumberOf(a) - episodeNumberOf(b));
  if (!episodes.length) return null;
  const lowest = Math.min(...episodes.map((key) => levelOf(key, watched, rewatches)));
  return { season, target: lowest + 1, startedAt: nowMs, episodes };
}

// How far a pass has got, counting only episodes that are still watched.
function passStatus(pass, watched, rewatches) {
  const keys = pass.episodes.filter((key) => watched.has(key));
  const done = keys.filter((key) => levelOf(key, watched, rewatches) >= pass.target).length;
  return { total: keys.length, done, complete: keys.length === 0 || done === keys.length };
}

// Adds a rewatch of [key] at [atIso] (oldest first order is kept). Returns a new object.
function addRewatch(rewatches, key, atIso, extra) {
  const entry = { at: new Date(atIso).toISOString(), source: extra.source };
  if (Number.isFinite(extra.pass)) entry.pass = extra.pass;
  const list = [...(rewatches[key] || []), entry].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ...rewatches, [key]: list };
}

// Takes off the latest rewatch of [key]; null when there is none.
function removeLatest(rewatches, key) {
  const list = rewatches[key];
  if (!Array.isArray(list) || !list.length) return null;
  const rest = list.slice(0, -1);
  const result = { ...rewatches };
  if (rest.length) result[key] = rest;
  else delete result[key];
  return result;
}

// Takes back every rewatch the given pass added ("remove this rewatch").
function removePassRewatches(rewatches, pass) {
  const result = {};
  let removed = 0;
  for (const [key, list] of Object.entries(rewatches)) {
    const kept = list.filter((entry) => entry.pass !== pass.startedAt);
    removed += list.length - kept.length;
    if (kept.length) result[key] = kept;
  }
  return { rewatches: result, removed };
}

// One watch off every episode of [season] that has been rewatched ("remove last rewatch").
function removeLastFromSeason(rewatches, season) {
  let result = rewatches;
  let removed = 0;
  for (const key of Object.keys(rewatches)) {
    if (seasonOf(key) !== season) continue;
    const next = removeLatest(result, key);
    if (next) {
      result = next;
      removed += 1;
    }
  }
  return { rewatches: result, removed };
}

// The episodes of [pass] still to do, in order.
function pendingKeys(pass, watched, rewatches) {
  return pass.episodes.filter((key) => watched.has(key) && levelOf(key, watched, rewatches) < pass.target);
}

// Drops passes that are over: nothing watched left in them, or every episode done. Returns the passes
// that stay and the seasons that finished (a pass emptied by un-ticking is not a finished season).
function reconcilePasses(passes, watched, rewatches) {
  const open = [];
  const finished = [];
  for (const pass of passes) {
    const status = passStatus(pass, watched, rewatches);
    if (status.total === 0) continue;
    if (status.complete) finished.push(pass.season);
    else open.push(pass);
  }
  return { open, finished };
}

module.exports = {
  EPISODE_KEY,
  addRewatch,
  cleanRewatches,
  episodeNumberOf,
  levelOf,
  passFor,
  passStatus,
  pendingKeys,
  reconcilePasses,
  removeLastFromSeason,
  removeLatest,
  removePassRewatches,
  rewatchTotal,
  seasonOf,
  startPass,
};
