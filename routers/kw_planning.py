from __future__ import annotations

import json
import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from security import get_current_user


router = APIRouter(prefix=settings.api_prefix, tags=["kw-planning"])


TASK_TYPES = {"install", "deinstall", "move", "path_move"}
DEFAULT_STATUS_BY_TYPE = {
    "install": "pending_install",
    "deinstall": "pending_deinstall",
    "move": "pending_move",
    "path_move": "pending_path_move",
}
ALLOWED_TASK_STATUS = {
    "planned",
    "in_progress",
    "pending_install",
    "pending_deinstall",
    "pending_move",
    "pending_path_move",
    "done",
    "cancelled",
}
PLAN_STATUS_ALLOWED = {"draft", "active", "completed", "archived"}
PLAN_READ_ONLY_STATUS = {"completed", "archived"}

TASK_TO_CHANGE_TYPE = {
    "install": "NEW_INSTALL",
    "deinstall": "DEINSTALL",
    "move": "LINE_MOVE",
    "path_move": "PATH_MOVE",
}
CHANGE_TO_TASK_TYPE = {v: k for k, v in TASK_TO_CHANGE_TYPE.items()}

CHANGE_STATUS_ALLOWED = {"planned", "in_progress", "done", "canceled", "cancelled"}
CHANGE_TO_TASK_STATUS = {
    "planned": "planned",
    "in_progress": "in_progress",
    "done": "done",
    "canceled": "cancelled",
    "cancelled": "cancelled",
}
TASK_TO_CHANGE_STATUS = {
    "planned": "planned",
    "in_progress": "in_progress",
    "done": "done",
    "cancelled": "canceled",
    "pending_install": "planned",
    "pending_deinstall": "planned",
    "pending_move": "planned",
    "pending_path_move": "planned",
}

PLAN_INTERNAL_TO_COMPAT = {
    "draft": "open",
    "active": "open",
    "completed": "locked",
    "archived": "completed",
}

_CC_STATUS_CONSTRAINT_CHECKED = False
_KW_TABLES_ENSURED = False


class KwPlanIn(BaseModel):
    year: int = Field(..., ge=2000, le=2100)
    kw: int = Field(..., ge=1, le=53)


class KwTaskIn(BaseModel):
    type: str
    status: str | None = None
    line_id: int | None = None
    line1_id: int | None = None
    line2_id: int | None = None
    payload: dict[str, Any] | None = None


class KwTaskUpdateIn(BaseModel):
    status: str | None = None
    payload: dict[str, Any] | None = None


class DoneIn(BaseModel):
    apply: bool = True
    serial: str | None = None


class KwPlanCompatIn(BaseModel):
    kw: str = Field(..., min_length=6, max_length=16, description="e.g. 2026-KW10")


class KwChangeCompatIn(BaseModel):
    kw_plan_id: int | None = None
    kw: str | None = None
    type: str
    target_cross_connect_id: int | None = None
    payload_json: dict[str, Any] | None = None
    status: str | None = "planned"


