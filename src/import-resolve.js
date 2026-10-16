const { findTmdbId } = require('./tmdb');

// Import from TV Time (FEATURE_PLAN.md section 16). TV Time's export carries TVDB ids (shows) and IMDb ids
// (movies); the app works in TMDB ids. This route turns the first into the second, through TMDB's /find,
// with every answer cached in PostgreSQL (see findTmdbId), so a rerun costs no TMDB calls.
//
//   POST /me/import/resolve  { tvdb: [81189, ...], imdb: ["tt0163025", ...] }
//   -> { tvdb: { "81189": 1396, "5": null }, imdb: { "tt0163025": 331 }, failed: ["tvdb:77"] }
//
// `null` means TMDB does not know the id (final for now). An id the lookup failed on (TMDB down) is left
// out of the maps and named in `failed`, so the app asks again for just those.
const MAX_IDS = 200;
const CONCURRENCY = 5;
const IMDB_ID = /^tt\d{1,10}$/;

function cleanIds(value, valid) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS) return null;
  const ids = [];
  for (const item of value) {
    const id = typeof item === 'number' ? String(item) : item;
    if (typeof id !== 'string' || !valid(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function resolveAll(jobs) {
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        job.result = await findTmdbId(job.kind, job.id);
      } catch (error) {
        job.failed = true;
      }
    }
  });
  await Promise.all(workers);
}

function registerImportResolveRoute(router) {
  router.post('/me/import/resolve', async (request, response, next) => {
    try {
      const body = request.body || {};
      const tvdb = cleanIds(body.tvdb, (id) => /^\d{1,10}$/.test(id) && Number(id) > 0);
      const imdb = cleanIds(body.imdb, (id) => IMDB_ID.test(id));
      if (!tvdb || !imdb) return response.status(400).json({ error: 'invalid_ids' });

      const jobs = [
        ...tvdb.map((id) => ({ kind: 'tv', id, group: 'tvdb' })),
        ...imdb.map((id) => ({ kind: 'movie', id, group: 'imdb' })),
      ];
      await resolveAll(jobs);

      const answer = { tvdb: {}, imdb: {}, failed: [] };
      for (const job of jobs) {
        if (job.failed) answer.failed.push(`${job.group}:${job.id}`);
        else answer[job.group][job.id] = job.result;
      }
      return response.json(answer);
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerImportResolveRoute, MAX_IDS };
