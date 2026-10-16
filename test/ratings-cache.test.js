const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// A stand-in for PostgreSQL that understands the two statements
// persistent-cache.js sends and the OMDb call count (omdb-budget.js), so the
// cache can be tested without a database.
const rows = new Map();
let omdbCallsToday = 0;
const fakePool = {
  async query(sql, params) {
    if (/omdb_usage/.test(sql)) {
      const [, limit] = params;
      if (omdbCallsToday >= limit) return { rows: [] };
      omdbCallsToday += 1;
      return { rows: [{ calls: omdbCallsToday }] };
    }
    if (/^\s*SELECT/i.test(sql)) {
      // As the real query: an empty answer (null, or no ratings) has its own, shorter life.
      const [key, ttlMs, emptyTtlMs = ttlMs] = params;
      const row = rows.get(key);
      const empty = row && (row.data === null ||
        (row.data && row.data.ratings && Object.keys(row.data.ratings).length === 0));
      const life = empty ? emptyTtlMs : ttlMs;
      return { rows: row && Date.now() - row.at < life ? [{ data: row.data }] : [] };
    }
    const [key, json] = params;
    rows.set(key, { data: JSON.parse(json), at: Date.now() });
    return { rows: [] };
  },
};

process.env.TMDB_ACCESS_TOKEN = 'test-token';
process.env.OMDB_API_KEY = 'test-omdb';
process.env.OMDB_BASE_URL = 'https://omdb.test';
process.env.TMDB_BASE_URL = 'https://tmdb.test/3';

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };

// A fresh copy of tmdb.js, as after a restart: empty in-memory caches, same
// database.
function freshTmdb() {
  for (const name of ['tmdb.js', 'persistent-cache.js', 'omdb-budget.js', 'config.js']) {
    delete require.cache[path.join(__dirname, '..', 'src', name)];
  }
  return require('../src/tmdb');
}

const calls = { tmdb: 0, omdb: 0 };
let omdbMode = 'ok';

// tmdb.js sends its requests through undici's own fetch, so that is what gets
// replaced; freshTmdb() picks the replacement up each time it loads the module.
const undici = require('undici');
const stubFetch = async (url) => {
  const href = String(url);
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
  if (href.startsWith('https://tmdb.test')) {
    calls.tmdb += 1;
    return json({
      id: 1,
      status: 'Ended',
      external_ids: { imdb_id: 'tt0000001' },
      seasons: [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }],
    });
  }
  calls.omdb += 1;
  if (omdbMode === 'quota') {
    return json({ Response: 'False', Error: 'Request limit reached!' }, 401);
  }
  const season = Number(new URL(href).searchParams.get('Season'));
  return json({
    Response: 'True',
    Episodes: [
      { Episode: '1', imdbRating: `${season}.5` },
      { Episode: '2', imdbRating: 'N/A' },
    ],
  });
};
undici.fetch = stubFetch;

test.beforeEach(() => {
  rows.clear();
  omdbCallsToday = 0;
  calls.tmdb = 0;
  calls.omdb = 0;
  omdbMode = 'ok';
});

test('episode ratings come from OMDb once, then from memory', async () => {
  const { getImdbRatings } = freshTmdb();

  const first = await getImdbRatings(1);
  assert.deepEqual(first.ratings, { '1_1': 1.5, '2_1': 2.5 }); // N/A skipped
  assert.equal(calls.omdb, 2, 'one OMDb call per real season');

  await getImdbRatings(1);
  assert.equal(calls.omdb, 2, 'second open asks nobody');
  assert.equal(calls.tmdb, 1);
});

test('after a restart the ratings still come from the database, not OMDb', async () => {
  await freshTmdb().getImdbRatings(1);
  assert.equal(calls.omdb, 2);

  const restarted = freshTmdb();
  const again = await restarted.getImdbRatings(1);
  assert.deepEqual(again.ratings, { '1_1': 1.5, '2_1': 2.5 });
  assert.equal(calls.omdb, 2, 'no new OMDb calls after the restart');
});

test('a quota error is reported as 503, never cached, and stops further calls', async () => {
  omdbMode = 'quota';
  const { getImdbRatings } = freshTmdb();

  await assert.rejects(getImdbRatings(1), (error) => error.status === 503);
  const spent = calls.omdb;
  assert.ok(spent >= 1);
  assert.equal(rows.size, 0, 'nothing was stored as if it were an answer');

  await assert.rejects(getImdbRatings(1), (error) => error.status === 503);
  assert.equal(calls.omdb, spent, 'blocked: OMDb is not asked again');
});

