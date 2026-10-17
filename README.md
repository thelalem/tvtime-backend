# TV Time API

Node.js and Express backend in plain JavaScript for the TV Time Flutter app.
Show discovery, search, details, seasons, episodes, recommendations, TVMaze
fallback data, optional IMDb ratings, and authenticated user data are served
through this API. Firebase Authentication remains the identity provider;
Firebase ID tokens scope all profile and library requests to the matching
PostgreSQL user row.

## Local setup

1. Install Node.js 22 or newer and Docker Desktop.
2. From this directory, copy `.env.example` to `.env` and set
   `TMDB_ACCESS_TOKEN`. Configure Firebase Admin using either
   `GOOGLE_APPLICATION_CREDENTIALS` pointing to a service account JSON file or
   `FIREBASE_SERVICE_ACCOUNT_BASE64` containing that JSON encoded as base64.
   Set `OMDB_API_KEY` to enable IMDb episode ratings.
   OMDb calls are counted per UTC day: at most `OMDB_DAILY_BUDGET` (default 900), of which lists
   may use `OMDB_LIST_BUDGET` (default 60%); past that, lists keep TMDB's rating and `/ratings` answers 503.
3. Start PostgreSQL with `docker compose up -d db`.
4. Install dependencies and start the API:

   ```powershell
   npm install
   npm run dev
   ```

5. Open `http://127.0.0.1:8000/health`.

`GET /health` checks the API process. `GET /health/ready` checks PostgreSQL.
The existing show endpoints remain available:

- `GET /api/v1/shows/search?q=severance`
- `GET /api/v1/shows/popular`
- `GET /api/v1/shows/top-rated`
- `GET /api/v1/shows/trending`  (all three accept `?page=1..500`)
- Show lists, search and `GET /api/v1/shows/:showId` report the IMDb rating (via OMDb) in `vote_average` when one exists, keeping the TMDB value as `tmdb_vote_average`.
- `GET /api/v1/shows/discover?with_genres=18|10759`
- `GET /api/v1/shows/:showId`
- `GET /api/v1/shows/:showId/seasons/:seasonNumber`
- `GET /api/v1/shows/:showId/ratings` (per-episode IMDb ratings via OMDb; cached in PostgreSQL per season — airing season 6 h, finished seasons 30 days — so OMDb is not asked on every open)
- `GET /api/v1/shows/:showId/similar` returns up to 12 shows viewers of this one go on to watch (TMDB recommendations, then similar, re-ranked by genre overlap and rating, at least one shared genre required; short results are topped up from discover).
- `GET /api/v1/search?q=` shows and movies in one list, closest match first. People are dropped; each
  result keeps TMDB's `media_type` (`tv` or `movie`), which is the tag the app displays.
- Movies: `GET /api/v1/movies/trending?page=`, `/movies/popular?page=`, `/movies/:movieId` (details with
  `credits`, `videos`, `watch/providers`, `external_ids`) and `/movies/:movieId/similar`. They report IMDb
  ratings in `vote_average` like the show routes.

TVMaze fallback endpoints are available under
`/api/v1/providers/tvmaze/*`. Responses retain the provider-compatible shapes
expected by the Flutter models.

The PostgreSQL tables are created on startup. User-data endpoints live under
`/api/v1/me` and require `Authorization: Bearer <Firebase ID token>`:

- `GET`, `PATCH /api/v1/me`. `PATCH` accepts `displayName` and `timezone` (an
  IANA name such as `Africa/Addis_Ababa`; invalid names get a 400). The app
  reports `timezone` on sign-in and each time it returns to the foreground.
