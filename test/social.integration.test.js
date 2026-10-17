// The social routes (social.js) through the real routes and PostgreSQL. Skipped unless TEST_DATABASE_URL is set; see
// progress-endpoints.integration.test.js for how to run it.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  test('social integration tests (set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = url;

const stubs = {
  './firebase': {
    admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token, email: `${token}@example.test` }) }) },
  },
  './tmdb': {
    getTvSeason: async () => ({ season_number: 1, episodes: [] }),
    getTvShowClassificationData: async () => ({
      seasons: [], status: 'Ended', episode_run_time: [30], genres: [{ name: 'Drama' }], networks: [{ name: 'Netflix' }],
    }),
  },
  './upcoming': { getUpcomingEpisodes: async () => [] },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  const file = parent && parent.filename;
  if (file && (file.endsWith('user-data.js') || file.endsWith('stats.js')) && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};

const express = require('express');
const { pool } = require('../src/db');
const { initializeDatabase } = require('../src/schema');
const { router } = require('../src/user-data');
const { notifyFollow } = require('../src/notifications');

const users = [];
let server;
let base;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function newUser() {
  const uid = `it-social-${run}-${users.length}`;
  users.push(uid);
  return uid;
}

async function api(uid, method, route, body) {
  const response = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${uid}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  const text = type.includes('json') ? await response.text() : null;
  return { status: response.status, body: text ? JSON.parse(text) : null, response };
}

// A person with a username, and optionally some watching.
async function person(name, { watched = [], favorite = null, isPublic = true } = {}) {
  const uid = newUser();
  assert.equal((await api(uid, 'PUT', '/me/social/username', { username: `${name}_${run}`.slice(0, 20) })).status, 200);
  const handle = `${name}_${run}`.slice(0, 20);
  for (const [show, count] of watched) {
    const actions = Array.from({ length: count }, (_, i) => ({
      key: `S1E${i + 1}`, watched: true, at: `2026-05-1${i % 9}T${String(10 + i).padStart(2, '0')}:00:00Z`,
    }));
    assert.equal((await api(uid, 'POST', `/me/progress/${show}/import`, { totalEpisodes: 30, showName: `Show ${show}`, actions })).status, 200);
  }
  if (favorite) assert.equal((await api(uid, 'PUT', `/me/favorites/${favorite}`, { id: favorite, name: `Fav ${favorite}`, posterPath: '/f.jpg' })).status, 200);
  if (!isPublic) assert.equal((await api(uid, 'PATCH', '/me/social/privacy', { public: false })).status, 200);
  return { uid, handle };
}

