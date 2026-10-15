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
- `GET`, `POST`, `DELETE /api/v1/me/avatar`
- `GET /api/v1/me/watchlist` and `PUT`, `DELETE /api/v1/me/watchlist/:showId`
- `GET /api/v1/me/watchlist-view` returns the watchlist and progress in one
  response for the Watchlist page
- `GET /api/v1/me/upcoming?today=YYYY-MM-DD` returns the assembled Upcoming
  feed for the signed-in user's watchlist and progress history. Results are
  cached per show and local calendar date for 24 hours; pass `refresh=true` to
  bypass that cache after an explicit pull-to-refresh.
- `GET /api/v1/me/recommendations?page=1..500` returns personalised "Top shows
  for you" in TMDB list shape (20 per page). Seeds come from favorites, the
  watchlist and watch progress; candidates are TMDB recommendations of those
  seeds, minus anything already tracked. New accounts get popular shows.
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
- `GET /api/v1/me/favorites` and `PUT`, `DELETE /api/v1/me/favorites/:showId`
- `GET /api/v1/me/progress` and `PUT`, `DELETE /api/v1/me/progress/:showId`
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
