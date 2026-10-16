const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const lookups = [];
let failFor = null;
const stub = {
  findEpisodeByTvdbId: async (id) => {
    lookups.push(`episode:${id}`);
    if (id === '5') throw new Error('TMDB down');
    return id === '10736237' ? { show: 281666, season: 1, episode: 1 } : null;
  },
  findMovieByTitle: async (title, year) => {
    lookups.push(`title:${title}:${year}`);
    return title === 'My Oxford Year' ? 1307078 : null;
  },
  findTmdbId: async (kind, id) => {
    lookups.push(`${kind}:${id}`);
    if (id === failFor) throw new Error('TMDB down');
    if (id === '999' || id === 'tt0999999') return null;
    return kind === 'movie' ? 7000 + Number(id.slice(2)) % 1000 : 1000 + Number(id);
  },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('import-resolve.js') && request === './tmdb') return stub;
  return originalLoad.call(this, request, parent, ...rest);
};
const { registerImportResolveRoute, MAX_IDS } = require('../src/import-resolve');

let handler;
registerImportResolveRoute({ post: (_path, fn) => { handler = fn; } });

async function call(body) {
  let status = 200;
  let payload;
  const response = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
  await handler({ body }, response, (error) => { throw error; });
  return { status, payload };
}

test.beforeEach(() => { lookups.length = 0; failFor = null; });

test('turns TVDB and IMDb ids into TMDB ids, keeping unknown ones as null', async () => {
  const { status, payload } = await call({ tvdb: [81189, '999'], imdb: ['tt0163025', 'tt0999999'] });
  assert.equal(status, 200);
  assert.equal(payload.tvdb['81189'], 1000 + 81189);
  assert.equal(payload.tvdb['999'], null);
  assert.equal(payload.imdb.tt0163025, 7000 + 163025 % 1000);
  assert.equal(payload.imdb.tt0999999, null);
  assert.deepEqual(payload.failed, []);
});

test('an id the lookup failed on is named in failed and left out of the answer', async () => {
  failFor = '5';
  const { payload } = await call({ tvdb: [5, 6] });
  assert.deepEqual(payload.failed, ['tvdb:5']);
  assert.equal('5' in payload.tvdb, false);
  assert.equal(payload.tvdb['6'], 1006);
});

test('repeated ids are looked up once', async () => {
  await call({ tvdb: [6, 6, '6'] });
  assert.equal(lookups.length, 1);
});

test('bad input is refused', async () => {
  for (const body of [
    { tvdb: 'x' }, { tvdb: [-1] }, { tvdb: ['1; DROP'] }, { imdb: ['12345'] }, { imdb: [5] },
    { tvdb: Array.from({ length: MAX_IDS + 1 }, (_, i) => i + 1) },
  ]) {
    const { status, payload } = await call(body);
    assert.equal(status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(payload.error, 'invalid_ids');
  }
  assert.equal(lookups.length, 0);
});

test('movies the id lookup cannot find are matched by title and year', async () => {
  const { status, payload } = await call({
    search: [{ key: 'tt32641187', title: 'My Oxford Year', year: 2025 }, { key: 'tt1', title: 'Nope', year: 2000 }],
  });
  assert.equal(status, 200);
  assert.deepEqual(payload.search, { tt32641187: 1307078, tt1: null });
});

test('bad search items are refused', async () => {
  for (const search of [{}, [{ key: 'a', title: '', year: 2000 }], [{ key: 'a', title: 'x', year: 'y' }],
    Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, title: 't', year: 2000 }))]) {
    assert.equal((await call({ search })).status, 400);
  }
});

test('episodes are placed by TVDB episode id: show, season and number, or null', async () => {
  const { payload } = await call({ episodes: [10736237, 99, 5] });
  assert.deepEqual(payload.episodes, { 10736237: { show: 281666, season: 1, episode: 1 }, 99: null });
  assert.deepEqual(payload.failed, ['episodes:5']);
  assert.equal((await call({ episodes: Array.from({ length: 201 }, (_, i) => i + 1) })).status, 400);
  assert.equal((await call({ episodes: ['x'] })).status, 400);
});

test('an empty request answers empty maps', async () => {
  const { payload } = await call({});
  assert.deepEqual(payload, { tvdb: {}, imdb: {}, search: {}, episodes: {}, failed: [] });
});