def _has_column(db: Session, table: str, column: str, schema: str = "public") -> bool:
    row = db.execute(
        text(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = :schema
              AND table_name = :table
              AND column_name = :column
            LIMIT 1
            """
        ),
        {"schema": schema, "table": table, "column": column},
    ).first()
    return row is not None


def _ensure_kw_tables(db: Session) -> None:
    global _KW_TABLES_ENSURED
    if _KW_TABLES_ENSURED:
        return

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS public.kw_plans (
                id BIGSERIAL PRIMARY KEY,
                year INTEGER NOT NULL,
                kw INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_by BIGINT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at TIMESTAMPTZ NULL,
                archived_at TIMESTAMPTZ NULL,
                CONSTRAINT uq_kw_plans_year_kw UNIQUE (year, kw)
            );
            """
        )
    )
    db.execute(text("ALTER TABLE public.kw_plans ADD COLUMN IF NOT EXISTS status TEXT"))
    db.execute(text("ALTER TABLE public.kw_plans ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL"))
    db.execute(text("ALTER TABLE public.kw_plans ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL"))
    db.execute(
        text(
            """
            UPDATE public.kw_plans
            SET status = 'active'
            WHERE status IS NULL OR TRIM(status) = ''
            """
        )
    )
    try:
        db.execute(text("ALTER TABLE public.kw_plans ALTER COLUMN status SET DEFAULT 'active'"))
        db.execute(text("ALTER TABLE public.kw_plans ALTER COLUMN status SET NOT NULL"))
    except Exception:
        pass

    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS public.kw_tasks (
                id BIGSERIAL PRIMARY KEY,
                plan_id BIGINT NOT NULL REFERENCES public.kw_plans(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                line_id BIGINT NULL,
                line1_id BIGINT NULL,
                line2_id BIGINT NULL,
                payload JSONB NULL,
                created_by BIGINT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NULL
            );
            """
        )
    )
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_kw_tasks_plan_id ON public.kw_tasks(plan_id);"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_kw_tasks_type_status ON public.kw_tasks(type, status);"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_kw_tasks_line_id ON public.kw_tasks(line_id);"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_kw_plans_status_year_kw ON public.kw_plans(status, year, kw);"))
    _ensure_cross_connect_status_constraint(db)
    _KW_TABLES_ENSURED = True


def _ensure_cross_connect_status_constraint(db: Session) -> None:
    global _CC_STATUS_CONSTRAINT_CHECKED
    if _CC_STATUS_CONSTRAINT_CHECKED:
        return

    row = db.execute(
        text(
            """
            SELECT pg_get_constraintdef(c.oid) AS def
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND t.relname = 'cross_connects'
              AND c.conname = 'cc_status_check'
            LIMIT 1
            """
        )
    ).mappings().first()

    if not row:
        _CC_STATUS_CONSTRAINT_CHECKED = True
        return

    current_def = str(row.get("def") or "").lower()
    required_values = [
        "pending_install",
        "pending_deinstall",
        "pending_move",
        "pending_path_move",
    ]
    if all(value in current_def for value in required_values):
        _CC_STATUS_CONSTRAINT_CHECKED = True
        return

    try:
        with db.begin_nested():
            db.execute(text("ALTER TABLE public.cross_connects DROP CONSTRAINT IF EXISTS cc_status_check"))
            db.execute(
                text(
                    """
                    ALTER TABLE public.cross_connects
                    ADD CONSTRAINT cc_status_check
                    CHECK (
                        status = ANY (
                            ARRAY[
                                'planned',
                                'review',
                                'in_progress',
                                'done',
                                'troubleshoot',
                                'pending_serial',
                                'pending_install',
                                'pending_deinstall',
                                'pending_move',
                                'pending_path_move',
                                'active',
                                'deinstalled'
                            ]
                        )
                    )
                    """
                )
            )
    except Exception:
        # Some environments use a DB role without ALTER privilege.
        # In that case we keep the existing constraint and fall back to
        # task-based pending overlays on read paths.
        pass
    finally:
        _CC_STATUS_CONSTRAINT_CHECKED = True


def _swap_backbone_fields(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return item
    bi_i = item.get("backbone_in_instance_id")
    bi_p = item.get("backbone_in_port_label")
    bo_i = item.get("backbone_out_instance_id")
    bo_p = item.get("backbone_out_port_label")
    item["backbone_in_instance_id"], item["backbone_out_instance_id"] = bo_i, bi_i
    item["backbone_in_port_label"], item["backbone_out_port_label"] = bo_p, bi_p
    return item


def _swap_backbone_payload(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return payload
    bi_i = payload.get("backbone_in_instance_id")
    bi_p = payload.get("backbone_in_port_label")
    bo_i = payload.get("backbone_out_instance_id")
    bo_p = payload.get("backbone_out_port_label")
    payload["backbone_in_instance_id"], payload["backbone_out_instance_id"] = bo_i, bi_i
    payload["backbone_in_port_label"], payload["backbone_out_port_label"] = bo_p, bi_p
    return payload


def _line_select_sql(db: Session) -> str:
    has_sn = _has_column(db, "cross_connects", "serial_number")
    serial_sel = "COALESCE(serial_number, serial) AS effective_serial" if has_sn else "serial AS effective_serial"
    return f"SELECT *, {serial_sel} FROM public.cross_connects"


def _get_line_by_id(db: Session, line_id: int) -> dict[str, Any] | None:
    row = db.execute(
        text(_line_select_sql(db) + " WHERE id = :id LIMIT 1"),
        {"id": int(line_id)},
    ).mappings().first()
    if not row:
        return None
    item = dict(row)
    if item.get("effective_serial"):
        item["serial"] = item["effective_serial"]
    item.pop("effective_serial", None)
    return _swap_backbone_fields(item)


def _get_line_by_serial(db: Session, serial: str) -> dict[str, Any] | None:
    serial = (serial or "").strip()
    if not serial:
        return None

    has_sn = _has_column(db, "cross_connects", "serial_number")
    where = "WHERE serial = :serial"
    if has_sn:
        where += " OR serial_number = :serial"

    row = db.execute(
        text(_line_select_sql(db) + f" {where} ORDER BY created_at DESC, id DESC LIMIT 1"),
        {"serial": serial},
    ).mappings().first()
    if not row:
        return None

    item = dict(row)
    if item.get("effective_serial"):
        item["serial"] = item["effective_serial"]
    item.pop("effective_serial", None)
    return _swap_backbone_fields(item)


def _task_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "plan_id": int(row["plan_id"]),
        "type": row.get("type"),
        "status": row.get("status"),
        "line_id": row.get("line_id"),
        "line1_id": row.get("line1_id"),
        "line2_id": row.get("line2_id"),
        "payload": row.get("payload") or {},
        "created_by": row.get("created_by"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _is_plan_read_only(status: str | None) -> bool:
    return str(status or "").strip().lower() in PLAN_READ_ONLY_STATUS


def _plan_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    status = str(row.get("status") or "active").strip().lower() or "active"
    if status not in PLAN_STATUS_ALLOWED:
        status = "active"

    item = {
        "id": int(row["id"]),
        "year": int(row["year"]),
        "kw": int(row["kw"]),
        "status": status,
        "created_by": row.get("created_by"),
        "created_at": row.get("created_at"),
        "completed_at": row.get("completed_at"),
        "archived_at": row.get("archived_at"),
        "read_only": _is_plan_read_only(status),
    }
    if "tasks_total" in row:
        item["tasks_total"] = int(row.get("tasks_total") or 0)
    if "pending_tasks" in row:
        item["pending_tasks"] = int(row.get("pending_tasks") or 0)
    return item


def _plan_to_compat_dict(row: dict[str, Any]) -> dict[str, Any]:
    plan = _plan_to_dict(row)
    internal = str(plan.get("status") or "active").lower()
    return {
        "id": int(plan["id"]),
        "kw": f"{int(plan['year'])}-KW{int(plan['kw']):02d}",
        "status": PLAN_INTERNAL_TO_COMPAT.get(internal, "open"),
        "created_at": plan.get("created_at"),
    }


def _task_to_change_status(task_type: str | None, task_status: str | None) -> str:
    status = str(task_status or "").strip().lower()
    if status in {"planned", "in_progress", "done", "cancelled"}:
        return TASK_TO_CHANGE_STATUS.get(status, "planned")
    if status.startswith("pending_"):
        return "planned"
    return TASK_TO_CHANGE_STATUS.get(status, "planned")


def _change_status_to_task(task_type: str, change_status: str | None) -> str:
    status = str(change_status or "planned").strip().lower()
    if status not in CHANGE_STATUS_ALLOWED:
        raise HTTPException(status_code=400, detail="Invalid change status")
    if status in {"planned", "in_progress"}:
        return status
    return CHANGE_TO_TASK_STATUS[status]


def _task_to_change_dict(row: dict[str, Any]) -> dict[str, Any]:
    task_type = str(row.get("type") or "").strip().lower()
    return {
        "id": int(row["id"]),
        "kw_plan_id": int(row["plan_id"]),
        "type": TASK_TO_CHANGE_TYPE.get(task_type, task_type.upper()),
        "target_cross_connect_id": row.get("line_id"),
        "payload_json": row.get("payload") or {},
        "status": _task_to_change_status(task_type, row.get("status")),
        "created_at": row.get("created_at"),
        "completed_at": row.get("completed_at"),
        "created_by": row.get("created_by"),
        "completed_by": row.get("completed_by"),
    }


def _parse_kw_label(value: str | None) -> tuple[int, int]:
    raw = str(value or "").strip().upper()
    m = re.match(r"^(\d{4})-?KW(\d{1,2})$", raw)
    if not m:
        raise HTTPException(status_code=400, detail="kw must be formatted like 2026-KW10")
    year = int(m.group(1))
    kw = int(m.group(2))
    if year < 2000 or year > 2100 or kw < 1 or kw > 53:
        raise HTTPException(status_code=400, detail="Invalid kw value")
    return year, kw


def _get_plan_row(db: Session, plan_id: int, for_update: bool = False) -> dict[str, Any] | None:
    sql = """
        SELECT id, year, kw, status, created_by, created_at, completed_at, archived_at
        FROM public.kw_plans
        WHERE id = :id
        LIMIT 1
    """
    if for_update:
        sql += " FOR UPDATE"
    row = db.execute(text(sql), {"id": int(plan_id)}).mappings().first()
    return dict(row) if row else None


def _assert_plan_editable(plan_row: dict[str, Any]) -> None:
    if _is_plan_read_only(plan_row.get("status")):
        raise HTTPException(status_code=403, detail="KW plan is read-only (completed/archived)")


def _norm_alnum(value: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def _room_norm_variants(room: str | None) -> list[str]:
    raw = str(room or "").strip()
    if not raw:
        return []
    raw = raw.replace(" ", "")
    core = raw[1:] if raw.upper().startswith("M") and len(raw) > 1 else raw

    variants: list[str] = []
    match = re.match(r"^(\d+)\.(\d+)(S\d+)?$", core, flags=re.IGNORECASE)
    if match:
        major = match.group(1)
        minor = match.group(2)
        cage = (match.group(3) or "").upper()
        keep = f"{major}.{minor}{cage}"
        strip = f"{major}.{int(minor)}{cage}"
        variants.append(keep)
        if strip != keep:
            variants.append(strip)
    else:
        variants.append(core)

    out: list[str] = []
    seen: set[str] = set()
    for base in variants:
        for candidate in (base, f"M{base}"):
            norm = _norm_alnum(candidate)
            if norm and norm not in seen:
                seen.add(norm)
                out.append(norm)
    return out


def _port_number_from_grid(row_number: Any, row_letter: Any, position: Any) -> int | None:
    try:
        rn = int(row_number)
        pos = int(position)
    except Exception:
        return None
    letter = str(row_letter or "A").upper().strip()
    if letter not in {"A", "B", "C", "D"}:
        return None
    group = ord(letter) - ord("A")
    if rn < 1 or pos < 1:
        return None
    return (rn - 1) * 24 + (group * 6) + pos


def _port_number_from_label(label: str | None) -> int | None:
    txt = str(label or "").strip().upper()
    if not txt:
        return None
    if txt.isdigit():
        n = int(txt)
        return n if n > 0 else None
    match = re.match(r"^(\d+)([A-D])(\d+)$", txt)
    if not match:
        return None
    rn = int(match.group(1))
    letter = match.group(2)
    pos = int(match.group(3))
    return _port_number_from_grid(rn, letter, pos)


def _first_non_empty(payload: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, str):
            val = value.strip()
            if val:
                return val
            continue
        if value is not None:
            return value
    return None


def _resolve_install_fields(task_payload: dict[str, Any]) -> dict[str, Any]:
    switch_name = _first_non_empty(task_payload, ["switch_name"])
    switch_port = _first_non_empty(task_payload, ["switch_port"])

    a_patchpanel_id = _first_non_empty(task_payload, ["a_patchpanel_id", "a_side_pp_name", "a_side_pp_id"])
    a_port_label = _first_non_empty(task_payload, ["a_port_label", "a_side_port_label"])

    bb_in_instance = _first_non_empty(task_payload, ["bb_in_instance", "bb_in_pp_name", "bb_in_pp_instance"])
    bb_in_port = _first_non_empty(task_payload, ["bb_in_port", "bb_in_port_label", "bb_in_port_number"])

    bb_out_instance = _first_non_empty(task_payload, ["bb_out_instance", "bb_out_pp_name", "bb_out_pp_instance"])
    bb_out_port = _first_non_empty(task_payload, ["bb_out_port", "bb_out_port_label", "bb_out_port_number"])

    customer_patchpanel_id = _first_non_empty(task_payload, ["customer_patchpanel_id"])
    customer_port_label = _first_non_empty(task_payload, ["customer_port_label"])

    return {
        "switch_name": str(switch_name or "").strip(),
        "switch_port": str(switch_port or "").strip(),
        "a_patchpanel_id": str(a_patchpanel_id or "").strip(),
        "a_port_label": str(a_port_label or "").strip(),
        "bb_in_instance": str(bb_in_instance or "").strip(),
        "bb_in_port": str(bb_in_port or "").strip(),
        "bb_out_instance": str(bb_out_instance or "").strip(),
        "bb_out_port": str(bb_out_port or "").strip(),
        "customer_patchpanel_id": customer_patchpanel_id,
        "customer_port_label": str(customer_port_label or "").strip(),
        "rack_code": str(_first_non_empty(task_payload, ["rack_code", "rack_cage"]) or "").strip() or None,
        "z_pp_number": str(_first_non_empty(task_payload, ["z_pp_number"]) or "").strip() or None,
        "system_name": str(_first_non_empty(task_payload, ["system_name", "customer"]) or "").strip() or None,
    }


def _validate_install_task_payload(task_payload: dict[str, Any]) -> None:
    resolved = _resolve_install_fields(task_payload)

    if not resolved["switch_name"] or not resolved["switch_port"]:
        raise HTTPException(status_code=400, detail="Install payload missing RFRA switch mapping")
    if not resolved["a_patchpanel_id"] or not resolved["a_port_label"]:
        raise HTTPException(status_code=400, detail="Install payload missing A-side patchpanel mapping")
    if not resolved["bb_in_instance"] or not resolved["bb_in_port"]:
        raise HTTPException(status_code=400, detail="Install payload missing BB IN selection")
    if not resolved["bb_out_instance"] or not resolved["bb_out_port"]:
        raise HTTPException(status_code=400, detail="Install payload missing BB OUT mirror mapping")
    if not resolved["customer_patchpanel_id"] or not resolved["customer_port_label"]:
        raise HTTPException(status_code=400, detail="Install payload missing customer patchpanel/port")

    try:
        int(resolved["customer_patchpanel_id"])
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Install payload customer_patchpanel_id invalid") from exc


def _validate_task_payload(db: Session, plan_id: int, payload: KwTaskIn) -> tuple[str, str]:
    task_type = str(payload.type or "").strip().lower()
    if task_type not in TASK_TYPES:
        raise HTTPException(status_code=400, detail="Invalid task type")

    task_status = str(payload.status or DEFAULT_STATUS_BY_TYPE[task_type]).strip().lower()
    if task_status not in ALLOWED_TASK_STATUS:
        raise HTTPException(status_code=400, detail="Invalid task status")

    if task_type in {"deinstall", "move"}:
        if not payload.line_id:
            raise HTTPException(status_code=400, detail="line_id required for deinstall/move")
        line = _get_line_by_id(db, int(payload.line_id))
        if not line:
            raise HTTPException(status_code=404, detail="line_id not found")

        dup = db.execute(
            text(
                """
                SELECT id
                FROM public.kw_tasks
                WHERE plan_id = :plan_id
                  AND type = :type
                  AND line_id = :line_id
                  AND status <> 'cancelled'
                LIMIT 1
                """
            ),
            {"plan_id": int(plan_id), "type": task_type, "line_id": int(payload.line_id)},
        ).first()
        if dup:
            raise HTTPException(status_code=409, detail="Duplicate task for line in this KW")

    if task_type == "path_move":
        if not payload.line1_id or not payload.line2_id:
            raise HTTPException(status_code=400, detail="line1_id and line2_id required for path_move")
        if int(payload.line1_id) == int(payload.line2_id):
            raise HTTPException(status_code=400, detail="line1_id and line2_id must be different")

        line1 = _get_line_by_id(db, int(payload.line1_id))
        line2 = _get_line_by_id(db, int(payload.line2_id))
        if not line1 or not line2:
            raise HTTPException(status_code=404, detail="One or both lines not found")

        dup = db.execute(
            text(
                """
                SELECT id
                FROM public.kw_tasks
                WHERE plan_id = :plan_id
                  AND type = 'path_move'
                  AND status <> 'cancelled'
                  AND (
                    line1_id IN (:line1, :line2)
                    OR line2_id IN (:line1, :line2)
                  )
                LIMIT 1
                """
            ),
            {"plan_id": int(plan_id), "line1": int(payload.line1_id), "line2": int(payload.line2_id)},
        ).first()
        if dup:
            raise HTTPException(status_code=409, detail="Duplicate path_move for line in this KW")

    if task_type == "install":
        _validate_install_task_payload(payload.payload or {})
        serial = str((payload.payload or {}).get("serial") or "").strip()
        if serial:
            dup = db.execute(
                text(
                    """
                    SELECT id
                    FROM public.kw_tasks
                    WHERE plan_id = :plan_id
                      AND type = 'install'
                      AND status <> 'cancelled'
                      AND COALESCE(payload->>'serial', '') = :serial
                    LIMIT 1
                    """
                ),
                {"plan_id": int(plan_id), "serial": serial},
            ).first()
            if dup:
                raise HTTPException(status_code=409, detail="Duplicate install task for serial in this KW")

    return task_type, task_status


def _set_line_status(db: Session, line_id: int, status: str) -> None:
    updates = ["status = :status"]
    params: dict[str, Any] = {"id": int(line_id), "status": str(status)}
    if _has_column(db, "cross_connects", "updated_at"):
        updates.append("updated_at = NOW()")

    try:
        with db.begin_nested():
            db.execute(
                text("UPDATE public.cross_connects SET " + ", ".join(updates) + " WHERE id = :id"),
                params,
            )
    except Exception:
        if str(status).startswith("pending_"):
            return
        raise


def _status_from_payload(payload: dict[str, Any], key: str, default: str = "active") -> str:
    val = payload.get(key)
    if isinstance(val, str) and val.strip():
        return val.strip()
    return default


def _serialize_payload(payload: dict[str, Any]) -> str:
    def _default(value: Any):
        if hasattr(value, "isoformat"):
            try:
                return value.isoformat()
            except Exception:
                pass
        return str(value)

    return json.dumps(payload, ensure_ascii=False, default=_default)


def _serial_exists(db: Session, serial: str) -> bool:
    has_sn = _has_column(db, "cross_connects", "serial_number")
    where = "serial = :serial"
    if has_sn:
        where += " OR serial_number = :serial"

    row = db.execute(
        text(f"SELECT id FROM public.cross_connects WHERE {where} LIMIT 1"),
        {"serial": serial},
    ).first()
    return row is not None


def _create_install_cross_connect(db: Session, task_payload: dict[str, Any], serial: str, task_id: int) -> int:
    serial = serial.strip()
    if not serial:
        raise HTTPException(status_code=400, detail="Serial is required for install done")

    if _serial_exists(db, serial):
        raise HTTPException(status_code=409, detail="Serial already exists")

    _validate_install_task_payload(task_payload)
    resolved = _resolve_install_fields(task_payload)
    bb_in_instance = resolved["bb_in_instance"]
    bb_in_port = resolved["bb_in_port"]
    bb_out_instance = resolved["bb_out_instance"]
    bb_out_port = resolved["bb_out_port"]
    customer_patchpanel_id = resolved["customer_patchpanel_id"]
    customer_port_label = resolved["customer_port_label"]

    api_bb = {
        "backbone_in_instance_id": bb_in_instance,
        "backbone_in_port_label": bb_in_port,
        "backbone_out_instance_id": bb_out_instance,
        "backbone_out_port_label": bb_out_port,
    }
    db_bb = _swap_backbone_payload(dict(api_bb)) or {}

    values: dict[str, Any] = {
        "serial": serial,
        "switch_name": resolved["switch_name"] or "KW_INSTALL",
        "switch_port": resolved["switch_port"] or f"KW-{task_id}",
        "a_patchpanel_id": resolved["a_patchpanel_id"] or "KW_MANUAL",
        "a_port_label": resolved["a_port_label"] or "MANUAL",
        "backbone_out_instance_id": db_bb.get("backbone_out_instance_id"),
        "backbone_out_port_label": db_bb.get("backbone_out_port_label"),
        "backbone_in_instance_id": db_bb.get("backbone_in_instance_id"),
        "backbone_in_port_label": db_bb.get("backbone_in_port_label"),
        "customer_patchpanel_id": int(customer_patchpanel_id),
        "customer_port_label": customer_port_label,
        "status": "active",
        "rack_code": resolved["rack_code"],
        "z_pp_number": resolved["z_pp_number"],
        "system_name": resolved["system_name"],
    }

    cols = [
        "serial",
        "switch_name",
        "switch_port",
        "a_patchpanel_id",
        "a_port_label",
        "backbone_out_instance_id",
        "backbone_out_port_label",
        "backbone_in_instance_id",
        "backbone_in_port_label",
        "customer_patchpanel_id",
        "customer_port_label",
        "status",
    ]

    for optional_col in ["rack_code", "z_pp_number", "system_name"]:
        if _has_column(db, "cross_connects", optional_col):
            cols.append(optional_col)

    if _has_column(db, "cross_connects", "serial_number"):
        cols.append("serial_number")
        values["serial_number"] = serial
    if _has_column(db, "cross_connects", "product_id"):
        cols.append("product_id")
        values["product_id"] = str(task_payload.get("product_id") or serial)

    placeholders = [f":{c}" for c in cols]
    row = db.execute(
        text(
            "INSERT INTO public.cross_connects ("
            + ", ".join(cols)
            + ") VALUES ("
            + ", ".join(placeholders)
            + ") RETURNING id"
        ),
        {k: values.get(k) for k in cols},
    ).first()

    if not row:
        raise HTTPException(status_code=500, detail="Install done failed to create line")

    return int(row[0])


@router.get("/rfra/ports")
def list_rfra_ports(
    q: str = Query("", max_length=120),
    limit: int = Query(60, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    query = str(q or "").strip()
    params: dict[str, Any] = {"limit": int(limit)}
    where = ["UPPER(COALESCE(switch_name, '')) LIKE 'RFRA%'"]
    if query:
        params["q"] = f"%{query}%"
        where.append(
            "("
            "COALESCE(switch_name, '') ILIKE :q "
            "OR COALESCE(switch_port, '') ILIKE :q "
            "OR COALESCE(room, '') ILIKE :q "
            "OR COALESCE(patchpanel_id, '') ILIKE :q"
            ")"
        )

    rows = db.execute(
        text(
            f"""
            SELECT
                id,
                switch_name,
                switch_port,
                room,
                room_norm,
                patchpanel_id,
                patchpanel_port,
                patchpanel_pair
            FROM public.pre_cabled_links
            WHERE {' AND '.join(where)}
            ORDER BY switch_name, switch_port, id
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()

    items = []
    for row in rows:
        switch_name = str(row.get("switch_name") or "").strip()
        switch_port = str(row.get("switch_port") or "").strip()
        room = str(row.get("room") or row.get("room_norm") or "").strip()
        a_pp = str(row.get("patchpanel_id") or "").strip()
        a_port = str(row.get("patchpanel_port") or "").strip()
        rfra_name = f"{switch_name} {switch_port}".strip()
        items.append(
            {
                "id": int(row["id"]),
                "rfra_id": int(row["id"]),
                "rfra_name": rfra_name,
                "switch_name": switch_name,
                "switch_port": switch_port,
                "room": room,
                "a_side_pp_id": a_pp,
                "a_side_pp_name": a_pp,
                "a_side_port_label": a_port,
                "label": f"{rfra_name} | Raum {room or '-'} | A {a_pp or '-'}:{a_port or '-'}",
            }
        )

    return {"success": True, "items": items}


@router.get("/rfra/ports/{rfra_id}/bb-options")
def list_bb_options_for_rfra(
    rfra_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    rfra = db.execute(
        text(
            """
            SELECT
                id,
                switch_name,
                switch_port,
                room,
                room_norm,
                patchpanel_id,
                patchpanel_port
            FROM public.pre_cabled_links
            WHERE id = :id
            LIMIT 1
            """
        ),
        {"id": int(rfra_id)},
    ).mappings().first()
    if not rfra:
        raise HTTPException(status_code=404, detail="RFRA port not found")

    room = str(rfra.get("room") or rfra.get("room_norm") or "").strip()
    norms = _room_norm_variants(room)
    if not norms:
        return {
            "success": True,
            "rfra": {
                "rfra_id": int(rfra["id"]),
                "switch_name": rfra.get("switch_name"),
                "switch_port": rfra.get("switch_port"),
                "room": room,
            },
            "options": [],
        }

    params: dict[str, Any] = {}
    norm_keys: list[str] = []
    for idx, norm in enumerate(norms):
        key = f"n{idx}"
        params[key] = norm
        norm_keys.append(f":{key}")

    has_side = _has_column(db, "patchpanel_instances", "side")
    has_customer_id = _has_column(db, "patchpanel_instances", "customer_id")
    bb_filter = "TRUE"
    if has_side and has_customer_id:
        bb_filter = "(COALESCE(side, '') <> 'Z' OR customer_id IS NULL)"
    elif has_side:
        bb_filter = "(COALESCE(side, '') <> 'Z' OR side IS NULL)"
    elif has_customer_id:
        bb_filter = "customer_id IS NULL"

    rows = db.execute(
        text(
            f"""
            SELECT
                id,
                instance_id,
                room,
                rack_label,
                cage_no,
                rack_unit,
                total_ports,
                peer_instance_id,
                pp_number
            FROM public.patchpanel_instances
            WHERE regexp_replace(upper(COALESCE(room, '')), '[^A-Z0-9]', '', 'g') IN ({", ".join(norm_keys)})
              AND {bb_filter}
            ORDER BY rack_label NULLS LAST, rack_unit NULLS LAST, instance_id
            """
        ),
        params,
    ).mappings().all()

    options = []
    for row in rows:
        instance = str(row.get("instance_id") or "").strip()
        room_val = str(row.get("room") or "").strip()
        rack_unit = row.get("rack_unit")
        ru_match = re.search(r"(RU\d+)", instance, flags=re.IGNORECASE)
        ru = ru_match.group(1).upper() if ru_match else (f"RU{rack_unit}" if rack_unit else "-")
        peer = str(row.get("peer_instance_id") or "-").strip() or "-"
        cage = str(row.get("cage_no") or "").strip()
        pp_number = str(row.get("pp_number") or "").strip()
        label_parts = [instance or f"Patchpanel {row['id']}", f"Raum {room_val or '-'}", f"{ru}"]
        if cage:
            label_parts.append(f"Cage {cage}")
        if peer and peer != "-":
            label_parts.append(f"Peer {peer}")
        if pp_number:
            label_parts.append(f"PP {pp_number}")
        options.append(
            {
                "id": int(row["id"]),
                "bb_in_pp_id": int(row["id"]),
                "bb_in_pp_name": instance or f"Patchpanel {row['id']}",
                "instance_id": instance,
                "room": room_val,
                "rack_label": row.get("rack_label"),
                "cage_no": row.get("cage_no"),
                "rack_unit": rack_unit,
                "ports_total": row.get("total_ports"),
                "peer_instance_id": row.get("peer_instance_id"),
                "pp_number": row.get("pp_number"),
                "label": " | ".join(label_parts),
            }
        )

    return {
        "success": True,
        "rfra": {
            "rfra_id": int(rfra["id"]),
            "switch_name": rfra.get("switch_name"),
            "switch_port": rfra.get("switch_port"),
            "room": room,
            "a_side_pp_name": rfra.get("patchpanel_id"),
            "a_side_port_label": rfra.get("patchpanel_port"),
        },
        "options": options,
    }


@router.get("/bb/mirror")
def get_bb_mirror(
    pp_id: int = Query(..., ge=1),
    port: str = Query(..., min_length=1, max_length=30),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    port_raw = str(port or "").strip()
    if not port_raw:
        raise HTTPException(status_code=400, detail="port is required")

    port_norm = _norm_alnum(port_raw)
    port_num = _port_number_from_label(port_raw) or -1
    source_row = db.execute(
        text(
            """
            SELECT
                p.patchpanel_id,
                p.port_label,
                p.row_number,
                p.row_letter,
                p.position,
                p.peer_instance_id,
                p.peer_port_label,
                src.instance_id AS source_instance_id
            FROM public.patchpanel_ports p
            JOIN public.patchpanel_instances src ON src.id = p.patchpanel_id
            WHERE p.patchpanel_id = :pp_id
              AND (
                regexp_replace(upper(COALESCE(p.port_label, '')), '[^A-Z0-9]', '', 'g') = :port_norm
                OR (
                    :port_num > 0
                    AND (
                        (COALESCE(p.row_number, 1) - 1) * 24
                        + ((ASCII(upper(COALESCE(p.row_letter, 'A'))) - ASCII('A')) * 6)
                        + COALESCE(p.position, 1)
                    ) = :port_num
                )
              )
            LIMIT 1
            """
        ),
        {"pp_id": int(pp_id), "port_norm": port_norm, "port_num": int(port_num)},
    ).mappings().first()
    if not source_row:
        raise HTTPException(status_code=404, detail="BB IN port mapping not found")

    peer_instance = str(source_row.get("peer_instance_id") or "").strip()
    peer_port = str(source_row.get("peer_port_label") or "").strip()
    if not peer_instance or not peer_port:
        raise HTTPException(status_code=404, detail="No BB OUT mirror mapping for selected BB IN port")

    peer_panel = db.execute(
        text(
            """
            SELECT
                id,
                instance_id,
                room,
                rack_label,
                cage_no,
                rack_unit,
                total_ports
            FROM public.patchpanel_instances
            WHERE regexp_replace(upper(COALESCE(instance_id, '')), '[^A-Z0-9]', '', 'g')
                = regexp_replace(upper(:instance_id), '[^A-Z0-9]', '', 'g')
            LIMIT 1
            """
        ),
        {"instance_id": peer_instance},
    ).mappings().first()

    peer_port_row = None
    peer_port_number = _port_number_from_label(peer_port)
    if peer_panel:
        peer_port_row = db.execute(
            text(
                """
                SELECT row_number, row_letter, position, port_label
                FROM public.patchpanel_ports
                WHERE patchpanel_id = :ppid
                  AND regexp_replace(upper(COALESCE(port_label, '')), '[^A-Z0-9]', '', 'g')
                      = regexp_replace(upper(:port_label), '[^A-Z0-9]', '', 'g')
                LIMIT 1
                """
            ),
            {"ppid": int(peer_panel["id"]), "port_label": peer_port},
        ).mappings().first()
        if peer_port_row:
            peer_port_number = _port_number_from_grid(
                peer_port_row.get("row_number"),
                peer_port_row.get("row_letter"),
                peer_port_row.get("position"),
            ) or peer_port_number

    in_port_number = _port_number_from_grid(
        source_row.get("row_number"),
        source_row.get("row_letter"),
        source_row.get("position"),
    ) or _port_number_from_label(str(source_row.get("port_label") or ""))

    return {
        "success": True,
        "mirror_exists": True,
        "bb_in": {
            "patchpanel_id": int(source_row["patchpanel_id"]),
            "patchpanel_name": source_row.get("source_instance_id"),
            "port_label": source_row.get("port_label"),
            "port_number": in_port_number,
        },
        "bb_out": {
            "patchpanel_id": int(peer_panel["id"]) if peer_panel else None,
            "patchpanel_name": peer_panel.get("instance_id") if peer_panel else peer_instance,
            "room": peer_panel.get("room") if peer_panel else None,
            "rack_label": peer_panel.get("rack_label") if peer_panel else None,
            "cage_no": peer_panel.get("cage_no") if peer_panel else None,
            "port_label": peer_port,
            "port_number": peer_port_number,
        },
    }


@router.post("/kw-plans")
def upsert_kw_plan(
    payload: KwPlanIn,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    existing = db.execute(
        text(
            """
            SELECT id, year, kw, status, created_by, created_at, completed_at, archived_at
            FROM public.kw_plans
            WHERE year = :year AND kw = :kw
            LIMIT 1
            """
        ),
        {"year": int(payload.year), "kw": int(payload.kw)},
    ).mappings().first()

    if existing:
        return {"success": True, "created": False, "plan": _plan_to_dict(dict(existing))}

    user_id = current_user.get("id") if isinstance(current_user, dict) else None

    try:
        row = db.execute(
            text(
                """
                INSERT INTO public.kw_plans (year, kw, status, created_by)
                VALUES (:year, :kw, 'active', :created_by)
                RETURNING id, year, kw, status, created_by, created_at, completed_at, archived_at
                """
            ),
            {"year": int(payload.year), "kw": int(payload.kw), "created_by": user_id},
        ).mappings().first()
        return {"success": True, "created": True, "plan": _plan_to_dict(dict(row))}
    except Exception:
        row = db.execute(
            text(
                """
                SELECT id, year, kw, status, created_by, created_at, completed_at, archived_at
                FROM public.kw_plans
                WHERE year = :year AND kw = :kw
                LIMIT 1
                """
            ),
            {"year": int(payload.year), "kw": int(payload.kw)},
        ).mappings().first()
        if row:
            return {"success": True, "created": False, "plan": _plan_to_dict(dict(row))}
        raise


@router.get("/kw-plans")
def list_kw_plans(
    status: str | None = Query(default=None, description="single or comma-separated status list"),
    year: int | None = Query(default=None, ge=2000, le=2100),
    kw: int | None = Query(default=None, ge=1, le=53),
    limit: int = Query(default=300, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    where: list[str] = []
    params: dict[str, Any] = {"limit": int(limit)}

    if year is not None:
        where.append("p.year = :year")
        params["year"] = int(year)
    if kw is not None:
        where.append("p.kw = :kw")
        params["kw"] = int(kw)

    if status is not None:
        status_values = [str(s).strip().lower() for s in str(status).split(",") if str(s).strip()]
        if not status_values:
            raise HTTPException(status_code=400, detail="Invalid status filter")
        invalid = [s for s in status_values if s not in PLAN_STATUS_ALLOWED]
        if invalid:
            raise HTTPException(status_code=400, detail=f"Invalid plan status: {', '.join(invalid)}")
        placeholders: list[str] = []
        for idx, value in enumerate(status_values):
            key = f"status_{idx}"
            placeholders.append(f":{key}")
            params[key] = value
        where.append("LOWER(COALESCE(p.status, 'active')) IN (" + ", ".join(placeholders) + ")")

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    rows = db.execute(
        text(
            f"""
            SELECT
                p.id,
                p.year,
                p.kw,
                COALESCE(NULLIF(TRIM(p.status), ''), 'active') AS status,
                p.created_by,
                p.created_at,
                p.completed_at,
                p.archived_at,
                COUNT(t.id) AS tasks_total,
                COUNT(*) FILTER (
                    WHERE t.status IN ('pending_install', 'pending_deinstall', 'pending_move', 'pending_path_move')
                ) AS pending_tasks
            FROM public.kw_plans p
            LEFT JOIN public.kw_tasks t ON t.plan_id = p.id
            {where_sql}
            GROUP BY p.id, p.year, p.kw, p.status, p.created_by, p.created_at, p.completed_at, p.archived_at
            ORDER BY p.year DESC, p.kw DESC, p.id DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()

    return {"success": True, "items": [_plan_to_dict(dict(r)) for r in rows]}


@router.get("/kw-plans/{plan_id}")
def get_kw_plan(
    plan_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    plan = _get_plan_row(db, int(plan_id), for_update=False)

    if not plan:
        raise HTTPException(status_code=404, detail="KW plan not found")

    rows = db.execute(
        text(
            """
            SELECT id, plan_id, type, status, line_id, line1_id, line2_id, payload, created_by, created_at, updated_at
            FROM public.kw_tasks
            WHERE plan_id = :plan_id
            ORDER BY created_at DESC, id DESC
            """
        ),
        {"plan_id": int(plan_id)},
    ).mappings().all()

    return {
        "success": True,
        "plan": _plan_to_dict(dict(plan)),
        "tasks": [_task_to_dict(dict(r)) for r in rows],
    }


@router.post("/kw-plans/{plan_id}/tasks")
def create_kw_task(
    payload: KwTaskIn,
    plan_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    plan_row = _get_plan_row(db, int(plan_id), for_update=False)
    if not plan_row:
        raise HTTPException(status_code=404, detail="KW plan not found")
    _assert_plan_editable(plan_row)

    task_type, task_status = _validate_task_payload(db, int(plan_id), payload)
    user_id = current_user.get("id") if isinstance(current_user, dict) else None
    task_payload = dict(payload.payload or {})

    if task_type in {"deinstall", "move"} and payload.line_id:
        line = _get_line_by_id(db, int(payload.line_id))
        if line:
            task_payload.setdefault("snapshot_before", line)
            task_payload.setdefault("snapshot_previous_status", line.get("status") or "active")
            _set_line_status(db, int(payload.line_id), DEFAULT_STATUS_BY_TYPE[task_type])

    if task_type == "path_move" and payload.line1_id and payload.line2_id:
        line1 = _get_line_by_id(db, int(payload.line1_id))
        line2 = _get_line_by_id(db, int(payload.line2_id))
        task_payload.setdefault(
            "snapshot_before",
            {
                "line1": line1,
                "line2": line2,
            },
        )
        task_payload.setdefault(
            "snapshot_previous_status",
            {
                "line1": (line1 or {}).get("status") or "active",
                "line2": (line2 or {}).get("status") or "active",
            },
        )
        _set_line_status(db, int(payload.line1_id), DEFAULT_STATUS_BY_TYPE[task_type])
        _set_line_status(db, int(payload.line2_id), DEFAULT_STATUS_BY_TYPE[task_type])

    row = db.execute(
        text(
            """
            INSERT INTO public.kw_tasks (
                plan_id, type, status, line_id, line1_id, line2_id, payload, created_by
            )
            VALUES (
                :plan_id, :type, :status, :line_id, :line1_id, :line2_id, CAST(:payload AS jsonb), :created_by
            )
            RETURNING id, plan_id, type, status, line_id, line1_id, line2_id, payload, created_by, created_at, updated_at
            """
        ),
        {
            "plan_id": int(plan_id),
            "type": task_type,
            "status": task_status,
            "line_id": int(payload.line_id) if payload.line_id else None,
            "line1_id": int(payload.line1_id) if payload.line1_id else None,
            "line2_id": int(payload.line2_id) if payload.line2_id else None,
            "payload": _serialize_payload(task_payload),
            "created_by": user_id,
        },
    ).mappings().first()

    return {"success": True, "task": _task_to_dict(dict(row))}


@router.patch("/kw-plans/{plan_id}/tasks/{task_id}")
def update_kw_task(
    payload: KwTaskUpdateIn,
    plan_id: int = Path(..., ge=1),
    task_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)
    plan_row = _get_plan_row(db, int(plan_id), for_update=False)
    if not plan_row:
        raise HTTPException(status_code=404, detail="KW plan not found")
    _assert_plan_editable(plan_row)

    row = db.execute(
        text(
            """
            SELECT id, plan_id, type, status, line_id, line1_id, line2_id, payload, created_by, created_at, updated_at
            FROM public.kw_tasks
            WHERE id = :task_id AND plan_id = :plan_id
            LIMIT 1
            """
        ),
        {"task_id": int(task_id), "plan_id": int(plan_id)},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")

    updates = []
    params: dict[str, Any] = {"task_id": int(task_id), "plan_id": int(plan_id)}

    if payload.status is not None:
        status_value = str(payload.status).strip().lower()
        if status_value not in ALLOWED_TASK_STATUS:
            raise HTTPException(status_code=400, detail="Invalid task status")
        updates.append("status = :status")
        params["status"] = status_value

    if payload.payload is not None:
        updates.append("payload = CAST(:payload AS jsonb)")
        params["payload"] = _serialize_payload(payload.payload)

    if not updates:
        return {"success": True, "task": _task_to_dict(dict(row))}

    updates.append("updated_at = NOW()")
    updated = db.execute(
        text(
            "UPDATE public.kw_tasks SET "
            + ", ".join(updates)
            + " WHERE id = :task_id AND plan_id = :plan_id "
            + "RETURNING id, plan_id, type, status, line_id, line1_id, line2_id, payload, created_by, created_at, updated_at"
        ),
        params,
    ).mappings().first()

    return {"success": True, "task": _task_to_dict(dict(updated))}

@router.delete("/kw-plans/{plan_id}/tasks/{task_id}")
def delete_kw_task(
    plan_id: int = Path(..., ge=1),
    task_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)
    plan_row = _get_plan_row(db, int(plan_id), for_update=False)
    if not plan_row:
        raise HTTPException(status_code=404, detail="KW plan not found")
    _assert_plan_editable(plan_row)

    row = db.execute(
        text(
            """
            SELECT id, plan_id, type, status, line_id, line1_id, line2_id, payload
            FROM public.kw_tasks
            WHERE id = :task_id AND plan_id = :plan_id
            LIMIT 1
            """
        ),
        {"task_id": int(task_id), "plan_id": int(plan_id)},
    ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")

    task = dict(row)
    task_type = str(task.get("type") or "").lower()
    task_status = str(task.get("status") or "").lower()
    task_payload = task.get("payload") or {}

    pending_states = {
        "pending_install",
        "pending_deinstall",
        "pending_move",
        "pending_path_move",
    }

    if task_status in pending_states:
        if task_type in {"deinstall", "move"} and task.get("line_id"):
            prev = _status_from_payload(task_payload, "snapshot_previous_status", "active")
            _set_line_status(db, int(task["line_id"]), prev)

        if task_type == "path_move":
            snap = task_payload.get("snapshot_previous_status") or {}
            if task.get("line1_id"):
                _set_line_status(db, int(task["line1_id"]), str(snap.get("line1") or "active"))
            if task.get("line2_id"):
                _set_line_status(db, int(task["line2_id"]), str(snap.get("line2") or "active"))

    db.execute(
        text("DELETE FROM public.kw_tasks WHERE id = :task_id AND plan_id = :plan_id"),
        {"task_id": int(task_id), "plan_id": int(plan_id)},
    )

    return {"success": True, "deleted": True}


@router.post("/kw-tasks/{task_id}/done")
def mark_kw_task_done(
    payload: DoneIn,
    task_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    task_row = db.execute(
        text(
            """
            SELECT
                t.id,
                t.plan_id,
                t.type,
                t.status,
                t.line_id,
                t.line1_id,
                t.line2_id,
                t.payload,
                p.status AS plan_status
            FROM public.kw_tasks t
            JOIN public.kw_plans p ON p.id = t.plan_id
            WHERE t.id = :id
            FOR UPDATE
            """
        ),
        {"id": int(task_id)},
    ).mappings().first()

    if not task_row:
        raise HTTPException(status_code=404, detail="Task not found")

    task = dict(task_row)
    if _is_plan_read_only(task.get("plan_status")):
        raise HTTPException(status_code=403, detail="KW plan is read-only (completed/archived)")

    task_type = str(task.get("type") or "").lower()
    task_payload = dict(task.get("payload") or {})

    if str(task.get("status") or "").lower() == "done":
        return {
            "success": True,
            "task_id": int(task_id),
            "status": "done",
            "applied": False,
            "created_line_id": task.get("line_id"),
        }

    created_line_id: int | None = None

    if payload.apply:
        if task_type == "install":
            serial = str(payload.serial or task_payload.get("serial") or "").strip()
            if not serial:
                raise HTTPException(status_code=400, detail="Serial is required for install done")
            created_line_id = _create_install_cross_connect(db, task_payload, serial, int(task_id))
            task_payload["serial"] = serial
            task_payload["created_line_id"] = int(created_line_id)

        elif task_type == "deinstall":
            line_id = task.get("line_id")
            if not line_id:
                raise HTTPException(status_code=400, detail="deinstall task has no line_id")
            _set_line_status(db, int(line_id), "deinstalled")

        elif task_type == "move":
            line_id = task.get("line_id")
            if not line_id:
                raise HTTPException(status_code=400, detail="move task has no line_id")

            new_side = (task_payload or {}).get("new_z_side") or {}
            pp_id = new_side.get("customer_patchpanel_id")
            port = str(new_side.get("customer_port_label") or "").strip()
            if not pp_id or not port:
                raise HTTPException(status_code=400, detail="move task payload.new_z_side is incomplete")

            updates = [
                "customer_patchpanel_id = :pp_id",
                "customer_port_label = :port",
                "status = 'active'",
            ]
            params: dict[str, Any] = {
                "id": int(line_id),
                "pp_id": int(pp_id),
                "port": port,
            }
            if "z_pp_number" in new_side and _has_column(db, "cross_connects", "z_pp_number"):
                updates.append("z_pp_number = :z_pp_number")
                params["z_pp_number"] = new_side.get("z_pp_number")
            if "rack_code" in new_side and _has_column(db, "cross_connects", "rack_code"):
                updates.append("rack_code = :rack_code")
                params["rack_code"] = new_side.get("rack_code")
            if _has_column(db, "cross_connects", "updated_at"):
                updates.append("updated_at = NOW()")

            db.execute(
                text("UPDATE public.cross_connects SET " + ", ".join(updates) + " WHERE id = :id"),
                params,
            )

        elif task_type == "path_move":
            line1_id = task.get("line1_id")
            line2_id = task.get("line2_id")
            if not line1_id or not line2_id:
                raise HTTPException(status_code=400, detail="path_move task missing line ids")

            row1 = db.execute(
                text("SELECT * FROM public.cross_connects WHERE id = :id FOR UPDATE"),
                {"id": int(line1_id)},
            ).mappings().first()
            row2 = db.execute(
                text("SELECT * FROM public.cross_connects WHERE id = :id FOR UPDATE"),
                {"id": int(line2_id)},
            ).mappings().first()
            if not row1 or not row2:
                raise HTTPException(status_code=404, detail="path_move lines not found")

            line1 = _swap_backbone_fields(dict(row1)) or {}
            line2 = _swap_backbone_fields(dict(row2)) or {}

            line1_new = dict(line1)
            line2_new = dict(line2)
            line1_new["backbone_in_instance_id"] = line2.get("backbone_in_instance_id")
            line1_new["backbone_in_port_label"] = line2.get("backbone_in_port_label")
            line1_new["backbone_out_instance_id"] = line2.get("backbone_out_instance_id")
            line1_new["backbone_out_port_label"] = line2.get("backbone_out_port_label")

            line2_new["backbone_in_instance_id"] = line1.get("backbone_in_instance_id")
            line2_new["backbone_in_port_label"] = line1.get("backbone_in_port_label")
            line2_new["backbone_out_instance_id"] = line1.get("backbone_out_instance_id")
            line2_new["backbone_out_port_label"] = line1.get("backbone_out_port_label")

            line1_db = _swap_backbone_payload(line1_new) or {}
            line2_db = _swap_backbone_payload(line2_new) or {}

            updates = [
                "backbone_in_instance_id = :bi_i",
                "backbone_in_port_label = :bi_p",
                "backbone_out_instance_id = :bo_i",
                "backbone_out_port_label = :bo_p",
                "status = 'active'",
            ]
            if _has_column(db, "cross_connects", "updated_at"):
                updates.append("updated_at = NOW()")
            set_sql = ", ".join(updates)

            db.execute(
                text(f"UPDATE public.cross_connects SET {set_sql} WHERE id = :id"),
                {
                    "id": int(line1_id),
                    "bi_i": line1_db.get("backbone_in_instance_id"),
                    "bi_p": line1_db.get("backbone_in_port_label"),
                    "bo_i": line1_db.get("backbone_out_instance_id"),
                    "bo_p": line1_db.get("backbone_out_port_label"),
                },
            )
            db.execute(
                text(f"UPDATE public.cross_connects SET {set_sql} WHERE id = :id"),
                {
                    "id": int(line2_id),
                    "bi_i": line2_db.get("backbone_in_instance_id"),
                    "bi_p": line2_db.get("backbone_in_port_label"),
                    "bo_i": line2_db.get("backbone_out_instance_id"),
                    "bo_p": line2_db.get("backbone_out_port_label"),
                },
            )

    task_updates = ["status = 'done'", "updated_at = NOW()"]
    params: dict[str, Any] = {"id": int(task_id)}

    if task_type == "install" and created_line_id:
        task_updates.append("line_id = :line_id")
        params["line_id"] = int(created_line_id)
        task_updates.append("payload = CAST(:payload AS jsonb)")
        params["payload"] = _serialize_payload(task_payload)

    db.execute(
        text("UPDATE public.kw_tasks SET " + ", ".join(task_updates) + " WHERE id = :id"),
        params,
    )

    return {
        "success": True,
        "task_id": int(task_id),
        "status": "done",
        "applied": bool(payload.apply),
        "created_line_id": created_line_id,
    }


@router.post("/kw-plans/{plan_id}/complete")
def complete_kw_plan(
    plan_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    plan = _get_plan_row(db, int(plan_id), for_update=True)
    if not plan:
        raise HTTPException(status_code=404, detail="KW plan not found")

    status = str(plan.get("status") or "active").strip().lower() or "active"
    if status == "archived":
        raise HTTPException(status_code=400, detail="Archived plan cannot be completed again")
    if status == "completed":
        return {"success": True, "completed": False, "plan": _plan_to_dict(plan)}

    db.execute(
        text(
            """
            UPDATE public.kw_plans
            SET status = 'completed',
                completed_at = COALESCE(completed_at, NOW())
            WHERE id = :id
            """
        ),
        {"id": int(plan_id)},
    )
    updated = _get_plan_row(db, int(plan_id), for_update=False)
    return {"success": True, "completed": True, "plan": _plan_to_dict(updated or plan)}


@router.post("/kw-plans/{plan_id}/archive")
def archive_kw_plan(
    plan_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    plan = _get_plan_row(db, int(plan_id), for_update=True)
    if not plan:
        raise HTTPException(status_code=404, detail="KW plan not found")

    status = str(plan.get("status") or "active").strip().lower() or "active"
    if status == "archived":
        return {"success": True, "archived": False, "plan": _plan_to_dict(plan)}

    db.execute(
        text(
            """
            UPDATE public.kw_plans
            SET status = 'archived',
                archived_at = COALESCE(archived_at, NOW())
            WHERE id = :id
            """
        ),
        {"id": int(plan_id)},
    )
    updated = _get_plan_row(db, int(plan_id), for_update=False)
    return {"success": True, "archived": True, "plan": _plan_to_dict(updated or plan)}


@router.get("/lines/by-serial/{serial}")
def get_line_by_serial(
    serial: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    line = _get_line_by_serial(db, serial)
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")
    return {"success": True, "line": line}


@router.get("/dashboard/stats")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_kw_tables(db)

    counts = db.execute(
        text(
            """
            SELECT
                COUNT(*) FILTER (WHERE status = 'active') AS active_lines
            FROM public.cross_connects
            """
        )
    ).mappings().first()

    task_counts = db.execute(
        text(
            """
            SELECT
                COUNT(*) FILTER (WHERE status = 'pending_install') AS pending_install,
                COUNT(*) FILTER (WHERE status = 'pending_deinstall') AS pending_deinstall,
                COUNT(*) FILTER (WHERE status = 'pending_move') AS pending_move,
                COUNT(*) FILTER (WHERE status = 'pending_path_move') AS pending_path_move
            FROM public.kw_tasks
            """
        )
    ).mappings().first()

    today = date.today()
    iso = today.isocalendar()
    current_year = int(iso.year)
    current_kw = int(iso.week)

    kw_pending = db.execute(
        text(
            """
            Select COUNT(*)
            FROM public.kw_tasks t
            JOIN public.kw_plans p ON p.id = t.plan_id
            WHERE p.year = :year
              AND p.kw = :kw
              AND t.status IN (
                'pending_install',
                'pending_deinstall',
                'pending_move',
                'pending_path_move'
              )
            """
        ),
        {"year": current_year, "kw": current_kw},
    ).scalar() or 0

    # ---- kw_changes counts for current week (used by kw_flow / new KW-Planung) ----
    kw_changes_counts = {}
    try:
        kw_changes_counts = dict(
            db.execute(
                text(
                    """
                    SELECT
                        COUNT(*) FILTER (WHERE c.type = 'NEW_INSTALL')   AS kw_install,
                        COUNT(*) FILTER (WHERE c.type = 'DEINSTALL')     AS kw_deinstall,
                        COUNT(*) FILTER (WHERE c.type = 'LINE_MOVE')     AS kw_linemove,
                        COUNT(*) FILTER (WHERE c.type = 'PATH_MOVE')     AS kw_pathmove,
                        COUNT(*) FILTER (WHERE c.status = 'done')        AS kw_done,
                        COUNT(*) FILTER (WHERE c.status IN ('planned','in_progress')) AS kw_open
                    FROM public.kw_changes c
                    JOIN public.kw_plans p ON p.id = c.kw_plan_id
                    WHERE p.year = :year AND p.kw = :kw
                    """
                ),
                {"year": current_year, "kw": current_kw},
            ).mappings().first()
            or {}
        )
    except Exception:
        pass

    c = dict(counts or {})
    tc = dict(task_counts or {})
    return {
        "success": True,
        "stats": {
            "active_lines": int(c.get("active_lines") or 0),
            "pending_install": int(tc.get("pending_install") or 0),
            "pending_deinstall": int(tc.get("pending_deinstall") or 0),
            "pending_move": int(tc.get("pending_move") or 0),
            "pending_path_move": int(tc.get("pending_path_move") or 0),
            "current_kw_pending_tasks": int(kw_pending),
            "current_kw": {"year": current_year, "kw": current_kw},
            "kw_install": int(kw_changes_counts.get("kw_install") or 0),
            "kw_deinstall": int(kw_changes_counts.get("kw_deinstall") or 0),
            "kw_linemove": int(kw_changes_counts.get("kw_linemove") or 0),
            "kw_pathmove": int(kw_changes_counts.get("kw_pathmove") or 0),
            "kw_done": int(kw_changes_counts.get("kw_done") or 0),
            "kw_open": int(kw_changes_counts.get("kw_open") or 0),
        },
    }


# ---------------------------------------------------------------------------
# Quarterly Report
# ---------------------------------------------------------------------------

def _quarter_kw_ranges(year: int, quarter: int) -> tuple[list[int], date, date]:
    """Return (list_of_iso_weeks, q_start_date, q_end_date) for a given quarter."""
    import datetime as _dt
    q_months = {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)}
    m_start, m_end = q_months[quarter]
    q_start = _dt.date(year, m_start, 1)
    if m_end == 12:
        q_end = _dt.date(year, 12, 31)
    else:
        q_end = _dt.date(year, m_end + 1, 1) - _dt.timedelta(days=1)
    # Collect all ISO weeks that overlap with the quarter
    weeks = set()
    d = q_start
    while d <= q_end:
        iso = d.isocalendar()
        weeks.add(iso.week)
        d += _dt.timedelta(days=1)
    return sorted(weeks), q_start, q_end


@router.get("/dashboard/quarterly")
def get_quarterly_report(
    year: int = Query(None),
    quarter: int = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Quarterly performance report: totals per type, per KW breakdown, per technician."""
    _ensure_kw_tables(db)

    today = date.today()
    if not year:
        year = today.year
    if not quarter:
        quarter = (today.month - 1) // 3 + 1

    kw_list, q_start, q_end = _quarter_kw_ranges(year, quarter)

    # ── 1. Totals per type for the quarter ──
    totals_row = db.execute(
        text(
            """
            SELECT
                COUNT(*) FILTER (WHERE c.type = 'NEW_INSTALL' AND c.status = 'done')   AS install,
                COUNT(*) FILTER (WHERE c.type = 'DEINSTALL'   AND c.status = 'done')   AS deinstall,
                COUNT(*) FILTER (WHERE c.type = 'LINE_MOVE'   AND c.status = 'done')   AS linemove,
                COUNT(*) FILTER (WHERE c.type = 'PATH_MOVE'   AND c.status = 'done')   AS pathmove,
                COUNT(*) FILTER (WHERE c.status = 'done')                               AS total_done,
                COUNT(*) FILTER (WHERE c.status = 'planned')                            AS total_planned,
                COUNT(*) FILTER (WHERE c.status = 'canceled')                           AS total_canceled,
                COUNT(*)                                                                 AS total_all
            FROM public.kw_changes c
            JOIN public.kw_plans p ON p.id = c.kw_plan_id
            WHERE p.year = :year AND p.kw = ANY(:kws)
            """
        ),
        {"year": year, "kws": kw_list},
    ).mappings().first()
    totals = dict(totals_row) if totals_row else {}

    # ── 2. Per-KW breakdown ──
    kw_rows = db.execute(
        text(
            """
            SELECT
                p.kw,
                COUNT(*) FILTER (WHERE c.type = 'NEW_INSTALL' AND c.status = 'done') AS install,
                COUNT(*) FILTER (WHERE c.type = 'DEINSTALL'   AND c.status = 'done') AS deinstall,
                COUNT(*) FILTER (WHERE c.type = 'LINE_MOVE'   AND c.status = 'done') AS linemove,
                COUNT(*) FILTER (WHERE c.type = 'PATH_MOVE'   AND c.status = 'done') AS pathmove,
                COUNT(*) FILTER (WHERE c.status = 'done')                             AS done,
                COUNT(*)                                                               AS total
            FROM public.kw_changes c
            JOIN public.kw_plans p ON p.id = c.kw_plan_id
            WHERE p.year = :year AND p.kw = ANY(:kws)
            GROUP BY p.kw
            ORDER BY p.kw
            """
        ),
        {"year": year, "kws": kw_list},
    ).mappings().all()
    per_kw = [dict(r) for r in kw_rows]

    # ── 3. Per-technician breakdown (who completed what) ──
    tech_rows = db.execute(
        text(
            """
            SELECT
                COALESCE(u.username, 'unbekannt') AS technician,
                COUNT(*) FILTER (WHERE c.type = 'NEW_INSTALL') AS install,
                COUNT(*) FILTER (WHERE c.type = 'DEINSTALL')   AS deinstall,
                COUNT(*) FILTER (WHERE c.type = 'LINE_MOVE')   AS linemove,
                COUNT(*) FILTER (WHERE c.type = 'PATH_MOVE')   AS pathmove,
                COUNT(*)                                        AS total
            FROM public.kw_changes c
            JOIN public.kw_plans p ON p.id = c.kw_plan_id
            LEFT JOIN public.users u ON u.id = c.completed_by
            WHERE p.year = :year AND p.kw = ANY(:kws)
              AND c.status = 'done'
            GROUP BY u.username
            ORDER BY COUNT(*) DESC
            """
        ),
        {"year": year, "kws": kw_list},
    ).mappings().all()
    per_tech = [dict(r) for r in tech_rows]

    # ── 4. Per-technician per-KW detail (for sparkline / detail view) ──
    tech_kw_rows = db.execute(
        text(
            """
            SELECT
                COALESCE(u.username, 'unbekannt') AS technician,
                p.kw,
                c.type,
                COUNT(*) AS cnt
            FROM public.kw_changes c
            JOIN public.kw_plans p ON p.id = c.kw_plan_id
            LEFT JOIN public.users u ON u.id = c.completed_by
            WHERE p.year = :year AND p.kw = ANY(:kws)
              AND c.status = 'done'
            GROUP BY u.username, p.kw, c.type
            ORDER BY u.username, p.kw, c.type
            """
        ),
        {"year": year, "kws": kw_list},
    ).mappings().all()
    tech_kw = [dict(r) for r in tech_kw_rows]

    # ── 5. Previous quarter comparison (for trend arrows) ──
    prev_q = quarter - 1
    prev_y = year
    if prev_q < 1:
        prev_q = 4
        prev_y = year - 1
    prev_kw_list, _, _ = _quarter_kw_ranges(prev_y, prev_q)
    prev_totals_row = db.execute(
        text(
            """
            SELECT
                COUNT(*) FILTER (WHERE c.type = 'NEW_INSTALL' AND c.status = 'done') AS install,
                COUNT(*) FILTER (WHERE c.type = 'DEINSTALL'   AND c.status = 'done') AS deinstall,
                COUNT(*) FILTER (WHERE c.type = 'LINE_MOVE'   AND c.status = 'done') AS linemove,
                COUNT(*) FILTER (WHERE c.type = 'PATH_MOVE'   AND c.status = 'done') AS pathmove,
                COUNT(*) FILTER (WHERE c.status = 'done')                             AS total_done
            FROM public.kw_changes c
            JOIN public.kw_plans p ON p.id = c.kw_plan_id
            WHERE p.year = :year AND p.kw = ANY(:kws)
            """
        ),
        {"year": prev_y, "kws": prev_kw_list},
    ).mappings().first()
    prev = dict(prev_totals_row) if prev_totals_row else {}

    return {
        "success": True,
        "year": year,
        "quarter": quarter,
        "label": f"Q{quarter} {year}",
        "kw_range": kw_list,
        "totals": {
            "install": int(totals.get("install") or 0),
            "deinstall": int(totals.get("deinstall") or 0),
            "linemove": int(totals.get("linemove") or 0),
            "pathmove": int(totals.get("pathmove") or 0),
            "total_done": int(totals.get("total_done") or 0),
            "total_planned": int(totals.get("total_planned") or 0),
            "total_canceled": int(totals.get("total_canceled") or 0),
            "total_all": int(totals.get("total_all") or 0),
        },
        "prev_quarter": {
            "label": f"Q{prev_q} {prev_y}",
            "install": int(prev.get("install") or 0),
            "deinstall": int(prev.get("deinstall") or 0),
            "linemove": int(prev.get("linemove") or 0),
            "pathmove": int(prev.get("pathmove") or 0),
            "total_done": int(prev.get("total_done") or 0),
        },
        "per_kw": per_kw,
        "per_technician": per_tech,
        "technician_kw_detail": tech_kw,
    }
