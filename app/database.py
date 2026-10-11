from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from app.settings import get_settings


def create_db_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


engine = create_db_engine()


def database_is_ready() -> bool:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return True
