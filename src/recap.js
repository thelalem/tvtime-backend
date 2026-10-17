// "Where you left off" recaps (FEATURE_PLAN.md section 15).
//
//   GET /me/shows/:seriesId/recap?scope=season|last|all
//   season: this season up to the user's episode, in detail; last: the whole season before it, in detail;
//   all: the story from the start, kept short (decided with the user).
//   -> { source: "ai" | "synopses", text, season, episode, scope, reason? }
//
// The cutoff is the latest episode the user has watched (read from their progress here, never taken from the
// request, so a recap can only cover what they have seen). The material is TMDB's episode synopses up to that
// episode (TVmaze's where TMDB has none) and, for "all", the overviews of the seasons before it; never the
// show's own overview or the current season's, which describe what is still ahead.
//
// Gemini writes the recap from that material. A recap depends only on (show, scope, episode), so it is kept in
// `provider_cache` and shared by everyone at that point. Without a key, over the daily budget, over the user's
// own limit, on an error, or when the synopses are too thin to write from, Groq is asked instead (when it has a
// key), and when that fails too the answer is the synopses themselves
// (`source: "synopses"`, with `reason`), which is not cached.
const { fetch } = require('undici');
const { pool } = require('./db');
const { config } = require('./config');
const { readThrough } = require('./persistent-cache');
const { getTvMazeEpisodes, getTvSeason } = require('./tmdb');

const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
// A long show's whole story took over 30 s with a thinking Flash model; Cloudflare in front gives up at 100 s,
// so with Groq behind it Gemini gets 60 s and Groq (fast) the rest.
const GEMINI_TIMEOUT_MS = 90 * 1000;
const GEMINI_TIMEOUT_WITH_BACKUP_MS = 60 * 1000;
const GROQ_TIMEOUT_MS = 30 * 1000;
// After Gemini reports its quota spent, it is left alone for this long.
const QUOTA_PAUSE_MS = 30 * 60 * 1000;
// Less material than this is not worth a model call (it would have to invent).
const MIN_MATERIAL_CHARS = 280;
const EPISODE_KEY = /^S(\d{1,4})E(\d{1,5})$/;

class Fallback extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// The latest watched episode, by season then number; specials (season 0) do not count.
function latestWatched(keys) {
  let best = null;
  for (const key of Array.isArray(keys) ? keys : []) {
    const match = EPISODE_KEY.exec(String(key));
    if (!match) continue;
    const season = Number(match[1]);
    const episode = Number(match[2]);
    if (season < 1) continue;
    if (!best || season > best.season || (season === best.season && episode > best.episode)) {
      best = { season, episode };
    }
  }
  return best;
}

