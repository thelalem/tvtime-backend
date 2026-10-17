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
  // Recaps (recap.js, FEATURE_PLAN.md section 15). Gemini's free limits move and Google no longer publishes a
  // fixed table: GEMINI_MODEL picks the model, GEMINI_DAILY_BUDGET caps model calls a UTC day for everyone,
  // RECAP_USER_DAILY_LIMIT per person (one count per recap, whichever writer). A cached recap costs nothing.
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
  geminiDailyBudget: Number(process.env.GEMINI_DAILY_BUDGET) || 200,
  recapUserDailyLimit: Number(process.env.RECAP_USER_DAILY_LIMIT) || 15,
  // The backup writer when Gemini is out of quota, fails or is too slow (optional).
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  tvMazeBaseUrl: process.env.TVMAZE_BASE_URL || 'https://api.tvmaze.com',
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

module.exports = { config };
