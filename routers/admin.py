"""Admin router – V1 user management, role/permission CRUD, audit log."""

from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from audit import write_audit_log
from database import get_db
from security import (
    PERMISSIONS,
    ROLE_BASE_PERMISSIONS,
    get_effective_permissions,
    hash_password,
    is_admin_role,
    normalize_role,
    require_permissions,
)

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class CreateUserIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    full_name: Optional[str] = Field(None, max_length=200)
    email: Optional[str] = Field(None, max_length=200)
    password: Optional[str] = Field(None, min_length=1, max_length=200)
    role: str = "viewer"
    is_active: bool = True
    force_password_change: bool = True


class UpdateUserIn(BaseModel):
    full_name: Optional[str] = Field(None, max_length=200)
    email: Optional[str] = Field(None, max_length=200)
    role: Optional[str] = None
    is_active: Optional[bool] = None
    force_password_change: Optional[bool] = None


class RoleUpdateIn(BaseModel):
    role: str


class PasswordResetIn(BaseModel):
    new_password: Optional[str] = Field(None, min_length=1, max_length=200)


class GrantIn(BaseModel):
    permission: str
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None


class RevokeIn(BaseModel):
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_admin_user(current_user: Dict[str, Any]) -> None:
    if not is_admin_role(current_user.get("role")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def _is_super_admin(user: Dict[str, Any]) -> bool:
    """The built-in 'admin' account is the only super-admin."""
    return str(user.get("username") or "").lower() == "admin"


def _guard_admin_target(actor: Dict[str, Any], target: Dict[str, Any], action: str) -> None:
    """Prevent normal admins from touching other admin accounts.

    Rules:
      - The super-admin ('admin') may do anything.
      - A normal admin may NOT reset-password / delete / deactivate another admin.
    """
    if _is_super_admin(actor):
        return  # super-admin can do everything

    target_role = normalize_role(target.get("role"))
    if target_role in ("admin", "superadmin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Nur der Super-Admin darf Admin-Konten {action}.",
        )


def _get_user_by_id(db: Session, user_id: int) -> Dict[str, Any] | None:
    row = db.execute(
        text(
            """
            SELECT id, username, full_name, email, role, is_active,
                   force_password_change, last_login, created_at
            FROM public.users_new
            WHERE id = :id
            LIMIT 1
            """
        ),
        {"id": int(user_id)},
    ).mappings().first()
    if not row:
        return None
    return {
        "id": int(row.get("id")),
        "username": row.get("username"),
        "full_name": row.get("full_name"),
        "email": row.get("email"),
        "role": normalize_role(row.get("role")),
        "is_active": bool(row.get("is_active", True)),
        "force_password_change": bool(row.get("force_password_change", False)),
        "last_login": row.get("last_login"),
        "created_at": row.get("created_at"),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/ping")
def admin_ping(current_user=Depends(require_permissions("admin.settings", allow_roles={"admin", "superadmin"}))):
    return {"ok": True, "message": "admin api"}


@router.get("/users")
def list_users(
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    db.rollback()
    rows = db.execute(
        text(
            """
            SELECT id, username, full_name, email, role, is_active,
                   force_password_change, last_login, created_at
            FROM public.users_new
            ORDER BY id ASC
            """
        )
    ).mappings().all()

    items: List[Dict[str, Any]] = []
    for r in rows:
        user = {
            "id": int(r.get("id")),
            "username": r.get("username"),
            "full_name": r.get("full_name"),
            "email": r.get("email"),
            "role": normalize_role(r.get("role")),
            "is_active": bool(r.get("is_active", True)),
            "force_password_change": bool(r.get("force_password_change", False)),
            "last_login": r.get("last_login"),
            "created_at": r.get("created_at"),
        }

        try:
            grants = db.execute(
                text(
                    """
                    SELECT id, permission, valid_from, valid_until
                    FROM public.user_permission_grants
                    WHERE user_id = :uid
                      AND revoked_at IS NULL
                    ORDER BY id DESC
                    """
                ),
                {"uid": int(user["id"])},
            ).mappings().all()
        except Exception:
            db.rollback()
            grants = []

        user["grants"] = [
            {
                "id": int(g.get("id")),
                "permission": g.get("permission"),
                "valid_from": g.get("valid_from"),
                "valid_until": g.get("valid_until"),
            }
            for g in grants
        ]
        user["effective_permissions"] = sorted(get_effective_permissions(db, user))
        items.append(user)

    return {"items": items, "count": len(items)}


@router.post("/users", status_code=status.HTTP_201_CREATED)
def create_user(
    payload: CreateUserIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    username = payload.username.strip()
    if not username:
        raise HTTPException(400, "Username required")

    role = normalize_role(payload.role)
    if role not in {"viewer", "techniker", "admin"}:
        raise HTTPException(400, "Invalid role")

    # Only superadmin can create another superadmin
    if role == "superadmin" and normalize_role(current_user.get("role")) != "superadmin":
        raise HTTPException(status_code=403, detail="Forbidden")

    exists = db.execute(
        text("SELECT 1 FROM public.users_new WHERE username = :u"),
        {"u": username},
    ).first()
    if exists:
        raise HTTPException(400, "Username already exists")

    raw_password = payload.password
    generated = False
    if not raw_password:
        raw_password = secrets.token_urlsafe(10)
        generated = True

    pw_hash = hash_password(raw_password)

    db.rollback()
    with db.begin():
        row = db.execute(
            text(
                """
                INSERT INTO public.users_new
                    (username, full_name, email, password_hash, role, is_active, force_password_change)
                VALUES
                    (:u, :fn, :em, :ph, :role, :active, :fpc)
                RETURNING id
                """
            ),
            {
                "u": username,
                "fn": (payload.full_name or "").strip() or None,
                "em": (payload.email or "").strip() or None,
                "ph": pw_hash,
                "role": role,
                "active": bool(payload.is_active),
                "fpc": bool(payload.force_password_change),
            },
        ).mappings().first()
        user_id = int(row["id"]) if row else None

        # Mirror into old public.users so FK constraints on audit_log are satisfied
        try:
            db.execute(
                text(
                    """
                    INSERT INTO public.users (id, username, password_hash, role, is_active, created_at)
                    VALUES (:id, :u, :ph, :role, :active, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        username = EXCLUDED.username,
                        password_hash = EXCLUDED.password_hash,
                        role = EXCLUDED.role,
                        is_active = EXCLUDED.is_active
                    """
                ),
                {"id": user_id, "u": username, "ph": pw_hash, "role": role, "active": bool(payload.is_active)},
            )
        except Exception:
            pass  # old table mirror is best-effort

        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="user_create",
            entity_type="user",
            entity_id=user_id,
            details={"username": username, "role": role, "generated_password": generated},
            actor_user_id=current_user.get("id"),
            target_user_id=user_id,
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {
        "id": user_id,
        "username": username,
        "full_name": payload.full_name,
        "email": payload.email,
        "role": role,
        "is_active": bool(payload.is_active),
        "force_password_change": bool(payload.force_password_change),
        "temp_password": raw_password if generated else None,
    }


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    payload: UpdateUserIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    target = _get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    updates = {}
    changes: Dict[str, Any] = {}

    if payload.full_name is not None:
        updates["full_name"] = payload.full_name.strip() or None
        changes["full_name"] = {"from": target.get("full_name"), "to": updates["full_name"]}

    if payload.email is not None:
        updates["email"] = payload.email.strip() or None
        changes["email"] = {"from": target.get("email"), "to": updates["email"]}

    if payload.role is not None:
        new_role = normalize_role(payload.role)
        if new_role not in {"viewer", "techniker", "admin"}:
            raise HTTPException(400, "Invalid role")
        if new_role == "superadmin" and normalize_role(current_user.get("role")) != "superadmin":
            raise HTTPException(403, "Forbidden")
        if target.get("role") == "superadmin" and normalize_role(current_user.get("role")) != "superadmin":
            raise HTTPException(403, "Forbidden")
        updates["role"] = new_role
        changes["role"] = {"from": target.get("role"), "to": new_role}

    if payload.is_active is not None:
        updates["is_active"] = bool(payload.is_active)
        changes["is_active"] = {"from": target.get("is_active"), "to": updates["is_active"]}

    if payload.force_password_change is not None:
        updates["force_password_change"] = bool(payload.force_password_change)
        changes["force_password_change"] = {
            "from": target.get("force_password_change"),
            "to": updates["force_password_change"],
        }

    if not updates:
        return {"success": True, "message": "No changes"}

    set_clauses = ", ".join(f"{k} = :{k}" for k in updates)
    updates["id"] = int(user_id)

    db.rollback()
    with db.begin():
        db.execute(
            text(f"UPDATE public.users_new SET {set_clauses} WHERE id = :id"),
            updates,
        )

        # Determine audit action
        action = "user_update"
        if "is_active" in changes:
            action = "user_activate" if updates["is_active"] else "user_deactivate"
        if "role" in changes:
            action = "role_change"

        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action=action,
            entity_type="user",
            entity_id=int(user_id),
            details=changes,
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {"success": True, "changes": changes}


@router.patch("/users/{user_id}/role")
def update_user_role(
    user_id: int,
    payload: RoleUpdateIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    target = _get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    new_role = normalize_role(payload.role)
    if new_role not in {"viewer", "techniker", "admin", "superadmin"}:
        raise HTTPException(400, "Invalid role")

    actor_role = normalize_role(current_user.get("role"))
    if target.get("role") == "superadmin" and actor_role != "superadmin":
        raise HTTPException(status_code=403, detail="Forbidden")
    if new_role == "superadmin" and actor_role != "superadmin":
        raise HTTPException(status_code=403, detail="Forbidden")

    if new_role == target.get("role"):
        return {"success": True, "role": new_role}

    db.rollback()
    with db.begin():
        db.execute(
            text("UPDATE public.users_new SET role = :r WHERE id = :id"),
            {"r": new_role, "id": int(user_id)},
        )
        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="role_change",
            entity_type="user",
            entity_id=int(user_id),
            details={"from": target.get("role"), "to": new_role},
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {"success": True, "role": new_role}


@router.post("/users/{user_id}/reset-password")
def reset_password(
    user_id: int,
    payload: PasswordResetIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    target = _get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    _guard_admin_target(current_user, target, "Passwort zuruecksetzen")

    raw_password = payload.new_password
    generated = False
    if not raw_password:
        raw_password = secrets.token_urlsafe(10)
        generated = True

    pw_hash = hash_password(raw_password)

    db.rollback()
    with db.begin():
        db.execute(
            text(
                """
                UPDATE public.users_new
                SET password_hash = :ph,
                    force_password_change = TRUE
                WHERE id = :id
                """
            ),
            {"ph": pw_hash, "id": int(user_id)},
        )
        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="user_password_reset",
            entity_type="user",
            entity_id=int(user_id),
            details={"generated": generated},
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {
        "success": True,
        "temp_password": raw_password if generated else None,
        "message": "Password has been reset. User must change password on next login.",
    }


@router.post("/users/{user_id}/toggle-active")
def toggle_user_active(
    user_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    target = _get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    _guard_admin_target(current_user, target, "aktivieren/deaktivieren")

    # Prevent admin from deactivating themselves
    if int(user_id) == int(current_user.get("id")):
        raise HTTPException(400, "Cannot deactivate your own account")

    new_state = not target.get("is_active")

    db.rollback()
    with db.begin():
        db.execute(
            text("UPDATE public.users_new SET is_active = :active WHERE id = :id"),
            {"active": new_state, "id": int(user_id)},
        )
        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="user_activate" if new_state else "user_deactivate",
            entity_type="user",
            entity_id=int(user_id),
            details={"is_active": new_state},
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {"success": True, "is_active": new_state}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    if int(user_id) == int(current_user.get("id")):
        raise HTTPException(400, "Cannot delete your own account")

    target = _get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    # Only super-admin ('admin') can delete users
    if not _is_super_admin(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Nur der Super-Admin darf Benutzer loeschen.",
        )

    username = target.get("username")

    db.rollback()
    with db.begin():
        # Nullify audit_log.user_id references (FK is nullable)
        db.execute(
            text("UPDATE public.audit_log SET user_id = NULL WHERE user_id = :id"),
            {"id": int(user_id)},
        )
        # Delete from users_new
        db.execute(
            text("DELETE FROM public.users_new WHERE id = :id"),
            {"id": int(user_id)},
        )
        # Delete from old users table (cascades to user_permission_grants)
        try:
            db.execute(
                text("DELETE FROM public.users WHERE id = :id"),
                {"id": int(user_id)},
            )
        except Exception:
            pass  # old table may have other constraints; users_new deletion is enough

        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="user_delete",
            entity_type="user",
            entity_id=int(user_id),
            details={"username": username},
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {"success": True, "deleted_user_id": int(user_id)}


@router.post("/users/{user_id}/grants")
def grant_permission(
    user_id: int,
    payload: GrantIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("permissions.grant", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    target = _get_user_by_id(db, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    perm = (payload.permission or "").strip()
    if perm not in PERMISSIONS:
        raise HTTPException(400, "Invalid permission")

    valid_from = payload.valid_from or datetime.utcnow()
    valid_until = payload.valid_until

    db.rollback()
    with db.begin():
        row = db.execute(
            text(
                """
                INSERT INTO public.user_permission_grants
                  (user_id, permission, valid_from, valid_until, granted_by_user_id)
                VALUES
                  (:uid, :perm, :vf, :vu, :by)
                RETURNING id
                """
            ),
            {
                "uid": int(user_id),
                "perm": perm,
                "vf": valid_from,
                "vu": valid_until,
                "by": int(current_user.get("id")),
            },
        ).mappings().first()

        grant_id = int(row["id"]) if row else None

        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="permission_change",
            entity_type="user_permission_grant",
            entity_id=grant_id,
            details={
                "permission": perm,
                "valid_from": valid_from.isoformat() if valid_from else None,
                "valid_until": valid_until.isoformat() if valid_until else None,
            },
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {"success": True, "grant_id": grant_id}


@router.post("/users/{user_id}/grants/{grant_id}/revoke")
def revoke_permission(
    user_id: int,
    grant_id: int,
    payload: RevokeIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("permissions.grant", allow_roles={"admin", "superadmin"})),
):
    _require_admin_user(current_user)

    row = db.execute(
        text(
            """
            SELECT id, permission
            FROM public.user_permission_grants
            WHERE id = :gid AND user_id = :uid AND revoked_at IS NULL
            """
        ),
        {"gid": int(grant_id), "uid": int(user_id)},
    ).mappings().first()
    if not row:
        raise HTTPException(404, "Grant not found")

    db.rollback()
    with db.begin():
        db.execute(
            text(
                """
                UPDATE public.user_permission_grants
                SET revoked_at = NOW(),
                    revoked_by_user_id = :by,
                    revoke_reason = :reason
                WHERE id = :gid
                """
            ),
            {
                "by": int(current_user.get("id")),
                "reason": payload.reason,
                "gid": int(grant_id),
            },
        )

        write_audit_log(
            db,
            user_id=current_user.get("id"),
            action="permission_change",
            entity_type="user_permission_grant",
            entity_id=int(grant_id),
            details={
                "action": "revoke",
                "permission": row.get("permission"),
                "reason": payload.reason,
            },
            actor_user_id=current_user.get("id"),
            target_user_id=int(user_id),
            endpoint=str(request.url.path),
            ip=(request.client.host if request.client else None),
        )

    return {"success": True}


@router.get("/audit-log")
def read_audit_log(
    actor_user_id: Optional[int] = None,
    target_user_id: Optional[int] = None,
    action: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 200,
    db: Session = Depends(get_db),
    current_user=Depends(require_permissions("audit.read", allow_roles={"admin", "superadmin"})),
):
    if limit > 500:
        limit = 500

    # Discover which columns actually exist in audit_log
    col_rows = db.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='audit_log'"
        )
    ).scalars().all()
    existing_cols = {str(c) for c in col_rows}

    has_ts = "ts" in existing_cols
    has_actor = "actor_user_id" in existing_cols
    has_target = "target_user_id" in existing_cols
    has_details_json = "details_json" in existing_cols
    has_endpoint = "endpoint" in existing_cols
    has_ip = "ip" in existing_cols

    ts_expr = "ts" if has_ts else "created_at"
    actor_expr = "actor_user_id" if has_actor else "user_id"
    details_expr = "details_json" if has_details_json else "details"

    conditions = []
    params: Dict[str, Any] = {"limit": int(limit)}

    if actor_user_id:
        conditions.append(f"{actor_expr} = :actor")
        params["actor"] = int(actor_user_id)
    if target_user_id:
        if has_target:
            conditions.append("target_user_id = :target")
            params["target"] = int(target_user_id)
        else:
            # Fallback: search for target in details JSON
            conditions.append("details::text ILIKE :target_pattern")
            params["target_pattern"] = f"%{target_user_id}%"
    if action:
        conditions.append("action ILIKE :action")
        params["action"] = f"%{action}%"
    if date_from:
        conditions.append(f"{ts_expr} >= :date_from")
        params["date_from"] = date_from
    if date_to:
        conditions.append(f"{ts_expr} <= :date_to")
        params["date_to"] = date_to

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    select_parts = [
        f"{ts_expr} AS ts",
        f"{actor_expr} AS actor_user_id",
        "action",
        f"{'target_user_id' if has_target else 'NULL::integer'} AS target_user_id",
        f"{details_expr} AS details_json",
        "entity_type",
        "entity_id",
        f"{'endpoint' if has_endpoint else 'NULL::text'} AS endpoint",
        f"{'ip' if has_ip else 'NULL::text'} AS ip",
    ]

    rows = db.execute(
        text(
            f"""
            SELECT {', '.join(select_parts)}
            FROM public.audit_log
            {where}
            ORDER BY {ts_expr} DESC
            LIMIT :limit
            """
        ),
        params,
    ).mappings().all()

    # Build a username lookup for actor/target display
    user_ids = set()
    for r in rows:
        if r.get("actor_user_id"):
            user_ids.add(int(r["actor_user_id"]))
        if r.get("target_user_id"):
            user_ids.add(int(r["target_user_id"]))

    username_map: Dict[int, str] = {}
    if user_ids:
        user_rows = db.execute(
            text("SELECT id, username FROM public.users_new WHERE id = ANY(:ids)"),
            {"ids": list(user_ids)},
        ).mappings().all()
        for ur in user_rows:
            username_map[int(ur["id"])] = ur["username"]

    items = [
        {
            "ts": r.get("ts"),
            "actor_user_id": r.get("actor_user_id"),
            "actor_username": username_map.get(int(r["actor_user_id"])) if r.get("actor_user_id") else None,
            "action": r.get("action"),
            "target_user_id": r.get("target_user_id"),
            "target_username": username_map.get(int(r["target_user_id"])) if r.get("target_user_id") else None,
            "entity_type": r.get("entity_type"),
            "entity_id": r.get("entity_id"),
            "details": r.get("details_json"),
            "endpoint": r.get("endpoint"),
            "ip": r.get("ip"),
        }
        for r in rows
    ]

    return {"items": items, "count": len(items)}


@router.get("/roles")
def list_roles(
    current_user=Depends(require_permissions("users.manage", allow_roles={"admin", "superadmin"})),
):
    """Return available roles and their base permissions."""
    roles = []
    for role_name in ["viewer", "techniker", "admin"]:
        roles.append({
            "role": role_name,
            "permissions": sorted(ROLE_BASE_PERMISSIONS.get(role_name, set())),
        })
    return {"roles": roles}
