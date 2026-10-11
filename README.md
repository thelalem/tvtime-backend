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
- `GET /api/v1/shows/trending`
- `GET /api/v1/shows/discover?with_genres=18|10759`
- `GET /api/v1/shows/:showId`
- `GET /api/v1/shows/:showId/seasons/:seasonNumber`
- `GET /api/v1/shows/:showId/ratings`

TVMaze fallback endpoints are available under
`/api/v1/providers/tvmaze/*`. Responses retain the provider-compatible shapes
expected by the Flutter models.

The PostgreSQL tables are created on startup. User-data endpoints live under
`/api/v1/me` and require `Authorization: Bearer <Firebase ID token>`:

- `GET`, `PATCH /api/v1/me`
- `GET`, `POST`, `DELETE /api/v1/me/avatar`
- `GET /api/v1/me/watchlist` and `PUT`, `DELETE /api/v1/me/watchlist/:showId`
- `GET /api/v1/me/favorites` and `PUT`, `DELETE /api/v1/me/favorites/:showId`
- `GET /api/v1/me/progress` and `PUT`, `DELETE /api/v1/me/progress/:showId`

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
Set `TMDB_ACCESS_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_BASE64`, and
`FIREBASE_PROJECT_ID=tv-time-bdcd5` as secrets,
optionally `OMDB_API_KEY`, and `CORS_ALLOWED_ORIGINS` to the exact Flutter Web
origin if you deploy Flutter Web. Use the Postgres addon's `DATABASE_URL`.
`npm start`
binds to `0.0.0.0` and uses EthioDeploy's `PORT` environment variable.
