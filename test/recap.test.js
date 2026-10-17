const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Stand-ins: the user's progress, TMDB seasons, TVmaze, the cache table and Gemini.
const state = {};
function reset() {
  Object.assign(state, {
    watched: ['S1E1', 'S1E2', 'S1E3', 'S2E1', 'S2E2', 'S0E1'],
    cache: new Map(),
    geminiCalls: [],
    geminiStatus: 200,
    budgetLeft: 100,
    finishReason: 'STOP',
    geminiHeaders: null,
    geminiErrorBody: '',
    geminiHangs: false,
    groqCalls: [],
    groqStatus: 200,
  });
}
reset();
const long = (word) => `${word} `.repeat(60).trim();
const seasons = {
  1: { season_number: 1, overview: 'Season one tells the whole first year.', episodes: [1, 2, 3].map((n) => ({ episode_number: n, name: `One ${n}`, overview: long(`s1e${n}`) })) },
  2: { season_number: 2, overview: 'SPOILER season two overview', episodes: [
    { episode_number: 1, name: 'Two 1', overview: long('s2e1') },
    { episode_number: 2, name: 'Two 2', overview: '' },
    { episode_number: 3, name: 'Two 3', overview: 'SPOILER third episode' },
  ] },
};
const stubs = {
  './db': {
    pool: {
      async query(sql, params) {
        if (/FROM show_progress/.test(sql)) return { rows: [{ watched_episodes: state.watched, show_name: 'The Show' }] };
        if (/ai_usage/.test(sql)) return { rows: state.budgetLeft-- > 0 ? [{ calls: 1 }] : [] };
        throw new Error(`unexpected ${sql}`);
      },
    },
  },
  './persistent-cache': {
    async readThrough(key, _ttl, load) {
      if (state.cache.has(key)) return state.cache.get(key);
      const value = await load();
      state.cache.set(key, value);
      return value;
    },
  },
  './tmdb': {
    getTvSeason: async (_id, n) => seasons[n],
    getTvMazeEpisodes: async () => [{ season: 2, number: 2, summary: '<p>From <b>TVmaze</b> for two-two</p>' }],
  },
  undici: {
    fetch: async (url, options) => {
      if (String(url).includes('groq.test')) {
        state.groqCalls.push({ url, body: JSON.parse(options.body), auth: options.headers.authorization });
        return {
          status: state.groqStatus,
          ok: state.groqStatus === 200,
          text: async () => 'nope',
          json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Previously, by Groq.' } }] }),
        };
      }
      state.geminiCalls.push({ url, body: JSON.parse(options.body), key: options.headers['x-goog-api-key'] });
      if (state.geminiHangs) {
        // Answers only when cut off by the request's own time limit.
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      const status = String(url).includes('lite-test') && state.liteStatus ? state.liteStatus : state.geminiStatus;
      return {
        status,
        ok: status === 200,
        headers: { get: (name) => (state.geminiHeaders || {})[name.toLowerCase()] ?? null },
        text: async () => state.geminiErrorBody || 'nope',
        json: async () => ({ candidates: [{ finishReason: state.finishReason, content: { parts: [{ text: 'thinking', thought: true }, { text: 'Previously on The Show...' }] } }] }),
      };
    },
  },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.endsWith('recap.js') && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, ...rest);
};
const { config } = require('../src/config');
const recap = require('../src/recap');

let handler;
recap.registerRecapRoutes({ get: (_path, fn) => { handler = fn; } });

async function call(query = {}, uid = 'u1', seriesId = '42') {
  let status = 200;
  let payload;
  const response = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
  await handler({ params: { seriesId }, query, user: { uid } }, response, (error) => { throw error; });
  return { status, payload };
}

test.beforeEach(() => {
  reset();
  recap._resetLimits();
  config.geminiApiKey = 'test-key';
  config.geminiModel = 'gemini-test';
  config.geminiBackupModel = 'lite-test';
  state.liteStatus = null;
  config.recapUserDailyLimit = 15;
  config.geminiDailyBudget = 200;
  config.groqApiKey = '';
  config.groqModel = 'groq-test';
  config.groqBaseUrl = 'https://groq.test/openai/v1';
  config.recapAdminUids = ['l2', 'g4', 'f4']; // the accounts the writer=... checks below use
  recap._setTotalBudget(90 * 1000);
});

test('Gemini Flash-Lite writes it when Flash is out of quota, before Groq is asked', async () => {
  config.groqApiKey = 'groq-key';
  state.geminiStatus = 429;
  state.liteStatus = 200;
  const answer = await call({ scope: 'season' }, 'l1');
  assert.equal(answer.payload.model, 'lite-test');
  assert.deepEqual(state.geminiCalls.map((c) => /lite-test/.test(c.url)), [false, true]);
  assert.equal(state.groqCalls.length, 0);

  recap._resetLimits();
  state.cache.clear();
  state.geminiStatus = 200;
  const first = await call({ scope: 'season', writer: 'lite' }, 'l2');
  assert.equal(first.payload.model, 'lite-test', 'writer=lite asks it first');
});

