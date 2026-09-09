from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

# The RQ worker forks a child per job; forked children share the parent's pooled
# psycopg3 connections, and psycopg's client-side prepared-statement cache
# desyncs from the server across the fork ("prepared statement _pg3_0 already
# exists"). Disabling server-side prepared statements avoids the collision.
_connect_args: dict = {}
if settings.database_url.startswith(("postgresql", "postgres")):
    _connect_args["prepare_threshold"] = None

engine = create_engine(
    settings.database_url, pool_pre_ping=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
