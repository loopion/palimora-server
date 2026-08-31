import os
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Force SQLite before app modules import settings.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("STORAGE_BACKEND", "local")
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_dummy")
os.environ.setdefault("STRIPE_PUBLISHABLE_KEY", "pk_test_dummy")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_dummy")

from app import db as db_module  # noqa: E402
from app.auth import issue_device_token  # noqa: E402
from app.models import User  # noqa: E402


@pytest.fixture()
def _engine():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    db_module.Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def _Session(_engine):
    return sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def db(_Session):
    session = _Session()
    yield session
    session.close()


@pytest.fixture()
def client(_engine, _Session, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import get_db

    def _get_db():
        session = _Session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_db
    monkeypatch.setattr(db_module, "engine", _engine, raising=False)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def make_user(db, *, email="u@test.fr", credits=0, is_admin=False) -> User:
    from app.auth import hash_password
    user = User(email=email, password_hash=hash_password("x" * 12),
                is_admin=is_admin, credit_balance=credits, email_verified=True)
    db.add(user)
    db.commit()
    return user


def auth_headers(db, user) -> dict:
    token = issue_device_token(db, user, "test")
    return {"Authorization": f"Bearer {token}"}
