const { pool } = require('./db');

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      firebase_uid TEXT PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      display_name TEXT,
      photo_url TEXT,
      avatar BYTEA,
      avatar_content_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      series JSONB NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      series JSONB NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id)
    );

    CREATE TABLE IF NOT EXISTS show_progress (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      current_season INTEGER NOT NULL DEFAULT 1,
      current_episode INTEGER NOT NULL DEFAULT 1,
      watched_episodes JSONB NOT NULL DEFAULT '[]'::jsonb,
      watched_episode_dates JSONB NOT NULL DEFAULT '{}'::jsonb,
      watched_count INTEGER NOT NULL DEFAULT 0,
      total_episodes INTEGER NOT NULL DEFAULT 0,
      last_watched TIMESTAMPTZ,
      show_name TEXT,
      poster_path TEXT,
      backdrop_path TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id)
    );
  `);
}

module.exports = { initializeDatabase };
