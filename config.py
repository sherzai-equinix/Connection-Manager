"""config.py

Zentrale Konfiguration (ohne Framework-Magic).

Ziel:
- keine Hardcodes über das Projekt verteilt
- sinnvolle Defaults für lokale Entwicklung
- alles per ENV überschreibbar
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv(override=False)


def _split_csv(value: str | None) -> tuple[str, ...] | None:
    if not value:
        return None
    parts = [p.strip() for p in value.split(",")]
    parts = [p for p in parts if p]
    return tuple(parts) if parts else None


def _get_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # API
    api_prefix: str = os.getenv("API_PREFIX", "/api/v1")

    # DB
    # Hinweis: Default bleibt kompatibel zu deinem bisherigen Setup.
    # Für ein "sauberes" Setup lieber über ENV setzen.
    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://deviceapp:SuperSecretPW@localhost:5432/devicedb",
    )

    # CORS
    cors_origins: tuple[str, ...] | None = _split_csv(os.getenv("CORS_ORIGINS"))

    # Frontend dev (file:// oder live server)
    # Wenn cors_origins nicht gesetzt ist, verwenden wir diese Defaults.
    # "null" erlaubt Requests von file:// Seiten (lokale Entwicklung)
    cors_default_origins: tuple[str, ...] = (
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://tocry.corp.equinix.com",
        "null",
    )

    # JWT Auth
    jwt_secret: str | None = os.getenv("JWT_SECRET")
    jwt_expire_hours: int = _get_int_env("JWT_EXPIRE_HOURS", 8)


settings = Settings()
