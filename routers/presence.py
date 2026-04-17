"""Presence router – Live-Anzeige aktiver Benutzer.

Endpoints:
  POST /api/v1/presence/heartbeat  – Browser meldet Seite + letzte Aktion
  GET  /api/v1/presence/online     – Liste aller aktiven Benutzer

Feature kann sauber entfernt werden:
  1. Diesen Router aus app.py entfernen
  2. UserPresence aus models.py loeschen
  3. DROP TABLE user_presence;
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from security import get_current_user

router = APIRouter(prefix="/api/v1/presence", tags=["presence"])

# Benutzer gilt als offline wenn laenger als 2 Minuten kein Heartbeat
ACTIVE_THRESHOLD_SECONDS = 120

# Seiten-Labels fuer die Anzeige
PAGE_LABELS = {
    "dashboard.html": "Dashboard",
    "cross-connects.html": "Cross-Connects",
    "kw-planning.html": "KW Planung",
    "kw-jobs.html": "KW Jobs",
    "kw-job-detail.html": "KW Job Detail",
    "migration-audit.html": "Migration Audit",
    "patchpanels.html": "Patchpanels",
    "patchpanel-view.html": "Patchpanel Ansicht",
    "historical-archive.html": "Leitungsarchiv",
    "import-export.html": "Import / Export",
    "admin.html": "Admin",
    "zside-onboarding.html": "Z-Side Onboarding",
    "rack-view.html": "Rack Ansicht",
}


class HeartbeatIn(BaseModel):
    current_page: Optional[str] = Field(None, max_length=100)
    last_action: Optional[str] = Field(None, max_length=200)


class PresenceOut(BaseModel):
    user_id: int
    username: str
    login_at: str
    last_seen: str
    current_page: str | None = None
    current_page_label: str | None = None
    last_action: str | None = None
    seconds_ago: int = 0
    is_active: bool = True


def _ensure_table(db: Session):
    """Create presence table if it does not exist (idempotent)."""
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS user_presence (
            id              SERIAL PRIMARY KEY,
            user_id         INTEGER NOT NULL,
            username        VARCHAR(100) NOT NULL,
            login_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            current_page    VARCHAR(100),
            last_action     VARCHAR(200),
            is_active       BOOLEAN NOT NULL DEFAULT TRUE,
            CONSTRAINT uq_presence_user UNIQUE (user_id)
        )
    """))
    db.commit()


@router.post("/heartbeat")
def heartbeat(
    payload: HeartbeatIn,
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Browser sendet alle 30s einen Heartbeat mit aktueller Seite."""
    user_id = user["id"]
    username = user["username"]
    now = datetime.now(timezone.utc)

    # Upsert: insert or update
    db.execute(
        text("""
            INSERT INTO user_presence (user_id, username, login_at, last_seen, current_page, last_action, is_active)
            VALUES (:uid, :uname, :now, :now, :page, :action, TRUE)
            ON CONFLICT (user_id) DO UPDATE SET
                username     = EXCLUDED.username,
                last_seen    = EXCLUDED.last_seen,
                current_page = EXCLUDED.current_page,
                last_action  = COALESCE(EXCLUDED.last_action, user_presence.last_action),
                is_active    = TRUE
        """),
        {
            "uid": user_id,
            "uname": username,
            "now": now,
            "page": payload.current_page,
            "action": payload.last_action,
        },
    )
    db.commit()
    return {"ok": True}


@router.get("/online", response_model=list[PresenceOut])
def get_online_users(
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Alle Benutzer die in den letzten 2 Minuten aktiv waren."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ACTIVE_THRESHOLD_SECONDS)
    now_utc = datetime.now(timezone.utc)

    # Mark stale sessions as inactive
    db.execute(
        text("UPDATE user_presence SET is_active = FALSE WHERE last_seen < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()

    rows = db.execute(
        text("""
            SELECT user_id, username, login_at, last_seen, current_page, last_action, is_active
            FROM user_presence
            WHERE last_seen >= :cutoff
            ORDER BY last_seen DESC
        """),
        {"cutoff": cutoff},
    ).mappings().all()

    result = []
    for r in rows:
        page = r.get("current_page") or ""
        last_seen_dt = r.get("last_seen")
        if last_seen_dt and last_seen_dt.tzinfo is None:
            last_seen_dt = last_seen_dt.replace(tzinfo=timezone.utc)
        login_at_dt = r.get("login_at")
        if login_at_dt and login_at_dt.tzinfo is None:
            login_at_dt = login_at_dt.replace(tzinfo=timezone.utc)

        seconds_ago = int((now_utc - last_seen_dt).total_seconds()) if last_seen_dt else 9999

        result.append(PresenceOut(
            user_id=r["user_id"],
            username=r["username"],
            login_at=login_at_dt.isoformat() if login_at_dt else "",
            last_seen=last_seen_dt.isoformat() if last_seen_dt else "",
            current_page=page,
            current_page_label=PAGE_LABELS.get(page, page.replace(".html", "").replace("-", " ").title() if page else None),
            last_action=r.get("last_action"),
            seconds_ago=seconds_ago,
            is_active=bool(r.get("is_active", False)),
        ))
    return result


@router.post("/logout")
def presence_logout(
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Markiert den Benutzer als offline beim Logout."""
    db.execute(
        text("UPDATE user_presence SET is_active = FALSE WHERE user_id = :uid"),
        {"uid": user["id"]},
    )
    db.commit()
    return {"ok": True}
