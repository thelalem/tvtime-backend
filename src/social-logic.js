// The rules of the social side (FEATURE_PLAN.md section 19), with no database in them: usernames, who may see whom, and
// the numbers of a comparison. social.js is the routes and the database around it.

// A username: 3 to 20 characters, lower-case letters, digits and underscores, starting with a letter. Stored in lower
// case so @Zola and @zola are one name.
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;

const RESERVED = new Set([
  'admin', 'administrator', 'support', 'help', 'tvtime', 'seenit', 'official', 'staff', 'moderator', 'system', 'root',
  'me', 'you', 'api', 'null', 'undefined', 'anonymous', 'user', 'users', 'settings', 'search', 'login', 'logout',
]);

// The canonical form of what a person typed ("@Zola " becomes "zola"), or null when it is not a username at all.
function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '').toLowerCase();
  return USERNAME.test(name) ? name : null;
}

// `'invalid'`, `'reserved'`, or null when the name can be claimed (before checking whether it is taken).
function usernameProblem(value) {
  const name = normalizeUsername(value);
  if (!name) return 'invalid';
  if (RESERVED.has(name)) return 'reserved';
  return null;
}

// What the person suggested to pick: their name or the start of their e-mail, cleaned into the username alphabet.
function suggestUsername(displayName, email) {
  const source = (displayName && displayName.trim()) || String(email || '').split('@')[0] || 'viewer';
  let name = source.toLowerCase().normalize('NFKD').replace(/[^a-z0-9_]+/g, '');
  if (!/^[a-z]/.test(name)) name = `user${name}`;
  name = name.slice(0, 20);
  while (name.length < 3) name += '1';
  return RESERVED.has(name) ? `${name}1`.slice(0, 20) : name;
}

// Whether `viewer` may see the profile, stats and show lists of `target`.
//   isSelf        viewing their own
//   isPublic      the target's profile is public
//   follows       the viewer follows the target and was accepted
//   blocked       either of them blocked the other
function canViewProfile({ isSelf = false, isPublic = true, follows = false, blocked = false }) {
  if (blocked) return false;
  return isSelf || isPublic || follows;
}

// How alike two people's shows are, 0 to 100: for every show either watched, the smaller number of episodes over the
// larger, added up over all shows (a weighted Jaccard). Two people who watched the same shows the same amount score 100;
// nothing in common scores 0. `a` and `b` map show id to episodes watched.
function similarity(a, b) {
  const ids = new Set([...a.keys(), ...b.keys()]);
  let shared = 0;
  let total = 0;
  for (const id of ids) {
    const x = a.get(id) || 0;
    const y = b.get(id) || 0;
    shared += Math.min(x, y);
    total += Math.max(x, y);
  }
  return total === 0 ? 0 : Math.round((shared / total) * 100);
}

const pick = (stats) => ({
  minutes: stats.totals.minutes.total,
  episodes: stats.totals.episodes,
  movies: stats.totals.movies,
  rewatches: stats.totals.rewatches,
  shows: stats.totals.shows,
  binge: stats.biggestBinge ? stats.biggestBinge.episodes : 0,
  streak: stats.streak.longest ? stats.streak.longest.days : 0,
  activeDays: stats.activeDays,
});

const SHOW_LIMIT = 20;

// The comparison of two people. `myShows` and `theirShows` are [{ id, name, posterPath, episodes }] (episodes watched).
// Returns both sets of numbers, who is ahead on each, the shows they share, the shows only they watch (the ones with the
// most episodes first, "watch together"), and the similarity.
function compare({ myStats, theirStats, myShows, theirShows }) {
  const you = pick(myStats);
  const them = pick(theirStats);
  const rows = Object.keys(you).map((key) => ({
    key,
    you: you[key],
    them: them[key],
    ahead: you[key] === them[key] ? 'tie' : you[key] > them[key] ? 'you' : 'them',
  }));
  const mine = new Map(myShows.map((show) => [show.id, show]));
  const theirs = new Map(theirShows.map((show) => [show.id, show]));
  const card = (show, yours, theirsEpisodes) => ({
    id: show.id, name: show.name, posterPath: show.posterPath || null, you: yours, them: theirsEpisodes,
  });
  const common = [...theirs.values()]
    .filter((show) => mine.has(show.id))
    .map((show) => card(show, mine.get(show.id).episodes, show.episodes))
    .sort((x, y) => Math.min(y.you, y.them) - Math.min(x.you, x.them))
    .slice(0, SHOW_LIMIT);
  const onlyThem = [...theirs.values()]
    .filter((show) => !mine.has(show.id) && show.episodes > 0)
    .sort((x, y) => y.episodes - x.episodes)
    .slice(0, SHOW_LIMIT)
    .map((show) => card(show, 0, show.episodes));
  return {
    rows,
    commonShows: common,
    commonCount: [...theirs.keys()].filter((id) => mine.has(id)).length,
    onlyThem,
    similarity: similarity(
      new Map(myShows.map((show) => [show.id, show.episodes])),
      new Map(theirShows.map((show) => [show.id, show.episodes])),
    ),
  };
}

module.exports = {
  RESERVED, USERNAME, canViewProfile, compare, normalizeUsername, similarity, suggestUsername, usernameProblem,
};
