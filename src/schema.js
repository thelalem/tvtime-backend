const { pool } = require('./db');

// Runs at every start (and in every integration test file). The script is one
// transaction, so each lock it takes is held to its end. Two rules keep it from
// deadlocking with another start, or with live requests:
// - it takes an advisory lock first, so starts run their schema one at a time;
// - nothing in it takes a strong lock when there is nothing to change: an
//   ALTER TABLE takes the table's exclusive lock even with ADD COLUMN IF NOT
//   EXISTS, so each one is wrapped in a check (`addColumns` below). Do the same
//   for any new ALTER or index.
// Without them a test file's setup now and then deadlocked with another file's
// (a whole file failed), or with its writes (a mute was lost).
async function initializeDatabase() {
  await pool.query(`
    SELECT pg_advisory_xact_lock(7303101);

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

    -- classification_date: the user's local calendar date (YYYY-MM-DD) the
    -- classification was computed for. "Aired" depends on that date, so a
    -- classification from an earlier local day is stale even when it is recent.
    -- next_season/next_episode/unwatched_released_count: the first aired episode
    -- the user has not watched, and how many aired episodes that is (computed
    -- with the classification). NULL until the show has been classified once more.
    ${addColumns('show_progress', [
      ['classification', 'TEXT'],
      ['classification_checked_at', 'TIMESTAMPTZ'],
      ['released_episode_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['is_ended', 'BOOLEAN NOT NULL DEFAULT FALSE'],
      ['classification_date', 'TEXT'],
      ['next_season', 'INTEGER'],
      ['next_episode', 'INTEGER'],
      ['unwatched_released_count', 'INTEGER'],
      // Rewatches (FEATURE_PLAN.md section 14): { "S1E2": [ { at, source, pass? } ] }, see rewatch-logic.js.
      ['rewatches', "JSONB NOT NULL DEFAULT '{}'::jsonb"],
    ])}

    -- Open rewatch passes: one row per season being rewatched. episodes is the season's watched episodes
    -- when the pass began and target_level the level they are being taken to; the row is deleted when
    -- the pass finishes or is stopped (rewatch-logic.js).
    CREATE TABLE IF NOT EXISTS rewatch_passes (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      season INTEGER NOT NULL,
      target_level INTEGER NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      episodes JSONB NOT NULL,
      PRIMARY KEY (firebase_uid, series_id, season)
    );

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
    ${addColumns('app_users', [['timezone', 'TEXT']])}

    -- Movies. Separate from the show tables on purpose: a TMDB movie id and a show id are
    -- different things that can be the same number, and this leaves the show data untouched.
    -- A watched movie is always on the movie watchlist (ticking adds it), so "watched" is just a
    -- date on the row: NULL means not watched. Removing a movie deletes the row, which wipes the
    -- watched date with it.
    CREATE TABLE IF NOT EXISTS movie_watchlist (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      movie_id BIGINT NOT NULL,
      movie JSONB NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      watched_on DATE,
      PRIMARY KEY (firebase_uid, movie_id)
    );

    CREATE TABLE IF NOT EXISTS movie_favorites (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      movie_id BIGINT NOT NULL,
      movie JSONB NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, movie_id)
    );

    -- Shows the user stopped watching or removed (see show-states.js). Their progress stays in
    -- show_progress; this only takes them out of the lists. The series column is the show as last drawn.
    CREATE TABLE IF NOT EXISTS show_states (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('stopped', 'removed')),
      series JSONB NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id)
    );

    -- Sequels the user chose to hide from their Upcoming list (see sequels.js).
    CREATE TABLE IF NOT EXISTS dismissed_sequels (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      movie_id BIGINT NOT NULL,
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, movie_id)
    );

    -- New-episode push notifications (see notifications.js). One row per app install that
    -- allowed notifications; the FCM token is the key, and signing in as someone else on the
    -- same phone simply moves the row to the new user.
    CREATE TABLE IF NOT EXISTS device_tokens (
      token TEXT PRIMARY KEY,
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT 'android',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DO $$ BEGIN
      IF to_regclass('device_tokens_uid_idx') IS NULL THEN
        CREATE INDEX device_tokens_uid_idx ON device_tokens(firebase_uid);
      END IF;
    END $$;

    ${addColumns('app_users', [['notifications_enabled', 'BOOLEAN NOT NULL DEFAULT TRUE']])}

    CREATE TABLE IF NOT EXISTS muted_shows (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      PRIMARY KEY (firebase_uid, series_id)
    );
    -- The show as drawn when it was muted, so Settings can list it even after it is removed.
    ${addColumns('muted_shows', [['name', 'TEXT'], ['poster_path', 'TEXT']])}

    -- Which episode notifications went out, so a restart or a second sweep never repeats one.
    CREATE TABLE IF NOT EXISTS notifications_sent (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id, season, episode)
    );

    -- What a user records about one episode besides watching it (see episode-data.js). The rating
    -- is 1-5; later answers (feeling, favorite cast member, device) become more columns here.
    CREATE TABLE IF NOT EXISTS episode_user_data (
      firebase_uid TEXT NOT NULL REFERENCES app_users(firebase_uid) ON DELETE CASCADE,
      series_id BIGINT NOT NULL,
      season INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_uid, series_id, season, episode)
    );

    -- Slow-changing provider answers (see persistent-cache.js), so they survive
    -- a restart. Keyed by what was asked, e.g. 'omdb:season:tt0386676:3'.
    CREATE TABLE IF NOT EXISTS provider_cache (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- OMDb calls made each UTC day (see omdb-budget.js).
    CREATE TABLE IF NOT EXISTS omdb_usage (
      day DATE PRIMARY KEY,
      calls INTEGER NOT NULL
    );
  `);
}

// SQL adding [columns] ([name, type]) to [table], run only when one is missing,
// so a start with nothing to add takes no lock on the table.
function addColumns(table, columns) {
  const names = columns.map(([name]) => `'${name}'`).join(', ');
  const adds = columns
    .map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`)
    .join(', ');
  return `DO $$ BEGIN
      IF (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = '${table}'
            AND column_name IN (${names})) < ${columns.length} THEN
        ALTER TABLE ${table} ${adds};
      END IF;
    END $$;`;
}

module.exports = { initializeDatabase };