test('a show IMDb rates is remembered for its list rating too', async () => {
  const json = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  });
  undici.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/external_ids')) {
      calls.tmdb += 1;
      return json({ imdb_id: 'tt0000001' });
    }
    calls.omdb += 1;
    return json({ Response: 'True', imdbRating: '8.7' });
  };
  try {
    const list = { results: [{ id: 1, vote_average: 5 }] };
    const first = await freshTmdb().withImdbRatings(list);
    assert.equal(first.results[0].vote_average, 8.7);
    assert.equal(first.results[0].tmdb_vote_average, 5);
    assert.deepEqual(calls, { tmdb: 1, omdb: 1 });

    const second = await freshTmdb().withImdbRatings(list); // as after a restart
    assert.equal(second.results[0].vote_average, 8.7);
    assert.deepEqual(calls, { tmdb: 1, omdb: 1 }, 'the restart cost no provider calls');
  } finally {
    undici.fetch = stubFetch;
  }
});

test("lists spend only their share of the day's OMDb calls; show pages keep the rest", async () => {
  const json = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  });
  undici.fetch = async (url) => {
    const href = String(url);
    const external = href.match(/\/tv\/(\d+)\/external_ids/);
    if (external) return json({ imdb_id: `tt${external[1]}` });
    if (href.startsWith('https://tmdb.test')) {
      const id = Number(href.match(/\/tv\/(\d+)/)[1]);
      return json({
        id,
        status: 'Ended',
        external_ids: { imdb_id: `tt${id}` },
        seasons: [{ season_number: 1 }, { season_number: 2 }],
      });
    }
    calls.omdb += 1;
    const season = new URL(href).searchParams.get('Season');
    return season
      ? json({ Response: 'True', Episodes: [{ Episode: '1', imdbRating: '9.0' }] })
      : json({ Response: 'True', imdbRating: '8.7' });
  };
  process.env.OMDB_DAILY_BUDGET = '4';
  process.env.OMDB_LIST_BUDGET = '2';
  try {
    const tmdb = freshTmdb();
    const list = { results: [1, 2, 3].map((id) => ({ id, vote_average: 5 })) };
    const rated = await tmdb.withImdbRatings(list);
    assert.equal(calls.omdb, 2, 'the list stopped at its share');
    assert.deepEqual(
      rated.results.map((show) => show.vote_average).sort(),
      [5, 8.7, 8.7],
      'the show over the share keeps its TMDB rating',
    );

    const episodes = await tmdb.getImdbRatings(1);
    assert.deepEqual(episodes.ratings, { '1_1': 9, '2_1': 9 }, 'a show page still gets IMDb');
    assert.equal(calls.omdb, 4);

    await assert.rejects(
      tmdb.getImdbRatings(2),
      (error) => error.status === 503,
      "past the whole day's budget the ratings route answers 503",
    );
    assert.equal(calls.omdb, 4, 'and OMDb is not asked');
  } finally {
    delete process.env.OMDB_DAILY_BUDGET;
    delete process.env.OMDB_LIST_BUDGET;
    undici.fetch = stubFetch;
  }
});

// Moves the clock on for the code under test.
function laterBy(ms) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  return () => { Date.now = realNow; };
}

test('"no IMDb id yet" is asked again after a day, not kept for 90', async () => {
  const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  let imdbId = null;
  let idLookups = 0;
  undici.fetch = async (url) => {
    if (String(url).includes('/external_ids')) {
      idLookups += 1;
      return json({ imdb_id: imdbId });
    }
    calls.omdb += 1;
    return json({ Response: 'True', imdbRating: '8.1' });
  };
  try {
    const tmdb = freshTmdb();
    const list = () => ({ results: [{ id: 5, vote_average: 6 }] });
    assert.equal((await tmdb.withImdbRatings(list())).results[0].vote_average, 6);
    assert.equal(idLookups, 1);

    imdbId = 'tt5'; // TMDB has it now
    const restore = laterBy(2 * 24 * 60 * 60 * 1000);
    try {
      const rated = await tmdb.withImdbRatings(list());
      assert.equal(idLookups, 2, 'asked again after a day');
      assert.equal(rated.results[0].vote_average, 8.1);
    } finally {
      restore();
    }
  } finally {
    undici.fetch = stubFetch;
  }
});

test('when an OMDb block ends, one call tests the water; the rest wait for it', async () => {
  omdbMode = 'quota';
  const tmdb = freshTmdb();
  await assert.rejects(tmdb.getImdbRatings(1), (error) => error.status === 503);
  const spent = calls.omdb;

  const restore = laterBy(31 * 60 * 1000);
  try {
    // Still over quota. Without the probe each season of each show called OMDb.
    const results = await Promise.allSettled([7, 8, 9].map((id) => tmdb.getImdbRatings(id)));
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.equal(calls.omdb - spent, 1, 'only the probe reached OMDb');
  } finally {
    restore();
  }
});
