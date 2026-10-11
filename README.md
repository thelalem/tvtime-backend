# TV Time API

Personal REST API for the TV Time Flutter app. This first slice exposes a health
check and TV search through TMDB. The TMDB credential and PostgreSQL connection
string are read only by the backend.

## Local setup

1. Install Python 3.12 or newer and Docker Desktop.
2. From this directory, copy `.env.example` to `.env` and set `TMDB_ACCESS_TOKEN`.
3. Start PostgreSQL with `docker compose up -d db`.
4. Create a virtual environment and install dependencies:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -e .
   ```

5. Start the API with `uvicorn app.main:app --reload`.
6. Open `http://127.0.0.1:8000/docs` to explore the API.

`GET /health` checks the API process. `GET /api/v1/shows/search?q=severance`
forwards search to TMDB and returns TMDB's show JSON, which matches the current
Flutter `TvSeries.fromJson` model.

The database is provisioned now for the next slice (user data and show cache);
search does not need to write to it. Keep `.env` local and never put backend
credentials in Flutter `--dart-define` values.

For the Flutter app, set `BACKEND_BASE_URL` in `dart_defines.json`. The default
is suitable for Flutter Web/desktop running beside the API. For an Android
emulator use `http://10.0.2.2:8000`; for a physical device use the computer's
LAN address. The TMDB define is still used by features not migrated yet.