test('Groq writes it when Gemini is out of quota, fails or has no key; both failing gives the synopses', async () => {
  config.groqApiKey = 'groq-key';
  state.geminiStatus = 429;
  let answer = await call({ scope: 'season' }, 'g1');
  assert.equal(answer.payload.source, 'ai');
  assert.equal(answer.payload.text, 'Previously, by Groq.');
  assert.equal(state.groqCalls.length, 1);
  assert.equal(state.groqCalls[0].auth, 'Bearer groq-key');
  assert.equal(state.groqCalls[0].body.model, 'groq-test');
  assert.match(state.groqCalls[0].url, /groq\.test\/openai\/v1\/chat\/completions$/);

  state.cache.clear();
  state.geminiCalls.length = 0;
  answer = await call({ scope: 'season' }, 'g1');
  assert.equal(state.geminiCalls.length, 0, 'Gemini is paused after its 429; Groq goes straight away');
  assert.equal(answer.payload.source, 'ai');

  recap._resetLimits();
  state.cache.clear();
  state.geminiStatus = 500;
  state.groqStatus = 429;
  answer = await call({ scope: 'season' }, 'g2');
  assert.equal(answer.payload.source, 'synopses');
  assert.equal(answer.payload.reason, 'quota');

  recap._resetLimits();
  state.cache.clear();
  state.geminiStatus = 200;
  state.groqStatus = 200;
  state.geminiCalls.length = 0;
  answer = await call({ scope: 'season', writer: 'groq' }, 'g4');
  assert.equal(answer.payload.model, 'groq-test', 'writer=groq asks Groq first');
  assert.equal(state.geminiCalls.length, 0);

  recap._resetLimits();
  state.cache.clear();
  config.geminiApiKey = '';
  state.groqStatus = 200;
  answer = await call({ scope: 'season' }, 'g3');
  assert.equal(answer.payload.text, 'Previously, by Groq.', 'Groq alone is enough');
});

test('the cutoff is the latest watched episode, specials aside', () => {
  assert.deepEqual(recap.latestWatched(['S1E9', 'S2E3', 'S2E10', 'S0E40', 'x']), { season: 2, episode: 10 });
  assert.equal(recap.latestWatched(['S0E1']), null);
  assert.equal(recap.latestWatched(null), null);
});

test('material stops at the cutoff; only finished seasons give their overview; TVmaze fills gaps', () => {
  const cutoff = { season: 2, episode: 2 };
  const all = recap.collectMaterial([seasons[1], seasons[2]], cutoff, 'all', [{ season: 2, number: 2, summary: '<p>Gap &amp; fill</p>' }]);
  assert.deepEqual(all.map((s) => s.season), [1, 2]);
  assert.equal(all[0].overview, 'Season one tells the whole first year.');
  assert.equal(all[1].overview, '', 'the current season overview could spoil');
  assert.deepEqual(all[1].episodes.map((e) => e.number), [1, 2]);
  assert.equal(all[1].episodes[1].overview, 'Gap & fill');
  const season = recap.collectMaterial([seasons[1], seasons[2]], cutoff, 'season');
  assert.deepEqual(season.map((s) => s.season), [2]);
  const prompt = recap.buildPrompt('The Show', cutoff, 'all', all);
  assert.ok(!prompt.includes('SPOILER'));
  assert.match(prompt, /season 2, episode 2/);
  const lines = prompt.trim().split('\n');
  assert.match(lines[lines.length - 1], /^FINAL RULE.*up to and including season 2, episode 2 \("Two 2"\), and not a single/,
    'the cutoff is the last thing the model reads');
  assert.match(prompt, /Draw on what you know about the show/);
  assert.match(recap.buildPrompt('The Show', cutoff, 'last', all), /up to and including the last episode of season 1/);
});

