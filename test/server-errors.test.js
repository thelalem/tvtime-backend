const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The app from server.js with stand-ins for the database and Firebase. The
// progress query fails the way a Postgres error does, message and all.
function stub(name, exports) {
  const file = path.join(__dirname, '..', 'src', name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('db.js', {
  pool: {
    async query(sql) {
      if (sql.includes('FROM show_progress WHERE firebase_uid=$1 ORDER BY')) {
        throw new Error('value "99999999999" is out of range for type integer (SELECT current_season ...)');
      }
      return { rows: [], rowCount: 0 };
    },
  },
});
stub('firebase.js', {
  admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: token }) }) },
});
const { app } = require('../src/server');

let server;
let base;
test.before(async () => {
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

const get = (route) => fetch(`${base}${route}`, { headers: { authorization: 'Bearer user-1' } });

test('an unexpected error is a plain 500: its message (SQL) stays in the log', async () => {
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    const response = await get('/me/progress');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { detail: 'Internal server error' });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => line.includes('out of range')), 'logged');
});

test('/ME/ is not /me/: no route, and nothing reaches a handler without a user', async () => {
  const response = await get('/ME/progress');
  assert.equal(response.status, 404);
});

test('discover refuses an unknown sort order or junk genres', async () => {
  assert.equal((await fetch(`${base}/shows/discover?sort_by=drop_table`)).status, 400);
  assert.equal((await fetch(`${base}/shows/discover?with_genres=18;DROP`)).status, 400);
});