- `GET /api/v1/me/shows/:showId/recap?scope=season|last|all` returns a "where you left off" recap up to the
  user's latest watched episode (`src/recap.js`): `{ source: "ai" | "synopses", text, season, episode,
  scope, reason? }`. Written by Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL`, default `gemini-flash-latest`)
  from TMDB/TVmaze episode synopses and cached per show and episode; `GEMINI_DAILY_BUDGET` (200) model
  calls a UTC day in all (table `ai_usage`) and `RECAP_USER_DAILY_LIMIT` (15) per user. Without a key, over
  a limit, on an error or when it is too slow, Gemini Flash-Lite (`GEMINI_BACKUP_MODEL`, default
  `gemini-flash-lite-latest`, same key) writes it, then Groq if `GROQ_API_KEY` is set
  (`GROQ_MODEL`, default `openai/gpt-oss-120b`); with neither, or too little text, the answer is the synopses
  (`reason` says why). All writers together get 90 s from the request; a 429 pauses a writer for the wait it asks
  for (at least a minute), or 30 minutes when its daily quota is spent. `scope=all` gives the current and previous
  season in full and earlier seasons by their overview. `?writer=gemini|lite|groq` (that writer first, with each
  writer's errors in `writerNotes`) works only for the accounts in `RECAP_ADMIN_UIDS` (comma-separated uids;
  empty: nobody).
- `GET /api/v1/me/removed-items` -> `{ movies, movieFavorites, favorites }`: ids the user removed (a movie off the
  list, a movie favorite, a show favorite; `src/removed-items.js`), recorded by the delete routes and cleared when the
  user adds one back. The app's imports leave these out, so importing again does not bring them back.
- Account deletion (`src/account-deletion.js`, FEATURE_PLAN.md section 19): `POST /api/v1/me/account/delete-request`
  (needs a sign-in from the last 10 minutes, else 401 `recent_sign_in_required`) marks the account; it is locked
  (every other `/me` route answers 403 `account_pending_deletion`, except `GET /me`, cancelling and removing a
  device), its push tokens are removed, and the daily clean-up deletes the Firebase sign-in and all data 30 days
  later. `POST /api/v1/me/account/cancel-deletion` undoes it. `GET /me` includes `deletionRequestedAt` and
  `deleteAfter`. The web page for Google Play is `GET /delete-account`. Every `/me` request re-checks with
  Firebase, at most every 10 minutes per account, that the account still exists.
- `DELETE /api/v1/me` with `{ "confirm": "delete" }` deletes everything the server holds for
  the account (204; 400 `confirm_required` without the body). The Firebase sign-in is not
  touched; the next request starts with an empty account.
- `GET`, `POST`, `DELETE /api/v1/me/avatar`
- `GET /api/v1/me/watchlist` and `PUT`, `DELETE /api/v1/me/watchlist/:showId`
- `GET /api/v1/me/watchlist-view` returns the watchlist and progress in one
  response for the Watchlist page
  Each progress row also has `nextSeason`, `nextEpisode` (the earliest aired episode not yet watched,
  `null` when caught up) and `unwatchedCount` (aired episodes not watched), computed with the
  classification; all three are `null` until a show has been classified once more.
- `GET /api/v1/me/upcoming?today=YYYY-MM-DD` returns the assembled Upcoming
  feed for the signed-in user's watchlist and progress history. Results are
  cached per show and local calendar date for 24 hours; pass `refresh=true` to
  bypass that cache after an explicit pull-to-refresh.
- `GET /api/v1/me/recommendations?page=1..500` returns personalised "Top shows
  for you" in TMDB list shape (20 per page). Seeds come from favorites, the
  watchlist and watch progress; candidates are TMDB recommendations of those
  seeds, minus anything already tracked. New accounts get popular shows.
- New-episode push notifications (`FEATURE_PLAN.md`, section 7; `src/notifications.js`). The app uploads its
  FCM token with `PUT /api/v1/me/devices` (`{ token, platform }`) and removes it on sign-out with
  `DELETE /me/devices` (`{ token }`). `GET`, `PATCH /me/notification-settings` (`{ enabled }`) and
  `PUT`, `DELETE /me/notification-settings/muted/:seriesId` hold the master switch and per-show mutes.
  A sweep every 15 minutes sends one push per episode when its moment arrives: the air time in the
  network's zone when TVMaze has both (`airTime`, `timezone`), otherwise 09:00 on the air date in the
  user's zone (streaming shows have no time). A missed moment is still sent for 24 hours. Title = show
  name, body = `S03 | E01`, data = `seriesId`, `season`, `episode`; between 23:00 and 07:00 local it goes
  to the silent channel `new_episodes_silent` instead of `new_episodes`.
  `notifications_sent` keeps it to once per episode. Uses the same Firebase service account as sign-in.
  Set `NOTIFICATIONS_DISABLED=1` to turn the sweep off.
