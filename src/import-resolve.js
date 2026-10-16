const { findEpisodeByTvdbId, findMovieByTitle, findTmdbId } = require('./tmdb');

// Import from TV Time (FEATURE_PLAN.md section 16). TV Time's export carries TVDB ids (shows) and IMDb ids
// (movies); the app works in TMDB ids. This route turns the first into the second, through TMDB's /find,
// with every answer cached in PostgreSQL (see findTmdbId), so a rerun costs no TMDB calls.
//
//   POST /me/import/resolve  { tvdb: [81189, ...], imdb: ["tt0163025", ...],
//                              search: [{ key: "tt32641187", title: "My Oxford Year", year: 2025 }],
//                              episodes: [10736237, ...] }
//   -> { tvdb: { "81189": 1396, "5": null }, imdb: { "tt0163025": 331 }, search: { "tt32641187": 1307078 },
//        episodes: { "10736237": { show: 281666, season: 1, episode: 1 }, "7": null }, failed: ["tvdb:77"] }
// `episodes` are TVDB episode ids, answered with where TMDB has the episode (its show, season and number),
// which is exact even when the numbering differs. `search` is for movies whose IMDb id TMDB does not know: matched by exact title and release year.
//
// `null` means TMDB does not know the id (final for now). An id the lookup failed on (TMDB down) is left
// out of the maps and named in `failed`, so the app asks again for just those.
const MAX_IDS = 200;
const MAX_SEARCH = 50;
const MAX_EPISODES = 200;
const CONCURRENCY = 5;
const IMDB_ID = /^tt\d{1,10}$/;

function cleanIds(value, valid, max = MAX_IDS) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const ids = [];
  for (const item of value) {
    const id = typeof item === 'number' ? String(item) : item;
    if (typeof id !== 'string' || !valid(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function cleanSearch(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SEARCH) return null;
  const items = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.key !== 'string' || !item.key || item.key.length > 40 ||
        typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 ||
        !Number.isInteger(item.year) || item.year < 1880 || item.year > 2100) return null;
    items.push({ key: item.key, title: item.title, year: item.year });
  }
  return items;
}

async function resolveAll(jobs) {
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        job.result = job.search
          ? await findMovieByTitle(job.search.title, job.search.year)
          : job.kind === 'episode'
            ? await findEpisodeByTvdbId(job.id)
            : await findTmdbId(job.kind, job.id);
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
      const search = cleanSearch(body.search);
      const episodes = cleanIds(body.episodes, (id) => /^\d{1,10}$/.test(id) && Number(id) > 0, MAX_EPISODES);
      if (!tvdb || !imdb || !search || !episodes) return response.status(400).json({ error: 'invalid_ids' });

      const jobs = [
        ...tvdb.map((id) => ({ kind: 'tv', id, group: 'tvdb' })),
        ...imdb.map((id) => ({ kind: 'movie', id, group: 'imdb' })),
        ...episodes.map((id) => ({ kind: 'episode', id, group: 'episodes' })),
        ...search.map((item) => ({ kind: 'movie', id: item.key, group: 'search', search: item })),
      ];
      await resolveAll(jobs);

      const answer = { tvdb: {}, imdb: {}, search: {}, episodes: {}, failed: [] };
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