function plain(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// What the recap may be written from: [{ season, overview, episodes: [{ number, name, overview }] }], seasons in
// order, cut at the user's episode. `seasons` are TMDB season answers; `tvMaze` TVmaze's episodes (any order).
// The seasons a scope covers: [first, last].
function seasonRange(cutoff, scope) {
  if (scope === 'all') return [1, cutoff.season];
  if (scope === 'last') return [cutoff.season - 1, cutoff.season - 1];
  return [cutoff.season, cutoff.season];
}

function collectMaterial(seasons, cutoff, scope, tvMaze = []) {
  const fromTvMaze = new Map();
  for (const episode of tvMaze || []) {
    const text = plain(episode && episode.summary);
    if (text) fromTvMaze.set(`${episode.season}:${episode.number}`, text);
  }
  const [first, last] = seasonRange(cutoff, scope);
  const material = [];
  for (const season of seasons || []) {
    const number = season && season.season_number;
    if (!Number.isInteger(number) || number < first || number > last) continue;
    const episodes = (season.episodes || [])
      .filter((episode) => number < cutoff.season || episode.episode_number <= cutoff.episode)
      .sort((a, b) => a.episode_number - b.episode_number)
      .map((episode) => ({
        number: episode.episode_number,
        name: plain(episode.name),
        overview: plain(episode.overview) || fromTvMaze.get(`${number}:${episode.episode_number}`) || '',
      }));
    material.push({
      season: number,
      // A season's overview tells its whole story: only for a season the user has finished.
      overview: number < cutoff.season ? plain(season.overview) : '',
      episodes,
    });
  }
  return material.sort((a, b) => a.season - b.season);
}

function materialChars(material) {
  return material.reduce((sum, season) =>
    sum + season.overview.length + season.episodes.reduce((a, e) => a + e.overview.length, 0), 0);
}

function materialText(material) {
  return material.map((season) => [
    `Season ${season.season}${season.overview ? ` (overview): ${season.overview}` : ''}`,
    ...season.episodes.map((e) => `S${season.season}E${e.number} "${e.name}": ${e.overview || '(no description)'}`),
  ].join('\n')).join('\n\n');
}

// The model writes from what it knows of the show (decided with the user: TMDB's synopses are pre-air teasers
// that never say how an episode turned out, so recaps from them alone were thin). The synopses keep the order
// and the episode boundaries straight. The cutoff is the last thing in the prompt, so it is what the model
// reads last; "if you do not know the show, stick to the descriptions" guards against invented recaps.
function buildPrompt(showName, cutoff, scope, material) {
  const detail = 'Follow the main storylines in order, name the characters involved and the turning points, so ' +
    'the viewer can pick up straight away.';
  const shape = scope === 'all'
    ? `Keep it brief, as it covers a lot: one or two sentences per season for the big picture, then three or ` +
      `four sentences on season ${cutoff.season} up to episode ${cutoff.episode}.`
    : scope === 'last'
      ? `Write a detailed recap of season ${cutoff.season - 1}, the season before the one they are in, in about ` +
        `250 to 400 words. ${detail} End with how that season ended.`
      : `Write a detailed recap of season ${cutoff.season} up to episode ${cutoff.episode}, in about 250 to 400 ` +
        `words. ${detail} End with where episode ${cutoff.episode} left off, so they know where they are.`;
  const lastSeason = scope === 'last' ? cutoff.season - 1 : null;
  const lastEpisode = lastSeason === null
    ? material.find((season) => season.season === cutoff.season)?.episodes.find((e) => e.number === cutoff.episode)
    : null;
  const stop = lastSeason !== null
    ? `the last episode of season ${lastSeason}`
    : `season ${cutoff.season}, episode ${cutoff.episode}${lastEpisode && lastEpisode.name ? ` ("${lastEpisode.name}")` : ''}`;
  return [
    `Write a "previously on" recap of the TV show "${showName}" for a viewer who has watched up to ` +
      `season ${cutoff.season}, episode ${cutoff.episode} and is coming back after a break.`,
    shape,
    'Draw on what you know about the show itself: what actually happened in each episode, who did what, and ' +
      'how the storylines turned out. The episode descriptions below are short pre-air teasers; use them to keep ' +
      'the order and the episode boundaries right, not as the limit of what you can say.',
    'If you do not know this show well, stick to the descriptions and keep it short rather than inventing anything.',
    'Write in English, in plain text: short paragraphs, no headings, no lists, no markdown.',
    '',
    'Episode descriptions:',
    materialText(material),
    '',
    `FINAL RULE, the most important one: include everything up to and including ${stop}, and not a single ` +
      'thing after it. Do not mention, hint at or foreshadow anything that happens later: no later twists, ' +
      'reveals, deaths, character fates, relationships or seasons, even if you know them.',
  ].join('\n');
}

// The no-AI recap: the synopses themselves, in order.
function stitchSynopses(material) {
  return material.map((season) => {
    const lines = season.episodes
      .filter((e) => e.overview)
      .map((e) => `E${e.number} ${e.name ? `"${e.name}": ` : ''}${e.overview}`);
    const body = season.overview && lines.length > 6 ? [season.overview] : lines;
    return [`Season ${season.season}`, ...(body.length ? body : ['No episode descriptions.'])].join('\n');
  }).join('\n\n');
}

// --- limits -------------------------------------------------------------------------------------

// Per provider: after one reports its quota spent, it is left alone for QUOTA_PAUSE_MS.
const pausedUntil = { gemini: 0, groq: 0 };
const userCalls = new Map();

function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Takes one model call from the user's own daily allowance (kept in memory: a redeploy forgiving a few
// calls is fine, the daily budget below is the real cap).
function takeUserCall(uid, limit) {
  const day = utcDay();
  const entry = userCalls.get(uid);
  if (!entry || entry.day !== day) {
    userCalls.set(uid, { day, count: 1 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

// Takes one call from today's Gemini budget, counted in PostgreSQL like OMDb's (omdb-budget.js).
async function takeBudgetCall(limit) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_usage(day, calls) VALUES ($1, 1)
       ON CONFLICT (day) DO UPDATE SET calls = ai_usage.calls + 1
       WHERE ai_usage.calls < $2
       RETURNING calls`,
      [utcDay(), limit],
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[recap] could not count a call: ${error.message}`);
    return true;
  }
}

async function askGemini(prompt, timeoutMs) {
  const base = config.geminiBaseUrl.replace(/\/$/, '');
  const url = `${base}/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      // Newer Flash models think before answering, and the thinking counts against this limit: at 2,048 the
      // first recaps were cut off mid-sentence.
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) {
    pausedUntil.gemini = Date.now() + QUOTA_PAUSE_MS;
    throw new Fallback('quota');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[recap] Gemini answered ${response.status}: ${detail.slice(0, 300)}`);
    throw new Fallback('error');
  }
  const data = await response.json();
  const candidate = (data.candidates || [])[0] || {};
  const parts = (candidate.content || {}).parts || [];
  const text = parts.filter((part) => !part.thought).map((part) => part.text || '').join('').trim();
  // A recap that ran out of room (or was stopped for any other reason) must not be kept for months.
  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    console.error(`[recap] Gemini stopped with ${candidate.finishReason}`);
    throw new Fallback('error');
  }
  if (!text) throw new Fallback('error');
  return text;
}