- Episode ratings (`FEATURE_PLAN.md`, section 9; `src/episode-data.js`). `GET /api/v1/me/shows/:showId/episode-ratings`
  returns `{ ratings: { "S1E2": 4 } }` (1 to 5); `PUT /me/shows/:showId/episodes/:season/:episode/rating` with
  `{ rating }` sets one (400 `invalid_rating` outside 1-5); `DELETE` on the same path clears it. The row is the
  per-episode home for the later answers (feeling, favorite cast member, device) too.
  The ratings steer `GET /me/recommendations`: a show's seed weight is multiplied by 2 for an average of 4.5
  or more, 1.5 for 3.5 or more, 0 for 2 or less (two ratings at least; a favorite is halved instead), and left
  alone otherwise or when unrated (`ratingFactor` in `src/recommendations.js`).
- `PATCH /api/v1/me/progress/:showId/episodes` also accepts an optional `watchedAt` (ISO time) with
  `watched: true`: the day the user says they watched those episodes. It must be a real date, at most a day
  ahead (400 `invalid_watched_at` otherwise); without it the time of the request is used. A past `watchedAt`
  never moves the show's `lastWatched` backwards.
- `POST /me/progress/:id/import` also takes `mode: "fill"` (only episodes the app knows nothing about; the app's dates and un-ticks win) and `rewatchDates: [{ key, ats: [dates] }]` (real rewatch dates; fills up to that many, never repeats) and `rewatchCounts: [{ key, count }]` (tops an episode's rewatches up to `count`, dated a second apart after its watch date, never adds twice). Used by the TV Time import.
- Social (`src/social.js`, rules in `src/social-logic.js`, limiter in `src/rate-limit.js`; FEATURE_PLAN.md section 19). One-way follows, public by default; a private profile holds a follow as `pending` until accepted. Under `/api/v1/me/social`: `GET /` (my username or a suggestion, privacy, counts), `GET /username/available?name=`, `PUT /username` `{ username }` (3-20 of a-z 0-9 _, starting with a letter, lower-cased; 409 taken), `PATCH /privacy` `{ public }` (going public accepts the waiting), `GET /search?q=` (username prefix, 2-20 characters, 20 results), `POST|DELETE /following/:username`, `DELETE /followers/:username`, `GET /following|followers|requests`, `POST /requests/:username/accept`, `DELETE /requests/:username`, `GET /blocks`, `POST|DELETE /blocks/:username` (a block removes follows both ways and hides each from the other with a 404), `GET /users/:username` (counts, the relation, and when allowed the stats without ratings, the shows and the favorites), `GET /users/:username/compare` (rows with who is ahead, shared shows, shows only they watch, similarity; 403 when private, 400 for yourself; `?kind=movies` compares the watched movies instead: rows movies, minutes, average, thisYear, longest, the movies both watched and only they watched under the same `commonShows`/`onlyThem` names with the runtime in `you`/`them`, and a genre-mix similarity). Both kinds also carry `watchTogether` (what is on both watchlists and started by neither: unseen movies, or shows with no episode watched; at most 20) and `watchTogetherCount`; `onlyThem` is what they watched and you did not (the catch-up), `GET /users/:username/avatar`. Search, username checks and profile views allow 30 a minute per user, writes 60 (429 `rate_limited` with `Retry-After`). Tables `follows`, `blocks`, and `app_users.username` / `profile_public`; deleting an account removes them. A follow sends the person one quiet push (`type: new_follower`, once a day per pair, a request says "wants to follow you"); `social` in `/me/notification-settings` turns it off.
- `GET /api/v1/me/stats` (`src/stats.js`, rules in `src/stats-logic.js`; FEATURE_PLAN.md section 17): the stats page. `{ totals: { shows, episodes, specials, rewatches, movies, minutes: { episodes, rewatches, movies, total } }, firstWatch, latestWatch, biggestBinge: { episodes, showId, showName, date }, streak: { longest: { days, from, to }, current }, activeDays, months: [{ month, episodes, rewatches, movies, minutes }], busiestMonth, topShows, mostRewatched, bulkEpisodes, approximate, generatedAt }`. Days are in the user's timezone; bulk checks (more than 3 episodes of one show in one minute) count in totals and months but not in the binge, streaks or active days; show runtime is TMDB's `episode_run_time[0]`, else the median length of the show's first season (many shows have no `episode_run_time`, and the last episode is no stand-in, a finale runs long), else 42 minutes ( `approximate` is true until every runtime has been fetched).  Also (stats v2): `last7Days: { episodes, minutes }`, `weeks` (the last 12, Monday to Sunday: `{ start, episodes, minutes }`; bulk checks and specials left out), `marathons` (each show's best day, top 5), `topGenres` and `topNetworks` (`{ name, shows }`), `backlog: { remainingEpisodes, shows, minutes, episodesPerWeek, catchUpDate, unknownShows }` (aired episodes not yet watched on started, active shows; the pace is first watches over the last 8 weeks), `library: { added, inProduction }`, `ratings: { count, shows }`. Also `movieStats: { watched, minutes, averageRuntime, thisYear, unknownRuntime, months: [{ month, movies, minutes }], busiestMonth, genres: [{ name, movies }] (top 5, named from TMDB movie genre ids), decades: [{ decade, movies }], longest, shortest ({ movieId, title, posterPath, runtime, date }), firstDate, latestDate }` (watched movies only; a movie with no runtime adds no minutes; more than 10 movies on one day is a bulk day, such as the day an account was set up: they count in the totals and months, and in `bulkMovies`, but not in the busiest month (movie or overall), the streaks or `activeDays`). Cached for a minute.
- `POST /api/v1/me/import/resolve` (`src/import-resolve.js`): `{ tvdb: [ids], imdb: ["tt…"] }` (up to 200 each) -> `{ tvdb: { id: tmdbId|null }, imdb: {...}, failed: ["tvdb:5"] }`. Also `search: [{ key, title, year }]` (up to 50) -> `search: { key: tmdbId|null }`: a movie whose IMDb id TMDB does not list, matched by exact title and release year (a year either side). Also `episodes: [tvdbEpisodeId]` (up to 200) -> `episodes: { id: { show, season, episode } | null }`: where TMDB has the episode, exact even when the numbering differs. For the TV Time import (TVDB ids for shows, IMDb ids for movies -> TMDB ids via `/find`, cached in `provider_cache`; `null` = TMDB does not know it, `failed` = lookup error, ask again).
- Rewatches and rewatch passes (`FEATURE_PLAN.md`, section 14; rules in `src/rewatch-logic.js`, routes in
  `src/rewatches.js`). Every progress row (`/me/progress`, `/me/progress/:id`, `watchlist-view`, the episode-marking
  and import answers) now also carries `rewatches` (`{ "S1E2": [ { at, source: "pass"|"manual", pass? } ] }`, oldest first),
  `rewatchCount` (all rewatches, for the totals) and `rewatchPasses` (`[ { season, target, startedAt, episodes } ]`). An
  episode's level is 0 if unwatched, else 1 + its rewatches; a pass covers a season's watched episodes and aims one level
  above the lowest, and ends by itself when all of them reach it. Under `/api/v1/me/progress/:showId/rewatch`, each
  answering `{ progress, completedSeasons? , removed? , added? }`:
  - `POST /passes` `{ season }` starts a pass (409 `pass_open`, 409 `nothing_to_rewatch`);
  - `POST /passes/:season/stop` ends it and keeps the ticks; `/cancel` ends it and takes back what it added (`removed`);
    `/finish` `{ at? }` marks every episode still to do (`added`);
  - `PUT /episodes/:key` `{ at? }` adds a rewatch (409 `not_watched`; counts for the pass when one wants the episode);
    `DELETE /episodes/:key` takes off the latest (404 `no_rewatch`);
  - `POST /seasons/:season/remove-last` takes one watch off every rewatched episode (409 `pass_open` while a pass is open).
  Un-ticking an episode (or an import that does) forgets its rewatches and ends a pass with nothing left to do.
