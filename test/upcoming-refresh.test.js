const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Counts the provider calls a pull-to-refresh makes, with stand-ins for tmdb.js.
const forced = { show: 0, tvMaze: 0 };
let showDelayMs = 0;
const tmdbPath = path.join(__dirname, '..', 'src', 'tmdb.js');
require.cache[tmdbPath] = {
  id: tmdbPath,
  filename: tmdbPath,
  loaded: true,
  exports: {
    getImdbId: async () => null,
    getTvShowClassificationData: async (_id, { forceRefresh } = {}) => {
      if (forceRefresh) forced.show += 1;
      if (showDelayMs) await new Promise((resolve) => setTimeout(resolve, showDelayMs));
      return {
        name: 'Show',
        status: 'Returning Series',
        seasons: [{ season_number: 1, air_date: '2026-01-01' }],
        next_episode_to_air: { season_number: 1, episode_number: 2, air_date: '2099-01-01' },
      };
    },
    getTvSeason: async () => ({ episodes: [] }),
    getTvMazeShow: async (_name, { forceRefresh } = {}) => {
      if (forceRefresh) forced.tvMaze += 1;
      return null;
    },
    getTvMazeEpisodes: async () => [],
  },
};
const { getUpcomingEpisodes } = require('../src/upcoming');

const pool = {
  async query(sql) {
    return sql.includes('FROM watchlist')
      ? { rows: [{ data: { id: 1, name: 'Show' } }] }
      : { rows: [] };
  },
};
const pull = () => getUpcomingEpisodes({ uid: 'u', today: '2026-10-16', forceRefresh: true, pool });

test('pulls within five minutes of a fresh load are normal reads; overlapping pulls share one load', async () => {
  const first = await pull();
  assert.equal(first.length, 1);
  assert.deepEqual(forced, { show: 1, tvMaze: 1 });

  await pull();
  await pull();
  assert.deepEqual(forced, { show: 1, tvMaze: 1 }, 'within the window: from the fresh load');

  // Past the window, two pulls at once: one reload between them.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  showDelayMs = 50;
  try {
    const [a, b] = await Promise.all([pull(), pull()]);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.deepEqual(forced, { show: 2, tvMaze: 2 });
  } finally {
    Date.now = realNow;
    showDelayMs = 0;
  }
});