test.before(async () => {
  await initializeDatabase();
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/v1', router);
  app.use((error, _request, response, _next) => {
    response.status(error.status || 500).json({ detail: error.message });
  });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (users.length) await pool.query('DELETE FROM app_users WHERE firebase_uid = ANY($1)', [users]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('username: a suggestion first, then check, claim, change, and the refusals', async () => {
  const uid = newUser();
  const first = await api(uid, 'GET', '/me/social');
  assert.equal(first.status, 200);
  assert.equal(first.body.username, null);
  assert.match(first.body.suggestion, /^[a-z][a-z0-9_]{2,19}$/);
  assert.deepEqual([first.body.following, first.body.followers, first.body.pendingRequests], [0, 0, 0]);
  assert.equal(first.body.isPublic, true, 'public by default');

  const name = `check_${run}`.slice(0, 20);
  assert.deepEqual((await api(uid, 'GET', `/me/social/username/available?name=${name}`)).body, { available: true, username: name });
  assert.deepEqual((await api(uid, 'GET', '/me/social/username/available?name=ab')).body, { available: false, reason: 'invalid' });
  assert.deepEqual((await api(uid, 'GET', '/me/social/username/available?name=admin')).body, { available: false, reason: 'reserved' });
  assert.equal((await api(uid, 'PUT', '/me/social/username', { username: name })).status, 200);
  assert.equal((await api(uid, 'GET', '/me/social')).body.username, name);

  const other = newUser();
  assert.deepEqual((await api(other, 'GET', `/me/social/username/available?name=${name.toUpperCase()}`)).body, { available: false, reason: 'taken' });
  assert.equal((await api(other, 'PUT', '/me/social/username', { username: `@${name}` })).status, 409);
  assert.equal((await api(other, 'PUT', '/me/social/username', { username: 'no' })).status, 400);
  assert.equal((await api(other, 'PUT', '/me/social/username', { username: 'Admin' })).status, 400);
  assert.deepEqual((await api(uid, 'GET', `/me/social/username/available?name=${name}`)).body.available, true, 'your own name is still yours');
  const renamed = `moved_${run}`.slice(0, 20);
  assert.equal((await api(uid, 'PUT', '/me/social/username', { username: renamed })).status, 200);
  assert.equal((await api(other, 'PUT', '/me/social/username', { username: name })).status, 409, 'the old name is held for its owner for 14 days');
});

test('follow a public profile: accepted at once, counted, listed, idempotent, undone', async () => {
  const ann = await person('ann');
  const bob = await person('bob');
  const follow = await api(ann.uid, 'POST', `/me/social/following/${bob.handle}`);
  assert.equal(follow.status, 201);
  assert.equal(follow.body.status, 'accepted');
  assert.equal((await api(ann.uid, 'POST', `/me/social/following/${bob.handle}`)).status, 200, 'a repeat is not a new follow');
  assert.equal((await api(ann.uid, 'POST', `/me/social/following/${ann.handle}`)).status, 400);
  assert.equal((await api(ann.uid, 'POST', '/me/social/following/nobody_here')).status, 404);

  assert.equal((await api(ann.uid, 'GET', '/me/social')).body.following, 1);
  assert.equal((await api(bob.uid, 'GET', '/me/social')).body.followers, 1);
  assert.deepEqual((await api(ann.uid, 'GET', '/me/social/following')).body.people.map((p) => p.username), [bob.handle]);
  const followers = (await api(bob.uid, 'GET', '/me/social/followers')).body.people;
  assert.deepEqual(followers.map((p) => [p.username, p.followedByYou]), [[ann.handle, false]]);
  await api(bob.uid, 'POST', `/me/social/following/${ann.handle}`);
  assert.equal((await api(bob.uid, 'GET', '/me/social/followers')).body.people[0].followedByYou, true);

  assert.equal((await api(ann.uid, 'DELETE', `/me/social/following/${bob.handle}`)).status, 204);
  assert.equal((await api(ann.uid, 'GET', '/me/social')).body.following, 0);
  await api(ann.uid, 'POST', `/me/social/following/${bob.handle}`);
  assert.equal((await api(bob.uid, 'DELETE', `/me/social/followers/${ann.handle}`)).status, 204, 'a follower can be removed');
  assert.equal((await api(bob.uid, 'GET', '/me/social')).body.followers, 0);
});

test('a private profile: the follow waits, shows nothing, then is accepted or declined', async () => {
  const cat = await person('cat', { watched: [[9401, 3]], isPublic: false });
  const dan = await person('dan');
  const eve = await person('eve');
  assert.equal((await api(dan.uid, 'POST', `/me/social/following/${cat.handle}`)).body.status, 'pending');
  await api(eve.uid, 'POST', `/me/social/following/${cat.handle}`);
  assert.equal((await api(cat.uid, 'GET', '/me/social')).body.pendingRequests, 2);
  assert.equal((await api(cat.uid, 'GET', '/me/social')).body.followers, 0, 'pending is not a follower yet');

  const closed = (await api(dan.uid, 'GET', `/me/social/users/${cat.handle}`)).body;
  assert.equal(closed.canView, false);
  assert.equal(closed.stats, undefined);
  assert.equal(closed.shows, undefined);
  assert.equal(closed.relation.following, 'pending');
  assert.equal((await api(dan.uid, 'GET', `/me/social/users/${cat.handle}/compare`)).status, 403);

  assert.deepEqual((await api(cat.uid, 'GET', '/me/social/requests')).body.people.map((p) => p.username).sort(), [dan.handle, eve.handle].sort());
  assert.equal((await api(cat.uid, 'POST', `/me/social/requests/${dan.handle}/accept`)).status, 200);
  assert.equal((await api(cat.uid, 'POST', `/me/social/requests/${dan.handle}/accept`)).status, 404, 'already accepted');
  assert.equal((await api(cat.uid, 'DELETE', `/me/social/requests/${eve.handle}`)).status, 204);

  const open = (await api(dan.uid, 'GET', `/me/social/users/${cat.handle}`)).body;
  assert.equal(open.canView, true);
  assert.equal(open.stats.totals.episodes, 3);
  assert.equal(open.shows[0].episodes, 3);
  assert.equal((await api(eve.uid, 'GET', `/me/social/users/${cat.handle}`)).body.canView, false, 'a declined request sees nothing');
  assert.equal((await api(cat.uid, 'GET', '/me/social')).body.followers, 1);

  // Going public lets the waiting in.
  await api(eve.uid, 'POST', `/me/social/following/${cat.handle}`);
  assert.equal((await api(cat.uid, 'PATCH', '/me/social/privacy', { public: true })).status, 200);
  assert.equal((await api(cat.uid, 'GET', '/me/social')).body.followers, 2);
  assert.equal((await api(eve.uid, 'GET', `/me/social/users/${cat.handle}`)).body.canView, true);
  assert.equal((await api(cat.uid, 'PATCH', '/me/social/privacy', { public: 'yes' })).status, 400);
});

test('a profile shows stats and lists, never ratings, and your own profile works too', async () => {
  const fay = await person('fay', { watched: [[9501, 4], [9502, 2]], favorite: 9503 });
  const gus = await person('gus');
  await pool.query(
    'INSERT INTO episode_user_data(firebase_uid, series_id, season, episode, rating) VALUES ($1, 9501, 1, 1, 5)', [fay.uid],
  );
  const seen = (await api(gus.uid, 'GET', `/me/social/users/${fay.handle}`)).body;
  assert.equal(seen.canView, true);
  assert.equal(seen.stats.totals.episodes, 6);
  assert.equal(seen.stats.ratings, null, 'ratings are private');
  assert.deepEqual(seen.shows.map((s) => [s.id, s.episodes]).sort(), [[9501, 4], [9502, 2]]);
  assert.deepEqual(seen.favoriteShows.map((s) => [s.id, s.name, s.posterPath]), [[9503, 'Fav 9503', '/f.jpg']]);
  assert.equal(seen.pendingRequests, undefined, 'only the person themselves knows how many requests wait');
  assert.equal((await api(fay.uid, 'GET', `/me/social/users/${fay.handle}`)).body.isSelf, true);
  assert.equal((await api(gus.uid, 'GET', '/me/social/users/not_a_user')).status, 404);
});

test('compare: numbers, shared and only-theirs shows, similarity; not yourself', async () => {
  const hal = await person('hal', { watched: [[9601, 5], [9602, 2]] });
  const ivy = await person('ivy', { watched: [[9601, 3], [9603, 6]] });
  const result = (await api(hal.uid, 'GET', `/me/social/users/${ivy.handle}/compare`)).body;
  assert.equal(result.username, ivy.handle);
  const row = (key) => result.rows.find((r) => r.key === key);
  assert.deepEqual([row('episodes').you, row('episodes').them, row('episodes').ahead], [7, 9, 'them']);
  assert.deepEqual(result.commonShows.map((s) => [s.id, s.you, s.them]), [[9601, 5, 3]]);
  assert.equal(result.commonCount, 1);
  assert.deepEqual(result.onlyThem.map((s) => [s.id, s.them]), [[9603, 6]]);
  assert.ok(result.similarity > 0 && result.similarity < 100);
  assert.equal((await api(hal.uid, 'GET', `/me/social/users/${hal.handle}/compare`)).status, 400);
});

test('following needs a username of your own (a follow from someone without one could never be answered)', async () => {
  const pia = await person('pia', { isPublic: false });
  const nameless = newUser();
  const refused = await api(nameless, 'POST', `/me/social/following/${pia.handle}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'username_required');
  const counts = (await api(pia.uid, 'GET', `/me/social/users/${pia.handle}`)).body;
  assert.equal(counts.followers, 0);
});

test("a username given up stays its owner's for 14 days; they can take it back", async () => {
  const ava = await person('hld');
  const bob = await person('clm');
  const freed = ava.handle;
  const renamed = `hld2_${run}`.slice(0, 20);
  assert.equal((await api(ava.uid, 'PUT', '/me/social/username', { username: renamed })).status, 200);
  assert.equal((await api(bob.uid, 'GET', `/me/social/username/available?name=${freed}`)).body.available, false);
  assert.equal((await api(bob.uid, 'PUT', '/me/social/username', { username: freed })).status, 409);
  assert.equal((await api(ava.uid, 'GET', `/me/social/username/available?name=${freed}`)).body.available, true);
  assert.equal((await api(ava.uid, 'PUT', '/me/social/username', { username: freed })).status, 200, 'its owner takes it back');
  // After 14 days it is free for anyone.
  assert.equal((await api(ava.uid, 'PUT', '/me/social/username', { username: renamed })).status, 200);
  await pool.query("UPDATE username_holds SET released_at = NOW() - INTERVAL '15 days' WHERE username = $1", [freed]);
  assert.equal((await api(bob.uid, 'PUT', '/me/social/username', { username: freed })).status, 200);
});

test('compare?kind=movies compares the watched movies: rows, shared, only theirs, genre score', async () => {
  const maya = await person('maya');
  const noel = await person('noel');
  const add = (uid, id, title, runtime, genres, watchedOn) => pool.query(
    `INSERT INTO movie_watchlist(firebase_uid, movie_id, movie, watched_on) VALUES ($1, $2, $3::jsonb, $4)`,
    [uid, id, JSON.stringify({ title, runtime, poster_path: `/${id}.jpg`, genre_ids: genres, release_date: '2010-01-01' }), watchedOn],
  );
  await add(maya.uid, 501, 'Both Film', 100, [28], '2026-03-01');
  await add(maya.uid, 502, 'Only Maya', 120, [35], '2026-03-02');
  await add(maya.uid, 503, 'Not watched', 90, [28], null);
  await add(noel.uid, 501, 'Both Film', 100, [28], '2026-04-01');
  await add(noel.uid, 504, 'Only Noel', 150, [28], '2026-04-02');
  await add(noel.uid, 505, 'Only Noel 2', 80, [28, 12], '2026-04-03');

  const { status, body } = await api(maya.uid, 'GET', `/me/social/users/${noel.handle}/compare?kind=movies`);
  assert.equal(status, 200);
  assert.equal(body.kind, 'movies');
  const row = (key) => body.rows.find((r) => r.key === key);
  assert.deepEqual([row('movies').you, row('movies').them, row('movies').ahead], [2, 3, 'them']);
  assert.deepEqual([row('minutes').you, row('minutes').them], [220, 330]);
  assert.equal(row('longest').them, 150);
  assert.deepEqual(body.commonShows.map((m) => m.id), [501]);
  assert.equal(body.commonCount, 1);
  assert.deepEqual(body.onlyThem.map((m) => [m.id, m.you]), [[505, 80], [504, 150]], 'their most recent first, with runtimes');
  assert.ok(body.similarity > 0 && body.similarity <= 100);
  // Watch together: unseen movies on both lists (and not the ones one of them has watched).
  await add(maya.uid, 601, 'Both Want', 100, [28], null);
  await add(noel.uid, 601, 'Both Want', 100, [28], null);
  await add(maya.uid, 602, 'Maya Wants', 100, [28], null);
  await add(noel.uid, 602, 'Maya Wants', 100, [28], '2026-05-01'); // Noel has watched it: not to watch together
  const together = (await api(maya.uid, 'GET', `/me/social/users/${noel.handle}/compare?kind=movies`)).body;
  assert.deepEqual(together.watchTogether.map((m) => m.id), [601]);
  assert.equal(together.watchTogetherCount, 1);
  assert.ok(together.onlyThem.some((m) => m.id === 602), 'the one only Noel watched is a catch-up');
  // Shows stay the default; an unknown kind is the shows comparison.
  assert.equal((await api(maya.uid, 'GET', `/me/social/users/${noel.handle}/compare`)).body.kind, 'shows');
  assert.equal((await api(maya.uid, 'GET', `/me/social/users/${noel.handle}/compare?kind=nonsense`)).body.kind, 'shows');
});

test('compare: shows on both watchlists that neither has started are to watch together', async () => {
  const una = await person('una2', { watched: [[9701, 3]] });
  const vic = await person('vic2');
  const listed = (uid, id, name) => pool.query(
    `INSERT INTO watchlist(firebase_uid, series_id, series) VALUES ($1, $2, $3::jsonb)`,
    [uid, id, JSON.stringify({ id, name, posterPath: `/${id}.jpg` })],
  );
  await listed(una.uid, 9801, 'Both Later');
  await listed(vic.uid, 9801, 'Both Later');
  await listed(una.uid, 9802, 'Only Una');
  await listed(vic.uid, 9701, 'Una Started It'); // on Vic's list, but Una has watched episodes of it
  await listed(una.uid, 9701, 'Una Started It');
  const body = (await api(una.uid, 'GET', `/me/social/users/${vic.handle}/compare`)).body;
  assert.deepEqual(body.watchTogether.map((s) => [s.id, s.name, s.posterPath]), [[9801, 'Both Later', '/9801.jpg']]);
  assert.equal(body.watchTogetherCount, 1);
});

test('compare counts every show, not only the most recent 300', async () => {
  const kai = await person('kai', { watched: [[9801, 2]] });
  const lea = await person('lea', { watched: [[9801, 4]] });
  // Lea has watched 320 more shows since 9801, which is now her oldest.
  await pool.query(
    `INSERT INTO show_progress(firebase_uid, series_id, show_name, watched_count, last_watched)
     SELECT $1, 990000 + n, 'Filler ' || n, 1, NOW() - (n || ' minutes')::interval FROM generate_series(1, 320) AS n`,
    [lea.uid],
  );
  await pool.query(
    "UPDATE show_progress SET last_watched = NOW() - INTERVAL '5 years' WHERE firebase_uid=$1 AND series_id=9801",
    [lea.uid],
  );
  const result = (await api(kai.uid, 'GET', `/me/social/users/${lea.handle}/compare`)).body;
  assert.equal(result.commonCount, 1, 'the shared show is found though it is her oldest');
  assert.deepEqual(result.commonShows.map((s) => s.id), [9801]);
  // Her profile still lists at most 300.
  const profile = (await api(kai.uid, 'GET', `/me/social/users/${lea.handle}`)).body;
  assert.equal(profile.shows.length, 300);
});

test('block: both vanish for each other, follows go, and unblocking brings them back', async () => {
  const jon = await person('jon', { watched: [[9701, 2]] });
  const kay = await person('kay');
  await api(kay.uid, 'POST', `/me/social/following/${jon.handle}`);
  await api(jon.uid, 'POST', `/me/social/following/${kay.handle}`);
  assert.equal((await api(jon.uid, 'POST', `/me/social/blocks/${kay.handle}`)).status, 204);
  assert.equal((await api(jon.uid, 'POST', `/me/social/blocks/${jon.handle}`)).status, 400);
  assert.deepEqual((await api(jon.uid, 'GET', '/me/social/blocks')).body.people.map((p) => p.username), [kay.handle]);
  for (const [who, other] of [[jon, kay], [kay, jon]]) {
    assert.equal((await api(who.uid, 'GET', `/me/social/users/${other.handle}`)).status, 404);
    assert.equal((await api(who.uid, 'POST', `/me/social/following/${other.handle}`)).status, 404);
    assert.equal((await api(who.uid, 'GET', `/me/social/users/${other.handle}/avatar`)).status, 404);
    assert.deepEqual((await api(who.uid, 'GET', `/me/social/search?q=${other.handle.slice(0, 5)}`)).body.results.filter((r) => r.username === other.handle), []);
  }
  assert.equal((await api(jon.uid, 'GET', '/me/social')).body.followers, 0, 'the follows were removed');
  assert.equal((await api(jon.uid, 'GET', '/me/social')).body.following, 0);
  assert.equal((await api(jon.uid, 'DELETE', `/me/social/blocks/${kay.handle}`)).status, 204);
  assert.equal((await api(kay.uid, 'GET', `/me/social/users/${jon.handle}`)).status, 200);
});

test('search: usernames that start with the text, without yourself, escaping _ and %', async () => {
  const stem = `zq${run}`.slice(0, 8);
  const a = await person(`${stem}_a`);
  const b = await person(`${stem}_b`);
  const c = await person(`${stem}xc`);
  const asker = await person('searcher');
  const found = (await api(asker.uid, 'GET', `/me/social/search?q=@${stem.toUpperCase()}`)).body.results.map((r) => r.username).sort();
  assert.deepEqual(found, [a.handle, b.handle, c.handle].sort());
  // an underscore in the query is a literal underscore, not "any character"
  const underscore = (await api(asker.uid, 'GET', `/me/social/search?q=${stem}_`)).body.results.map((r) => r.username).sort();
  assert.deepEqual(underscore, [a.handle, b.handle].sort());
  assert.deepEqual((await api(asker.uid, 'GET', '/me/social/search?q=%25')).body.results, []);
  assert.deepEqual((await api(asker.uid, 'GET', '/me/social/search?q=a')).body.results, [], 'one character is too short');
  await api(asker.uid, 'POST', `/me/social/following/${a.handle}`);
  const marked = (await api(asker.uid, 'GET', `/me/social/search?q=${stem}_a`)).body.results[0];
  assert.equal(marked.following, 'accepted');
  assert.equal((await api(a.uid, 'GET', `/me/social/search?q=${stem}_a`)).body.results.length, 0, 'not yourself');
});

test('rate limits and the sign-in check', async () => {
  const noisy = newUser();
  let refused = null;
  for (let i = 0; i < 40 && !refused; i++) {
    const answer = await api(noisy, 'GET', '/me/social/search?q=zz');
    if (answer.status === 429) refused = answer;
  }
  assert.ok(refused, 'the 31st lookup in a minute is refused');
  assert.equal(refused.body.error, 'rate_limited');
  assert.ok(Number(refused.response.headers.get('retry-after')) > 0);
  assert.equal((await fetch(`${base}/api/v1/me/social`)).status, 401);
});

test('deleting an account removes its follows, blocks and username', async () => {
  const lee = await person('lee');
  const max = await person('max');
  await api(lee.uid, 'POST', `/me/social/following/${max.handle}`);
  await api(max.uid, 'POST', `/me/social/blocks/${lee.handle}`);
  await api(lee.uid, 'POST', `/me/social/following/${max.handle}`).catch(() => {});
  assert.equal((await api(lee.uid, 'DELETE', '/me', { confirm: 'delete' })).status, 204);
  const left = await pool.query('SELECT 1 FROM follows WHERE follower_uid = $1 OR followee_uid = $1', [lee.uid]);
  const blocks = await pool.query('SELECT 1 FROM blocks WHERE blocker_uid = $1 OR blocked_uid = $1', [lee.uid]);
  assert.equal(left.rowCount + blocks.rowCount, 0);
  assert.equal((await api(max.uid, 'GET', `/me/social/users/${lee.handle}`)).status, 404);
});

// --- the push when someone follows ------------------------------------------------------------------------------------
async function withDevice(uid) {
  const token = `tok-${uid}-${'x'.repeat(24)}`;
  await pool.query('INSERT INTO device_tokens(token, firebase_uid) VALUES ($1, $2) ON CONFLICT DO NOTHING', [token, uid]);
  return token;
}
function recorder(result = []) {
  const sent = [];
  const send = async (tokens, message) => {
    sent.push({ tokens, ...message });
    if (result instanceof Error) throw result;
    return result;
  };
  return { sent, send };
}

test('follow push: a quiet "started following you", once a day for the same two people', async () => {
  const nat = await person('nat');
  const olly = await person('olly');
  const token = await withDevice(olly.uid);
  const push = recorder();
  assert.equal(await notifyFollow(pool, { followerUid: nat.uid, followeeUid: olly.uid, status: 'accepted' }, push.send), true);
  assert.equal(push.sent.length, 1);
  const message = push.sent[0];
  assert.deepEqual(message.tokens, [token]);
  assert.equal(message.title, 'New follower');
  assert.equal(message.body, `@${nat.handle} started following you`);
  assert.deepEqual(message.data, { type: 'new_follower', username: nat.handle, status: 'accepted' });
  assert.equal(message.silent, true, 'a quiet push');
  assert.equal(message.tag, `follower-${nat.handle}`);
  assert.equal(await notifyFollow(pool, { followerUid: nat.uid, followeeUid: olly.uid, status: 'accepted' }, push.send), false, 'not twice in a day');
  assert.equal(push.sent.length, 1);
  await pool.query(`UPDATE follow_notices SET sent_at = NOW() - INTERVAL '2 days' WHERE follower_uid = $1`, [nat.uid]);
  assert.equal(await notifyFollow(pool, { followerUid: nat.uid, followeeUid: olly.uid, status: 'accepted' }, push.send), true, 'a day later it may go again');
});

test('follow push: a request says so, a display name is used, and the switches and devices are respected', async () => {
  const pam = await person('pam');
  const quin = await person('quin');
  await pool.query(`UPDATE app_users SET display_name = 'Pam Beesly' WHERE firebase_uid = $1`, [pam.uid]);
  const none = recorder();
  assert.equal(await notifyFollow(pool, { followerUid: pam.uid, followeeUid: quin.uid, status: 'pending' }, none.send), false, 'no device, no push');
  await withDevice(quin.uid);
  const push = recorder();
  assert.equal(await notifyFollow(pool, { followerUid: pam.uid, followeeUid: quin.uid, status: 'pending' }, push.send), true);
  assert.equal(push.sent[0].title, 'Follow request');
  assert.equal(push.sent[0].body, 'Pam Beesly wants to follow you');
  assert.equal(push.sent[0].data.status, 'pending');

  await pool.query('DELETE FROM follow_notices');
  assert.equal((await api(quin.uid, 'PATCH', '/me/notification-settings', { social: false })).body.social, false);
  assert.equal((await api(quin.uid, 'GET', '/me/notification-settings')).body.social, false);
  assert.equal(await notifyFollow(pool, { followerUid: pam.uid, followeeUid: quin.uid, status: 'accepted' }, push.send), false, 'follower alerts are off');
  assert.equal((await api(quin.uid, 'PATCH', '/me/notification-settings', { social: true, enabled: false })).body.enabled, false);
  assert.equal(await notifyFollow(pool, { followerUid: pam.uid, followeeUid: quin.uid, status: 'accepted' }, push.send), false, 'all notifications are off');
  assert.equal(push.sent.length, 1);
  assert.equal((await api(quin.uid, 'PATCH', '/me/notification-settings', {})).status, 400);
  assert.equal((await api(quin.uid, 'PATCH', '/me/notification-settings', { social: 'yes' })).status, 400);
  assert.equal((await api(quin.uid, 'PATCH', '/me/notification-settings', { enabled: true })).body.social, true, 'the other switch is left alone');
});

test('follow push: a failed send is tried again on the next follow, and dead devices are removed', async () => {
  const rae = await person('rae');
  const sam = await person('sam');
  const token = await withDevice(sam.uid);
  const failing = recorder(new Error('FCM is down'));
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal(await notifyFollow(pool, { followerUid: rae.uid, followeeUid: sam.uid, status: 'accepted' }, failing.send), false);
  } finally {
    console.error = log;
  }
  const dead = recorder([token]);
  assert.equal(await notifyFollow(pool, { followerUid: rae.uid, followeeUid: sam.uid, status: 'accepted' }, dead.send), true, 'the failure did not use up the day');
  assert.equal((await pool.query('SELECT 1 FROM device_tokens WHERE token = $1', [token])).rowCount, 0, 'a dead token is deleted');
});

test('following through the route sends the push (to a user with a device)', async () => {
  const tom = await person('tom');
  const una = await person('una');
  await withDevice(una.uid);
  // The real route uses the real sender, which cannot reach Firebase here: the follow must still succeed.
  const log = console.error;
  console.error = () => {};
  try {
    assert.equal((await api(tom.uid, 'POST', `/me/social/following/${una.handle}`)).status, 201);
  } finally {
    console.error = log;
  }
});