test('Gemini writes it from the synopses up to the user\'s episode; the answer is cached and shared', async () => {
  const first = await call({ scope: 'all' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.payload, { season: 2, episode: 2, scope: 'all', source: 'ai', model: 'gemini-test', text: 'Previously on The Show...' });
  assert.equal(state.geminiCalls.length, 1);
  const sent = state.geminiCalls[0];
  assert.match(sent.url, /models\/gemini-test:generateContent$/);
  assert.equal(sent.key, 'test-key');
  const prompt = sent.body.contents[0].parts[0].text;
  assert.ok(!prompt.includes('SPOILER'), 'nothing past S2E2, no current-season overview');
  assert.match(prompt, /From TVmaze for two-two/);

  const again = await call({ scope: 'all' }, 'u2');
  assert.equal(again.payload.source, 'ai');
  assert.equal(state.geminiCalls.length, 1, 'another user at the same point reuses it');
  await call({ scope: 'season' });
  assert.equal(state.geminiCalls.length, 2, 'the other scope is its own recap');
});

test('without a key, over the quota or the user limit, or on an error: the synopses, not cached', async () => {
  config.geminiApiKey = '';
  let answer = await call();
  assert.equal(answer.payload.source, 'synopses');
  assert.equal(answer.payload.reason, 'no_key');
  assert.match(answer.payload.text, /^Season 2\nE1 "Two 1": s2e1/);
  assert.equal(state.cache.size, 0);

  config.geminiApiKey = 'k';
  state.geminiStatus = 429;
  assert.equal((await call()).payload.reason, 'quota');
  state.geminiStatus = 200;
  assert.equal((await call()).payload.reason, 'quota', 'Gemini is left alone for a while after a 429');
  recap._resetLimits();

  state.geminiStatus = 500;
  assert.equal((await call()).payload.reason, 'error');
  state.geminiStatus = 200;

  state.finishReason = 'MAX_TOKENS';
  assert.equal((await call()).payload.reason, 'error', 'a cut-off recap is not used');
  assert.equal(state.cache.size, 0, 'nor kept');
  state.finishReason = 'STOP';

  recap._resetLimits();
  config.recapUserDailyLimit = 1;
  state.cache.clear();
  await call({ scope: 'season' }, 'u3');
  assert.equal((await call({ scope: 'all' }, 'u3')).payload.reason, 'limit');

  recap._resetLimits();
  state.budgetLeft = 0;
  assert.equal((await call({ scope: 'all' }, 'u4')).payload.reason, 'quota');
});

test('too little to write from: the synopses, without asking Gemini', async () => {
  state.watched = ['S2E1'];
  seasons[2].episodes[0].overview = 'Short.';
  const answer = await call();
  seasons[2].episodes[0].overview = long('s2e1');
  assert.equal(answer.payload.reason, 'thin');
  assert.equal(state.geminiCalls.length, 0);
});

test('last season: the whole season before the current one, with its overview; none in season 1', async () => {
  const material = recap.collectMaterial([seasons[1], seasons[2]], { season: 2, episode: 2 }, 'last');
  assert.deepEqual(material.map((s) => s.season), [1]);
  assert.deepEqual(material[0].episodes.map((e) => e.number), [1, 2, 3]);
  assert.equal(material[0].overview, 'Season one tells the whole first year.');
  const prompt = recap.buildPrompt('The Show', { season: 2, episode: 2 }, 'last', material);
  assert.match(prompt, /detailed recap of season 1/);
  assert.match(prompt, /how that season ended/);
  assert.match(recap.buildPrompt('The Show', { season: 2, episode: 2 }, 'all', material), /Keep it brief/);

  const answer = await call({ scope: 'last' });
  assert.equal(answer.payload.scope, 'last');
  assert.ok(!state.geminiCalls[0].body.contents[0].parts[0].text.includes('s2e1'), 'nothing of season 2');
  const calls = state.geminiCalls.length;
  state.watched = ['S1E1', 'S1E2', 'S1E3', 'S2E1'];
  assert.equal((await call({ scope: 'last' }, 'other')).payload.source, 'ai');
  assert.equal(state.geminiCalls.length, calls, 'someone at S2E1 shares the season 1 recap made for S2E2');
  state.watched = ['S1E2'];
  assert.equal((await call({ scope: 'last' })).status, 404);
});

test('nothing watched is a 404; a bad id is a 400', async () => {
  state.watched = ['S0E1'];
  assert.equal((await call()).status, 404);
  assert.equal((await call({}, 'u1', 'abc')).status, 400);
});

test('a recap every writer failed on is not asked for again for a while; the synopses show meanwhile', async () => {
  state.finishReason = 'SAFETY';
  const first = await call({ scope: 'season' }, 'f1');
  assert.equal(first.payload.source, 'synopses');
  const calls = state.geminiCalls.length;
  assert.ok(calls >= 1);

  const again = await call({ scope: 'season' }, 'f2');
  assert.equal(again.payload.source, 'synopses');
  assert.equal(state.geminiCalls.length, calls, 'no new paid call for the same recap');

  // Another point of the show is its own recap and is still asked for.
  state.watched = [...state.watched, 'S2E3'];
  await call({ scope: 'season' }, 'f3');
  assert.ok(state.geminiCalls.length > calls);

  // A writer=... check still asks.
  state.watched = state.watched.filter((key) => key !== 'S2E3');
  const before = state.geminiCalls.length;
  await call({ scope: 'season', writer: 'gemini' }, 'f4');
  assert.ok(state.geminiCalls.length > before);
});

test('running out of quota is not remembered as a failure', async () => {
  state.geminiStatus = 429;
  state.liteStatus = 429;
  assert.equal((await call({ scope: 'season' }, 'q1')).payload.source, 'synopses');
  assert.equal(recap._failedRecaps(), 0, 'the writers are paused instead, and asked again when the pause ends');
  state.finishReason = 'MAX_TOKENS';
  state.geminiStatus = 200;
  state.liteStatus = null;
  recap._resetLimits();
  await call({ scope: 'season' }, 'q2');
  assert.equal(recap._failedRecaps(), 1, 'a cut-off answer is');
});

test('a per-minute 429 pauses a writer for the wait it asks for (at least a minute); a daily one for half an hour', async () => {
  state.geminiStatus = 429;
  state.liteStatus = 200;
  state.geminiHeaders = { 'retry-after': '20' };
  await call({ scope: 'season' }, 'r1');
  const minute = recap._pausedFor('gemini');
  assert.ok(minute > 50 * 1000 && minute <= 60 * 1000, `about a minute, was ${minute}`);

  recap._resetLimits();
  state.cache.clear();
  state.geminiHeaders = null;
  state.geminiErrorBody = '{"error":{"details":[{"retryDelay":"300s"}]}}';
  await call({ scope: 'season' }, 'r2');
  const fiveMinutes = recap._pausedFor('gemini');
  assert.ok(fiveMinutes > 290 * 1000 && fiveMinutes <= 300 * 1000, `Gemini's RetryInfo, was ${fiveMinutes}`);

  recap._resetLimits();
  state.cache.clear();
  state.geminiErrorBody = '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}],"retryDelay":"30s"}}';
  await call({ scope: 'season' }, 'r3');
  assert.ok(recap._pausedFor('gemini') > 29 * 60 * 1000, 'the daily quota: half an hour');
});

test('the writer switch is only for the accounts in RECAP_ADMIN_UIDS', async () => {
  config.groqApiKey = 'groq-key';
  const answer = await call({ scope: 'season', writer: 'groq' }, 'not-an-admin');
  assert.equal(answer.payload.model, 'gemini-test', 'Gemini first, as for everyone');
  assert.equal(state.groqCalls.length, 0);
  assert.equal(answer.payload.writerNotes, undefined);
});

test('all the writers share one time limit counted from the request, so an answer comes in time', async () => {
  recap._setTotalBudget(5200);
  state.geminiHangs = true;
  // AbortSignal.timeout's timer does not keep Node running on its own (a live server always has something open).
  const keepAlive = setInterval(() => {}, 1000);
  const started = Date.now();
  const answer = await call({ scope: 'season' }, 't1').finally(() => clearInterval(keepAlive));
  const took = Date.now() - started;
  assert.equal(answer.payload.source, 'synopses');
  assert.ok(took < 6000, `answered within the limit, took ${took} ms`);
  assert.equal(state.geminiCalls.length, 1, 'no time left for the backup after Flash used it all');
});

test("someone who joined a request refused for the first person's limit gets their own try", async () => {
  config.recapUserDailyLimit = 1;
  await call({ scope: 'season' }, 'busy', '43'); // their one recap of the day, another show
  const [busy, other] = await Promise.all([call({ scope: 'season' }, 'busy'), call({ scope: 'season' }, 'other')]);
  assert.equal(busy.payload.source, 'synopses');
  assert.equal(busy.payload.reason, 'limit');
  assert.equal(other.payload.source, 'ai');
});

test('"all" tapers: the current and previous season in full, earlier ones by their overview', () => {
  const season = (n, overview) => ({
    season_number: n,
    overview,
    episodes: [1, 2].map((e) => ({ episode_number: e, name: `${n}.${e}`, overview: `Season ${n} episode ${e} happens here. More detail follows that is long.` })),
  });
  const material = recap.collectMaterial(
    [season(1, 'First season overview.'), season(2, ''), season(3, 'Third.'), season(4, 'SPOILER current')],
    { season: 4, episode: 1 },
    'all',
  );
  const bySeason = Object.fromEntries(material.map((m) => [m.season, m]));
  assert.deepEqual(bySeason[1].episodes, [], 'an early season with an overview: the overview only');
  assert.equal(bySeason[1].overview, 'First season overview.');
  assert.deepEqual(bySeason[2].episodes.map((e) => e.overview), ['Season 2 episode 1 happens here.', 'Season 2 episode 2 happens here.'],
    'no overview: the first sentence of each episode');
  assert.equal(bySeason[3].episodes.length, 2, 'the previous season in full');
  assert.ok(bySeason[3].episodes[0].overview.includes('More detail'));
  assert.deepEqual(bySeason[4].episodes.map((e) => e.number), [1], "the current one up to the user's episode");
  assert.equal(bySeason[4].overview, '', "never the current season's overview");
});