- Movies (see `FEATURE_PLAN.md`, section 4). A watched movie is always on the movie watchlist; `watchedOn`
  (`YYYY-MM-DD` or `null`) says whether and when it was watched. The server fetches the movie from TMDB,
  so a client sends no movie body:
  - `GET /api/v1/me/movies/watchlist`, `PUT`, `DELETE /api/v1/me/movies/watchlist/:movieId`. `PUT` is
    idempotent and keeps the added and watched dates. `DELETE` is a clean wipe, including the watched date.
  - `PUT /api/v1/me/movies/watchlist/:movieId/watched` with `{ date: "YYYY-MM-DD" }` ticks a movie and
    adds it to the watchlist if needed. 400 `invalid_date` / `date_in_future`; 409 `not_released` (with
    `releaseDate`) for a movie that is not out yet in the user's timezone. `DELETE` on the same path
    un-ticks: the movie stays on the watchlist and its date is cleared (404 `not_in_watchlist` if absent).
  - `GET /api/v1/me/movies/favorites` and `PUT`, `DELETE /api/v1/me/movies/favorites/:movieId`.
  - `GET /api/v1/me/movies/recommendations?page=` is "Movies for you", seeded from favorites, watched
    and listed movies; new accounts get popular movies.
  - `GET /api/v1/me/movies/upcoming-sequels` lists movies not out yet that belong to the same TMDB
    collection as any movie on the user's list (watched or not), soonest first, each with `sequel_to`
    (the listed movie it follows) and `collection_name`. Movies already on the list, hidden ones and
    ones with no release date are left out. `PUT` / `DELETE /api/v1/me/movies/sequels/:movieId/dismissed`
    hides / restores one. Collections are TMDB's own, so a sequel TMDB files elsewhere does not appear.
  - `GET /api/v1/me/movies/stats` returns `{ watchedCount, watchedMinutes }` for the profile.
