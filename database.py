"""database.py

Zentrale DB-Initialisierung.

Wichtig:
- URL kommt aus ENV (DATABASE_URL) oder aus config.py Defaults
- pool_pre_ping schützt gegen "stale" Connections
"""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from config import settings

import logging

logging.basicConfig(level=logging.INFO)
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)   # weniger SQL
logging.getLogger("sqlalchemy.pool").setLevel(logging.WARNING)


DATABASE_URL = settings.database_url

# SQLite braucht connect_args für Threads, Postgres nicht.
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args=connect_args,
    echo=True, 
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
