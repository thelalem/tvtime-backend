require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 8000,
  databaseUrl: process.env.DATABASE_URL,
  tmdbAccessToken: process.env.TMDB_ACCESS_TOKEN,
  tmdbBaseUrl: process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3',
  omdbApiKey: process.env.OMDB_API_KEY,
  omdbBaseUrl: process.env.OMDB_BASE_URL || 'https://www.omdbapi.com',
  tvMazeBaseUrl: process.env.TVMAZE_BASE_URL || 'https://api.tvmaze.com',
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

module.exports = { config };