// Groq's OpenAI-style chat API: the backup writer.
async function askGroq(prompt) {
  const response = await fetch(`${config.groqBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.groqApiKey}` },
    body: JSON.stringify({
      model: config.groqModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
  });
  if (response.status === 429) {
    pausedUntil.groq = Date.now() + QUOTA_PAUSE_MS;
    throw new Fallback('quota');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(`[recap] Groq answered ${response.status}: ${detail.slice(0, 300)}`);
    throw new Fallback('error');
  }
  const data = await response.json();
  const choice = (data.choices || [])[0] || {};
  const text = String((choice.message || {}).content || '').trim();
  if (choice.finish_reason && choice.finish_reason !== 'stop') {
    console.error(`[recap] Groq stopped with ${choice.finish_reason}`);
    throw new Fallback('error');
  }
  if (!text) throw new Fallback('error');
  return text;
}

// Gemini, then Groq. Throws a Fallback with the reason when neither wrote it ('quota' when one was out of
// quota, else 'error').
async function writeRecap(prompt) {
  const reasons = [];
  const now = Date.now();
  const groqReady = Boolean(config.groqApiKey) && now >= pausedUntil.groq;
  if (config.geminiApiKey && now >= pausedUntil.gemini) {
    try {
      const timeout = groqReady ? GEMINI_TIMEOUT_WITH_BACKUP_MS : GEMINI_TIMEOUT_MS;
      return { text: await askGemini(prompt, timeout), model: config.geminiModel };
    } catch (error) {
      if (!(error instanceof Fallback)) console.error(`[recap] Gemini failed: ${error.message}`);
      reasons.push(error instanceof Fallback ? error.reason : 'error');
    }
  } else if (config.geminiApiKey) {
    reasons.push('quota');
  }
  if (groqReady) {
    try {
      return { text: await askGroq(prompt), model: config.groqModel };
    } catch (error) {
      if (!(error instanceof Fallback)) console.error(`[recap] Groq failed: ${error.message}`);
      reasons.push(error instanceof Fallback ? error.reason : 'error');
    }
  } else if (config.groqApiKey) {
    reasons.push('quota');
  }
  throw new Fallback(reasons.includes('quota') ? 'quota' : 'error');
}

