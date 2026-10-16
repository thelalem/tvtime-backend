const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// A stand-in for PostgreSQL that understands what persistent-cache.js sends.
const rows = new Map();
const fakePool = {
  async query(sql, params) {
    if (/omdb_usage/.test(sql)) return { rows: [{ calls: 1 }] };
    if (/^\s*SELECT/i.test(sql)) {
      const [key, ttlMs] = params;
      const row = rows.get(key);
      return { rows: row && Date.now() - row.at < ttlMs ? [{ data: row.data }] : [] };
    }
    rows.set(params[0], { data: JSON.parse(params[1]), at: Date.now() });
    return { rows: [] };
  },
};
process.env.TMDB_ACCESS_TOKEN = 'test-token';
process.env.TVMAZE_BASE_URL = 'https://tvmaze.test';
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };

let answers = [];
let requests = 0;
const undici = require('undici');
undici.fetch = async () => {
  requests += 1;
  const status = answers.length ? answers.shift() : 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ id: 42, name: 'Show' }),
  };
};

function freshTmdb() {
  for (const name of ['tmdb.js', 'persistent-cache.js', 'omdb-budget.js', 'config.js']) {
    delete require.cache[path.join(__dirname, '..', 'src', name)];
  }
  return require('../src/tmdb');
}

test.beforeEach(() => {
  rows.clear();
  answers = [];
  requests = 0;
});

test('a TVMaze outage is not cached as "no show"; the next lookup asks again', async () => {
  const tmdb = freshTmdb();
  answers = [503, 503, 503]; // every retry of the first lookup fails
  await assert.rejects(tmdb.getTvMazeShow('Show'));
  const afterFailure = requests;

  const show = await tmdb.getTvMazeShow('Show');
  assert.equal(show.id, 42);
  assert.ok(requests > afterFailure, 'asked again');
});

test('TVMaze not knowing a show is cached', async () => {
  const tmdb = freshTmdb();
  answers = [404];
  assert.equal(await tmdb.getTvMazeShow('Unknown'), null);
  const asked = requests;
  assert.equal(await tmdb.getTvMazeShow('Unknown'), null);
  assert.equal(requests, asked, 'not asked twice');
});

test('an id TMDB does not know is answered 404, not 502 like an outage', async () => {
  const tmdb = freshTmdb();
  answers = [404];
  await assert.rejects(tmdb.getTvShow(999999), (error) => error.status === 404);
  answers = [503, 503, 503];
  await assert.rejects(tmdb.getTvShow(999998), (error) => error.status === 502);
});

test('the memory cache keeps to its size and drops the least recently used first', async () => {
  process.env.PROVIDER_CACHE_MAX_MB = String(110 / (1024 * 1024)); // room for two small answers
  try {
    const tmdb = freshTmdb();
    await tmdb.getTvShow(1);
    await tmdb.getTvShow(2);
    await tmdb.getTvShow(1); // used again: now the most recent
    await tmdb.getTvShow(3); // over budget: 2 goes, not 1
    const before = requests;
    await tmdb.getTvShow(1);
    assert.equal(requests, before, '1 is still cached');
    await tmdb.getTvShow(2);
    assert.equal(requests, before + 1, '2 was dropped');
  } finally {
    delete process.env.PROVIDER_CACHE_MAX_MB;
  }
});
