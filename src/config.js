require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 8000,
  databaseUrl: process.env.DATABASE_URL,
  tmdbAccessToken: process.env.TMDB_ACCESS_TOKEN,
  tmdbBaseUrl: process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3',
  omdbApiKey: process.env.OMDB_API_KEY,
  omdbBaseUrl: process.env.OMDB_BASE_URL || 'https://www.omdbapi.com',
  // OMDb calls allowed a day (see omdb-budget.js): 90% of the free key's 1,000. Lists may use
  // only OMDB_LIST_BUDGET of them (default 60% of the day's), keeping the rest for show pages
  // and episode ratings.
  omdbDailyBudget: Number(process.env.OMDB_DAILY_BUDGET) || 900,
  omdbListBudget: Number(process.env.OMDB_LIST_BUDGET) ||
    Math.floor((Number(process.env.OMDB_DAILY_BUDGET) || 900) * 0.6),
  tvMazeBaseUrl: process.env.TVMAZE_BASE_URL || 'https://api.tvmaze.com',
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

module.exports = { config };