// --- the route ----------------------------------------------------------------------------------

const inFlight = new Map();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 && String(id) === String(value) ? id : null;
}

async function loadMaterial(seriesId, showName, cutoff, scope) {
  const numbers = [];
  const [first, last] = seasonRange(cutoff, scope);
  for (let n = first; n <= last; n += 1) numbers.push(n);
  const seasons = (await Promise.all(numbers.map((n) => getTvSeason(seriesId, n).catch(() => null))))
    .filter(Boolean);
  let material = collectMaterial(seasons, cutoff, scope);
  const missing = material.some((season) => season.episodes.some((e) => !e.overview));
  if (missing && showName) {
    const tvMaze = await getTvMazeEpisodes(showName).catch(() => []);
    material = collectMaterial(seasons, cutoff, scope, tvMaze);
  }
  return material;
}

function registerRecapRoutes(router) {
  router.get('/me/shows/:seriesId/recap', async (request, response, next) => {
    const seriesId = parseId(request.params.seriesId);
    if (!seriesId) return response.status(400).json({ error: 'invalid_series_id' });
    const scope = ['all', 'last'].includes(request.query.scope) ? request.query.scope : 'season';
    try {
      const { rows } = await pool.query(
        'SELECT watched_episodes, show_name FROM show_progress WHERE firebase_uid=$1 AND series_id=$2',
        [request.user.uid, seriesId],
      );
      const cutoff = rows.length ? latestWatched(rows[0].watched_episodes) : null;
      if (!cutoff) return response.status(404).json({ error: 'nothing_watched' });
      if (scope === 'last' && cutoff.season < 2) return response.status(404).json({ error: 'no_last_season' });
      const showName = rows[0].show_name || 'this show';

      // v4: v1 could be cut off mid-sentence (see askGemini); v2 had shorter season recaps; v3 used only the synopses.
      const key = `recap:v4:${seriesId}:${scope}:S${cutoff.season}E${cutoff.episode}`;
      let material = null;
      const answer = { season: cutoff.season, episode: cutoff.episode, scope };
      try {
        // Two people (or two taps) asking for the same recap share one model call.
        let pending = inFlight.get(key);
        if (!pending) {
          pending = readThrough(key, CACHE_TTL_MS, async () => {
            material = await loadMaterial(seriesId, showName, cutoff, scope);
            if (materialChars(material) < MIN_MATERIAL_CHARS) throw new Fallback('thin');
            if (!config.geminiApiKey && !config.groqApiKey) throw new Fallback('no_key');
            if (!takeUserCall(request.user.uid, config.recapUserDailyLimit)) throw new Fallback('limit');
            if (!(await takeBudgetCall(config.geminiDailyBudget))) throw new Fallback('quota');
            return writeRecap(buildPrompt(showName, cutoff, scope, material));
          });
          inFlight.set(key, pending);
          pending.finally(() => inFlight.delete(key)).catch(() => {});
        }
        const cached = await pending;
        return response.json({ ...answer, source: 'ai', text: cached.text });
      } catch (error) {
        const reason = error instanceof Fallback ? error.reason : 'error';
        if (!(error instanceof Fallback)) console.error(`[recap] ${seriesId}: ${error.message}`);
        material = material || await loadMaterial(seriesId, showName, cutoff, scope);
        return response.json({ ...answer, source: 'synopses', reason, text: stitchSynopses(material) });
      }
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = {
  registerRecapRoutes, latestWatched, collectMaterial, buildPrompt, stitchSynopses, materialChars,
  _resetLimits: () => { pausedUntil.gemini = 0; pausedUntil.groq = 0; userCalls.clear(); },
};
