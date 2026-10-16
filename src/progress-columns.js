// The columns a progress row is sent with, shared by every route that answers with one (the progress
// list, the watchlist view, the episode-marking and import routes, and the rewatch routes).
//
// The last three are the rewatch data (FEATURE_PLAN.md section 14): the rewatches per episode, how many
// there are in all, and the passes open for the show. They read the row's own columns by the table's
// full name, so the SELECT or RETURNING they sit in must be on `show_progress` itself, unaliased.
const PROGRESS_COLUMNS = `series_id AS "seriesId",current_season AS "currentSeason",
  current_episode AS "currentEpisode",watched_episodes AS "watchedEpisodes",
  watched_episode_dates AS "watchedEpisodeDates",watched_count AS "watchedCount",
  total_episodes AS "totalEpisodes",last_watched AS "lastWatched",
  show_name AS "showName",poster_path AS "posterPath",backdrop_path AS "backdropPath",
  classification,classification_checked_at AS "classificationCheckedAt",
  released_episode_count AS "releasedEpisodeCount",is_ended AS "isEnded",
  next_season AS "nextSeason",next_episode AS "nextEpisode",
  unwatched_released_count AS "unwatchedCount",
  rewatches,
  (SELECT COALESCE(SUM(jsonb_array_length(entry.value)), 0)::int
     FROM jsonb_each(show_progress.rewatches) AS entry) AS "rewatchCount",
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'season', rp.season, 'target', rp.target_level,
            'startedAt', (EXTRACT(EPOCH FROM rp.started_at) * 1000)::bigint,
            'episodes', rp.episodes) ORDER BY rp.season), '[]'::jsonb)
     FROM rewatch_passes rp
     WHERE rp.firebase_uid = show_progress.firebase_uid
       AND rp.series_id = show_progress.series_id) AS "rewatchPasses"`;

module.exports = { PROGRESS_COLUMNS };
