from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import SQLAlchemyError

from app.database import database_is_ready
from app.tmdb import search_tv

app = FastAPI(title="TV Time API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET"],
    allow_headers=["accept", "content-type"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
def readiness() -> JSONResponse:
    try:
        database_is_ready()
    except SQLAlchemyError:
        return JSONResponse(status_code=503, content={"status": "not_ready", "database": "unavailable"})
    return JSONResponse(content={"status": "ready", "database": "ok"})


@app.get("/api/v1/shows/search")
async def show_search(q: str = Query(min_length=1, max_length=100)) -> dict:
    return await search_tv(q.strip())
