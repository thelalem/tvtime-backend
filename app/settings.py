from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    database_url: str = "postgresql+psycopg://tv_time:tv_time_dev@localhost:5432/tv_time"
    tmdb_access_token: str = ""
    tmdb_base_url: str = "https://api.themoviedb.org/3"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


@lru_cache
def get_settings() -> Settings:
    return Settings()
