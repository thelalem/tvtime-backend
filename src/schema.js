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
      classification TEXT,
      classification_checked_at TIMESTAMPTZ,
      released_episode_count INTEGER NOT NULL DEFAULT 0,
      is_ended BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id)
    );

    ALTER TABLE show_progress
      ADD COLUMN IF NOT EXISTS classification TEXT,
      ADD COLUMN IF NOT EXISTS classification_checked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS released_episode_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_ended BOOLEAN NOT NULL DEFAULT FALSE,
      -- The user's local calendar date (YYYY-MM-DD) the classification was
      -- computed for. "Aired" depends on that date, so a classification from an
      -- earlier local day is stale even when it is recent.
      ADD COLUMN IF NOT EXISTS classification_date TEXT;

    -- When an episode was last unmarked. Kept apart from show_progress on
    -- purpose: a row here is invisible to the watchlist, All Shows and the
    -- tracked-show state, so remembering an unwatch cannot make an unwatched
    -- show look started. It exists so an older import cannot undo a newer
    -- unwatch (see episode-merge.js).
    CREATE TABLE IF NOT EXISTS unwatched_episodes (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      episode_key TEXT NOT NULL,
      unwatched_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (firebase_uid, series_id, episode_key)
    );

    -- IANA name reported by the user's device, e.g. Africa/Addis_Ababa. NULL
    -- until an app version that reports it connects; treated as UTC meanwhile.
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS timezone TEXT;

    -- Slow-changing provider answers (see persistent-cache.js), so they survive
    -- a restart. Keyed by what was asked, e.g. 'omdb:season:tt0386676:3'.
    CREATE TABLE IF NOT EXISTS provider_cache (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

module.exports = { initializeDatabase };
