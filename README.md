# TV Time API

Node.js and Express backend in plain JavaScript for the TV Time Flutter app.
The first API feature is show search through TMDB; its credential stays on the
server.

## Local setup

1. Install Node.js 22 or newer and Docker Desktop.
2. From this directory, copy `.env.example` to `.env` and set `TMDB_ACCESS_TOKEN`.
3. Start PostgreSQL with `docker compose up -d db`.
4. Install dependencies and start the API:

   ```powershell
   npm install
   npm run dev
   ```

5. Open `http://127.0.0.1:8000/health`.

`GET /health` checks the API process. `GET /api/v1/shows/search?q=severance`
forwards search to TMDB and returns TMDB's show JSON, which matches the current
Flutter `TvSeries.fromJson` model.

The database is wired for the next slice (user data and show cache); search
does not need to write to it. Keep `.env` local and never put backend
credentials in Flutter `--dart-define` values.

For the Flutter app, set `BACKEND_BASE_URL` in its `dart_defines.json`. For an
Android emulator use `http://10.0.2.2:8000`; for a physical device use the
computer's LAN address. The TMDB define is still used by Flutter features not
migrated yet.

## EthioDeploy

Connect this repository in EthioDeploy and add a Postgres addon. Set
`TMDB_ACCESS_TOKEN` as a secret and `CORS_ALLOWED_ORIGINS` to the exact Flutter
Web origin if you deploy Flutter Web. `npm start` binds to `0.0.0.0` and uses
EthioDeploy's `PORT` environment variable.
