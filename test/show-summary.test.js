const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.TMDB_ACCESS_TOKEN = 'test-token';
process.env.TMDB_BASE_URL = 'https://tmdb.test/3';
process.env.OMDB_API_KEY = 'test-omdb';
process.env.OMDB_BASE_URL = 'https://omdb.test';

const asked = [];
const undici = require('undici');
undici.fetch = async (url) => {
  asked.push(String(url));
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      id: 7,
      name: 'Seven',
      overview: 'A show.',
      poster_path: '/p.jpg',
      backdrop_path: '/b.jpg',
      vote_average: 7.4,
      first_air_date: '2020-01-01',
      aggregate_credits: { cast: new Array(500).fill({ name: 'x' }) },
    }),
  };
};
function stub(name, exports) {
  const file = path.join(__dirname, '..', 'src', name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('db.js', { pool: { query: async () => ({ rows: [], rowCount: 0 }) } });
stub('firebase.js', { admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token }) }) } });
const { app } = require('../src/server');

test('a show summary carries only what an import stores, with no OMDb call', async () => {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/shows/7/summary`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: 7,
      name: 'Seven',
      overview: 'A show.',
      poster_path: '/p.jpg',
      backdrop_path: '/b.jpg',
      vote_average: 7.4,
      first_air_date: '2020-01-01',
    });
    assert.ok(asked.every((url) => !url.startsWith('https://omdb.test')), 'OMDb not asked');
    assert.ok(asked.every((url) => !url.includes('append_to_response')), 'no full show');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
