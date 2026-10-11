import httpx
from fastapi import HTTPException

from app.settings import get_settings


async def search_tv(query: str) -> dict:
    settings = get_settings()
    if not settings.tmdb_access_token:
        raise HTTPException(status_code=503, detail="TV metadata provider is not configured")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"{settings.tmdb_base_url.rstrip('/')}/search/tv",
                params={"query": query},
                headers={
                    "Authorization": f"Bearer {settings.tmdb_access_token}",
                    "accept": "application/json",
                },
            )
            response.raise_for_status()
            return response.json()
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="TV metadata provider timed out") from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail="TV metadata provider request failed") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="TV metadata provider is unavailable") from exc
