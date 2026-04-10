"""Security helpers for JWT auth + RBAC."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Set

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from audit import write_audit_log


JWT_ALGORITHM = "HS256"
DEFAULT_EXPIRE_HOURS = 8

# RBAC permissions
PERMISSIONS: Set[str] = {
    # Admin
    "users.manage",
    "users.reset_password",
    "audit.read",
    "audit.manage",
    "admin.settings",
    "permissions.grant",
    "import.manage",
    # Operative
    "crossconnect.create",
    "crossconnect.update",
    "crossconnect.read",
    "crossconnect.serial.assign",
    "kw.manage",
    "migration_audit.edit",
    "migration_audit.approve",
    "patchpanel.manage",
    # Legacy compat aliases
    "audit:write",
    "upload:write",
    "users:manage",
    "permissions:grant",
    "admin:settings",
    "logs:view",
}

ROLE_BASE_PERMISSIONS: Dict[str, Set[str]] = {
    "viewer": {
        "crossconnect.read",
        "audit.read",
    },
    "techniker": {
        "crossconnect.create",
        "crossconnect.update",
        "crossconnect.read",
        "crossconnect.serial.assign",
        "kw.manage",
        "migration_audit.edit",
        "patchpanel.manage",
    },
    "admin": {
        "users.manage",
        "users.reset_password",
        "audit.read",
        "audit.manage",
        "admin.settings",
        "permissions.grant",
        "import.manage",
        "crossconnect.create",
        "crossconnect.update",
        "crossconnect.read",
        "crossconnect.serial.assign",
        "kw.manage",
        "migration_audit.edit",
        "migration_audit.approve",
        "patchpanel.manage",
        # Legacy compat
        "audit:write",
        "upload:write",
        "users:manage",
        "permissions:grant",
        "admin:settings",
        "logs:view",
    },
    "superadmin": set(PERMISSIONS),
}

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


def _require_jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET") or getattr(settings, "jwt_secret", None)
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT_SECRET not set",
        )
    return secret


def _expire_hours() -> int:
    raw = os.getenv("JWT_EXPIRE_HOURS") or getattr(settings, "jwt_expire_hours", None)
    try:
        return int(raw) if raw is not None else DEFAULT_EXPIRE_HOURS
    except (TypeError, ValueError):
        return DEFAULT_EXPIRE_HOURS


def normalize_role(role: str | None) -> str:
    r = (role or "").strip().lower()
    if r == "tech":
        return "techniker"
    return r


def is_admin_role(role: str | None) -> bool:
    return normalize_role(role) in {"admin", "superadmin"}


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    try:
        return pwd_context.verify(plain_password, password_hash)
    except Exception:
        return False


def _is_bcrypt_hash(value: str | None) -> bool:
    if not value:
        return False
    return value.startswith("$2a$") or value.startswith("$2b$") or value.startswith("$2y$")


def get_user_by_username(db: Session, username: str) -> Dict[str, Any] | None:
    row = db.execute(
        text(
            """
            SELECT id, username, password_hash, role, is_active, created_at,
                   full_name, email, force_password_change, last_login
            FROM public.users_new
            WHERE username = :u
            LIMIT 1
            """
        ),
        {"u": username},
    ).mappings().first()

    if not row:
        return None

    return {
        "id": int(row.get("id")),
        "username": row.get("username"),
        "password_hash": row.get("password_hash"),
        "role": normalize_role(row.get("role")),
        "is_active": bool(row.get("is_active", True)),
        "created_at": row.get("created_at"),
        "full_name": row.get("full_name"),
        "email": row.get("email"),
        "force_password_change": bool(row.get("force_password_change", False)),
        "last_login": row.get("last_login"),
    }


def authenticate_user(db: Session, username: str, password: str) -> Dict[str, Any] | None:
    user = get_user_by_username(db, username)
    if not user:
        return None
    if not user.get("is_active"):
        return None
    stored = user.get("password_hash") or ""
    if _is_bcrypt_hash(stored):
        if not verify_password(password, stored):
            return None
    else:
        # Legacy fallback: plaintext stored in password_hash.
        if password != stored:
            return None
        # Upgrade to bcrypt hash on successful login.
        new_hash = hash_password(password)
        db.execute(
            text("UPDATE public.users_new SET password_hash = :ph WHERE id = :id"),
            {"ph": new_hash, "id": int(user["id"])},
        )
        user["password_hash"] = new_hash
    return user


def _active_permission_grants(db: Session, user_id: int) -> Set[str]:
    try:
        rows = db.execute(
            text(
                """
                SELECT permission
                FROM public.user_permission_grants
                WHERE user_id = :uid
                  AND revoked_at IS NULL
                  AND (valid_from IS NULL OR valid_from <= NOW())
                  AND (valid_until IS NULL OR NOW() < valid_until)
                """
            ),
            {"uid": int(user_id)},
        ).mappings().all()
        return {str(r.get("permission")).strip() for r in rows if r.get("permission")}
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        # Table might not exist yet (before migrations). Fail closed to base permissions.
        return set()


def get_effective_permissions(db: Session, user: Dict[str, Any]) -> Set[str]:
    role = normalize_role(user.get("role"))
    if role == "superadmin":
        return set(PERMISSIONS)

    base = set(ROLE_BASE_PERMISSIONS.get(role, set()))
    grants = _active_permission_grants(db, int(user.get("id")))
    return base | grants


def has_permissions(db: Session, user: Dict[str, Any], perms: Iterable[str]) -> bool:
    effective = get_effective_permissions(db, user)
    return set(perms).issubset(effective)


def create_access_token(*, subject: str, role: str, user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=_expire_hours())
    payload = {
        "sub": subject,
        "role": normalize_role(role),
        "uid": int(user_id),
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    secret = _require_jwt_secret()
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if credentials is None or (credentials.scheme or "").lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials
    try:
        payload = jwt.decode(token, _require_jwt_secret(), algorithms=[JWT_ALGORITHM])
        username = payload.get("sub")
        if not username:
            raise JWTError("Missing subject")
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = get_user_by_username(db, str(username))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    if not user.get("is_active"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User inactive")

    return user


def require_roles(*roles: str):
    role_set = {normalize_role(r) for r in roles}

    def _dep(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if normalize_role(user.get("role")) not in role_set:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return _dep


def require_permissions(*perms: str, allow_roles: Set[str] | None = None):
    perm_set = {p for p in perms if p}
    role_allow = {normalize_role(r) for r in allow_roles} if allow_roles else None

    def _dep(
        user: Dict[str, Any] = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> Dict[str, Any]:
        role = normalize_role(user.get("role"))
        if role_allow is not None and role not in role_allow:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

        if perm_set and not has_permissions(db, user, perm_set):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

        return user

    return _dep


def require_permissions_for_write(*perms: str):
    perm_set = {p for p in perms if p}

    def _dep(
        request: Request,
        user: Dict[str, Any] = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> Dict[str, Any]:
        if request.method in {"GET", "HEAD", "OPTIONS"}:
            return user

        role = normalize_role(user.get("role"))
        # Viewer is strictly read-only
        if role == "viewer":
            _log_forbidden_write(db, user, request)
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

        # Techniker can do operative writes but not admin writes
        # Admin-only endpoints are additionally guarded by require_permissions/require_roles
        if role == "techniker":
            return user

        if perm_set and not has_permissions(db, user, perm_set):
            _log_forbidden_write(db, user, request)
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

        return user

    return _dep


def _log_forbidden_write(db: Session, user: Dict[str, Any], request: Request) -> None:
    try:
        db.rollback()
        with db.begin():
            write_audit_log(
                db,
                user_id=user.get("id") if isinstance(user, dict) else None,
                action="rbac_forbidden",
                entity_type="http",
                entity_id=None,
                details={
                    "method": request.method,
                    "path": str(request.url.path),
                    "role": normalize_role(user.get("role")),
                },
                endpoint=str(request.url.path),
                ip=(request.client.host if request.client else None),
            )
    except Exception:
        pass
