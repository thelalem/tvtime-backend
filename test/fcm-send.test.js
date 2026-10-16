const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// FCM's answers, one list per call, each entry for the token at that position.
let answers = [];
const calls = [];
function stub(name, exports) {
  const file = path.join(__dirname, '..', 'src', name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('firebase.js', {
  admin: {
    messaging: () => ({
      sendEachForMulticast: async ({ tokens }) => {
        calls.push(tokens);
        const answer = answers.shift();
        return { responses: tokens.map((_, index) => answer[index]) };
      },
    }),
  },
});
stub('db.js', { pool: {} });
const { sendThroughFcm } = require('../src/notifications');

const ok = { success: true };
const fail = (code) => ({ success: false, error: { code, message: code } });
const message = { title: 'Show', body: 'S01 | E01', data: {}, tag: 't', silent: false };

test.beforeEach(() => { answers = []; calls.length = 0; });

test('a bad message is not taken for dead phones', async () => {
  answers = [[ok, fail('messaging/invalid-argument')], [fail('messaging/invalid-argument')]];
  const dead = await sendThroughFcm(['a', 'b'], message);
  assert.deepEqual(dead, [], 'no device deleted');
});

test('a phone that failed for a passing reason is tried once more at once', async () => {
  answers = [[ok, fail('messaging/internal-error'), fail('messaging/registration-token-not-registered')], [ok]];
  const dead = await sendThroughFcm(['a', 'b', 'c'], message);
  assert.deepEqual(calls, [['a', 'b', 'c'], ['b']]);
  assert.deepEqual(dead, ['c'], 'only the really dead token');
});

test('nothing delivered and nothing dead is still a failure for the sweep to retry', async () => {
  answers = [[fail('messaging/internal-error')], [fail('messaging/internal-error')]];
  await assert.rejects(sendThroughFcm(['a'], message));
});
