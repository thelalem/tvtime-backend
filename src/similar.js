const {
  getDiscovery,
  getMovie,
  getMovieRecommendations,
  getMovieSimilar,
  getTvRecommendations,
  getTvShowClassificationData,
  getTvSimilar,
} = require('./tmdb');

const MAX_RESULTS = 12;
// A thin result (an obscure title) is topped up from discover.
const MIN_BEFORE_TOP_UP = 8;
const MIN_VOTE_COUNT = 30;

// What differs between a show and a movie: where its own record, its recommendations and its
// similar list come from, and which discover feed tops a thin result up.
const SOURCES = {
  tv: {
    record: getTvShowClassificationData,
    recommendations: getTvRecommendations,
    similar: getTvSimilar,
    discover: 'discover',
  },
  movie: {
    record: getMovie,
    recommendations: getMovieRecommendations,
    similar: getMovieSimilar,
    discover: 'movie_discover',
  },
};

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Titles a viewer of this one is likely to want next. TMDB's recommendations (what viewers of
// this title go on to watch) lead, its "similar" list follows, and both are re-ranked by genre
// overlap with this title and by rating. A candidate must share at least one genre, so a popular
// title that merely overlaps by accident cannot appear. `kind` is 'tv' (the default) or 'movie'.
async function getSimilarShows(showId, kind = 'tv') {
  const source = SOURCES[kind];
  const id = Number(showId);
  const [show, recommended, similar] = await Promise.all([
    source.record(id),
    source.recommendations(id).catch(() => ({ results: [] })),
    source.similar(id).catch(() => ({ results: [] })),
  ]);
  const genreIds = (show.genres || []).map((genre) => genre.id);
  const genres = new Set(genreIds);

  const candidates = new Map();
  const add = (list, sourceBonus) => {
    (list.results || []).forEach((candidate, index) => {
      if (candidate.id === id || candidates.has(candidate.id)) return;
      if ((candidate.vote_count || 0) < MIN_VOTE_COUNT) return;
      const own = new Set(candidate.genre_ids || []);
      const overlap = jaccard(genres, own);
      if (overlap === 0) return;
      // A small decay keeps TMDB's own ordering as the tie-break within a list.
      const score = sourceBonus - index * 0.01 + 2 * overlap
        + ((candidate.vote_average || 0) / 10);
      candidates.set(candidate.id, { candidate, score });
    });
  };
  add(recommended, 1);
  add(similar, 0);

  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate);

  if (ranked.length < MIN_BEFORE_TOP_UP && genreIds.length) {
    try {
      // Comma means AND in TMDB: every genre of this title, not any one of them.
      const discovered = await getDiscovery(source.discover, {
        with_genres: genreIds.join(','),
        sort_by: 'popularity.desc',
        page: 1,
      });
      const taken = new Set(ranked.map((candidate) => candidate.id));
      for (const candidate of discovered.results || []) {
        if (candidate.id === id || taken.has(candidate.id)) continue;
        if ((candidate.vote_count || 0) < MIN_VOTE_COUNT) continue;
        taken.add(candidate.id);
        ranked.push(candidate);
      }
    } catch (_error) {
      // The ranked part is still a useful answer on its own.
    }
  }

  return { results: ranked.slice(0, MAX_RESULTS) };
}

module.exports = { getSimilarShows };
