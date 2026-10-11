# TV Time API

Node.js and Express backend in plain JavaScript for the TV Time Flutter app.
Show discovery, search, details, seasons, episodes, recommendations, TVMaze
fallback data, and optional IMDb ratings are served through this API. Provider
credentials stay on the server.

## Local setup

1. Install Node.js 22 or newer and Docker Desktop.
2. From this directory, copy `.env.example` to `.env` and set
   `TMDB_ACCESS_TOKEN`. Set `OMDB_API_KEY` to enable IMDb episode ratings.
3. Start PostgreSQL with `docker compose up -d db`.
4. Install dependencies and start the API:

   ```powershell
   npm install
   npm run dev
   ```

5. Open `http://127.0.0.1:8000/health`.

`GET /health` checks the API process. The show endpoints are:

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

The database is wired for the next slice (user data and show cache); search
does not need to write to it. Keep `.env` local and never put backend
credentials in Flutter `--dart-define` values.

For the Flutter app, set only `BACKEND_BASE_URL` in its `dart_defines.json`.
For an Android emulator use `http://10.0.2.2:8000`; for a physical device use
the computer's LAN address.

## EthioDeploy

Connect this repository in EthioDeploy and add a Postgres addon. Set
`TMDB_ACCESS_TOKEN` as a secret, optionally `OMDB_API_KEY` for IMDb ratings, and
`CORS_ALLOWED_ORIGINS` to the exact Flutter Web origin if you deploy Flutter
Web. `npm start` binds to `0.0.0.0` and uses EthioDeploy's `PORT` environment
variable.
