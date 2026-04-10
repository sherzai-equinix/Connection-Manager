from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Set

from sqlalchemy import text
from sqlalchemy.orm import Session


def _serialize_details(details: Any | None) -> str | None:
    if details is None:
        return None
    if isinstance(details, (dict, list)):
        return json.dumps(details, default=str)
    return str(details)


def _serialize_details_json(details: Any | None) -> str | None:
    if details is None:
        return None
    try:
        return json.dumps(details, default=str)
    except Exception:
        return json.dumps(str(details))


def _audit_columns(db: Session) -> Set[str]:
    rows = db.execute(
        text(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'audit_log'
            """
        )
    ).scalars().all()
    return {str(r) for r in rows}


def write_audit_log(
    db: Session,
    user_id: int | None,
    action: str,
    entity_type: str | None = None,
    entity_id: int | str | None = None,
    details: Any | None = None,
    *,
    actor_user_id: int | None = None,
    target_user_id: int | None = None,
    endpoint: str | None = None,
    ip: str | None = None,
) -> None:
    """Write an audit entry. Never raises — audit failures must never block main operations."""
    try:
        _write_audit_log_inner(
            db, user_id, action, entity_type, entity_id, details,
            actor_user_id=actor_user_id, target_user_id=target_user_id,
            endpoint=endpoint, ip=ip,
        )
    except Exception:
        pass


def _write_audit_log_inner(
    db: Session,
    user_id: int | None,
    action: str,
    entity_type: str | None = None,
    entity_id: int | str | None = None,
    details: Any | None = None,
    *,
    actor_user_id: int | None = None,
    target_user_id: int | None = None,
    endpoint: str | None = None,
    ip: str | None = None,
) -> None:
    """Internal implementation — called only from write_audit_log.

    Compatible with the legacy schema while supporting new columns.
    """
    cols = _audit_columns(db)
    now = datetime.now(timezone.utc)
    actor = actor_user_id if actor_user_id is not None else user_id
    details_text = _serialize_details(details)
    details_json = _serialize_details_json(details)

    payload = {
        "user_id": int(actor) if actor is not None else None,
        "actor_user_id": int(actor) if actor is not None else None,
        "action": action,
        "entity_type": entity_type,
        "entity_id": str(entity_id) if entity_id is not None else None,
        "details": details_text,
        "details_json": details_json,
        "target_user_id": int(target_user_id) if target_user_id is not None else None,
        "endpoint": endpoint,
        "ip": ip,
        "created_at": now,
        "ts": now,
    }

    insert_cols = [c for c in payload.keys() if c in cols]
    if not insert_cols:
        return

    placeholders = [f":{c}" for c in insert_cols]
    db.execute(
        text(
            f"""
            INSERT INTO public.audit_log ({', '.join(insert_cols)})
            VALUES ({', '.join(placeholders)})
            """
        ),
        payload,
    )
