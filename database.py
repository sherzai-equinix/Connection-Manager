"""database.py

Zentrale DB-Initialisierung.

Wichtig:
- URL kommt aus ENV (DATABASE_URL) oder aus config.py Defaults
- pool_pre_ping schützt gegen "stale" Connections
- Pool-Größe, Recycle und Timeout sind per ENV steuerbar (siehe config.py),
  damit bis zu ~10 gleichzeitige Nutzer nicht in den SQLAlchemy-Default
  (5 + 10 Verbindungen) laufen und Requests sauber warten statt zu hängen.
"""

from __future__ import annotations

import logging

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from config import settings

_LEVELS = {
    "critical": logging.CRITICAL,
    "error": logging.ERROR,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}

logging.basicConfig(
    level=_LEVELS.get(settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)  # weniger SQL
logging.getLogger("sqlalchemy.pool").setLevel(logging.WARNING)

log = logging.getLogger("cm.database")

DATABASE_URL = settings.database_url

# SQLite braucht connect_args für Threads, Postgres nicht.
connect_args: dict = {}
engine_kwargs: dict = {"pool_pre_ping": True, "echo": False}

if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
else:
    # Nur für echte Server-Datenbanken (Postgres) – SQLite kennt diese
    # QueuePool-Parameter nicht.
    connect_args = {
        # psycopg2: TCP-Verbindungsaufbau nicht endlos hängen lassen
        "connect_timeout": 10,
        # Postgres sieht im pg_stat_activity, welche App verbunden ist
        "application_name": f"connection-manager/{settings.app_version}",
    }
    engine_kwargs.update(
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_recycle=settings.db_pool_recycle,
        pool_timeout=settings.db_pool_timeout,
    )

engine = create_engine(DATABASE_URL, connect_args=connect_args, **engine_kwargs)

if not DATABASE_URL.startswith("sqlite"):
    log.info(
        "DB-Pool konfiguriert: pool_size=%s max_overflow=%s recycle=%ss timeout=%ss",
        settings.db_pool_size,
        settings.db_max_overflow,
        settings.db_pool_recycle,
        settings.db_pool_timeout,
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