- `GET /api/v1/me/shows/:showId/state` returns `{ state }`: `watchlist`, `stopped`, `removed`
  or `none`. `PUT /api/v1/me/shows/:showId/stopped` (Stop watching) and `PUT .../removed`
  (Remove) take the show document as the body, take it off the watchlist and keep its progress.
  A stopped show is listed in `watchlist-view`'s `allShows` with `classification: "stopped"`; a
  removed one is in no list. Both are left out of Upcoming and the recommendation seeds.
  `DELETE /api/v1/me/shows/:showId/stopped` (Continue watching) puts it back on the watchlist;
  `PUT /me/watchlist/:showId` clears either state too.
- `GET /api/v1/me/show-states` returns `{ stopped: [ids], removed: [ids] }`.
- `GET /api/v1/me/favorites` and `PUT`, `DELETE /api/v1/me/favorites/:showId`
- `GET /api/v1/me/progress` and `GET`, `DELETE /api/v1/me/progress/:showId` (progress changes through the episodes PATCH and the import POST)
- `GET /api/v1/me/progress/:showId` returns one show's progress (404 if none).
- `PATCH /api/v1/me/progress/:showId/episodes` with
  `{ episodeKeys: ["S1E2"], watched: true, currentSeason, currentEpisode,
  totalEpisodes?, showName?, posterPath?, backdropPath? }` marks episodes
  watched or unwatched. The server applies the keys to the stored set under a
  per-show advisory lock, so overlapping requests (two quick taps, or two
  devices) are applied one after the other instead of overwriting each other.
  Prefer this to `PUT` for episode tracking; `PUT` replaces the whole row.
- `POST /api/v1/me/progress/:showId/import` merges imported watch records (for
  example a Trakt export) into one show:
  `{ actions: [{ key: "S1E2", watched: true, at: ISO date }], totalEpisodes?,
  showName?, posterPath?, backdropPath?, summary?: { plays, lastWatched } }`.
  It answers with the show's progress, or 204 when the show ends up with no
  watched episodes (a show with nothing watched has no progress row). Repeating
  a request changes nothing, so clients may retry it.

For every episode the **newest date wins**, whether that is when it was watched
or when it was unwatched: a newer record is applied, an older or equal one is
ignored, and an episode the account knows nothing about takes any record. So an
older export can never undo something a newer export (or a tap in the app)
changed, whichever order they are imported in. To make that possible the date of
an unwatch is remembered in the `unwatched_episodes` table. It is deliberately
separate from `show_progress`: nothing that lists shows, classifies them or
decides what is "tracked" reads it, so remembering an unwatch can never make an
unwatched show look started. The rules live in `src/episode-merge.js`; marking
episodes in the app records an unmark with the current time, and deleting a
show's progress also forgets its unwatches.

Progress responses include a backend-maintained `classification`,
`classificationCheckedAt`, `releasedEpisodeCount`, and `isEnded`. The API
refreshes a missing or expired classification in the background using TMDB;
progress writes invalidate the cached classification. The Flutter All Shows
page uses these fields and does not fetch seasons or episodes to classify
shows. The same backend refresh removes caught-up shows from the active
watchlist and adds them back when a new released episode requires attention;
the Flutter client no longer performs this reconciliation sweep. A stale
classification sweep runs at startup and every six hours; a progress write
triggers an immediate refresh for that show.

"Has this episode aired?" is answered against the user's own calendar date,
worked out from the `timezone` stored on `app_users` (UTC when it is missing).
TMDB air dates have no time of day, so an episode counts as aired from local
midnight on its air date. Each classification records the local date it was
computed for (`classification_date`); one from an earlier local day is treated
as stale and recomputed by the next sweep or pull-to-refresh, even if it ran
recently. Rows written before this existed have no date and are recomputed
once after deploy. Pulling to refresh the Watchlist
forces classification refreshes for all of the user's tracked shows before
reloading the Watchlist snapshot.

## Tests

`npm test` runs the unit tests. The route tests run the real SQL and need a
PostgreSQL; they are skipped unless `TEST_DATABASE_URL` is set (a different name
from `DATABASE_URL` on purpose, so the tests can never be pointed at production
by accident):

```
docker compose up -d db
TEST_DATABASE_URL=postgres://tv_time:tv_time_dev@localhost:5432/tv_time npm test
```

For a fresh start, point `DATABASE_URL` at an empty PostgreSQL database and
deploy the API. Its tables are created on startup. Do not import old Firestore
or Storage data. Existing Firebase Auth accounts remain valid; the first
authenticated API request creates a PostgreSQL profile row using that
account's Firebase UID. Old Firestore records are not read by this API.

Keep `.env` local and never put backend credentials in Flutter
`--dart-define` values.

For the Flutter app, set `BACKEND_BASE_URL` in its `dart_defines.json`.
For an Android emulator use `http://10.0.2.2:8000`; for a physical device use
the computer's LAN address.

## EthioDeploy

Connect this repository in EthioDeploy and add a new, empty Postgres database.
Set `TMDB_ACCESS_TOKEN`, either `FIREBASE_SERVICE_ACCOUNT_JSON` (raw JSON) or
`FIREBASE_SERVICE_ACCOUNT_BASE64` (Base64 encoded JSON), and
`FIREBASE_PROJECT_ID=tv-time-bdcd5` as secrets,
optionally `OMDB_API_KEY`, and `CORS_ALLOWED_ORIGINS` to the exact Flutter Web
origin if you deploy Flutter Web. Use the Postgres addon's `DATABASE_URL`.
`npm start`
binds to `0.0.0.0` and uses EthioDeploy's `PORT` environment variable.
