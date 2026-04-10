"""Auth router – login, password change, me endpoint with audit logging."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from audit import write_audit_log
from database import get_db
from security import (
    authenticate_user,
    create_access_token,
    get_current_user,
    get_effective_permissions,
    hash_password,
    normalize_role,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=200)


class ChangePasswordIn(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=200)
    new_password: str = Field(..., min_length=6, max_length=200)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    permissions: list[str] = []
    force_password_change: bool = False


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str | None = None
    email: str | None = None
    role: str
    is_active: bool
    permissions: list[str] = []
    force_password_change: bool = False


@router.post("/login", response_model=TokenOut)
def login(payload: LoginIn, request: Request, db: Session = Depends(get_db)):
    user = authenticate_user(db, payload.username, payload.password)

    if not user:
        # Log failed login attempt
        try:
            db.rollback()
            with db.begin():
                write_audit_log(
                    db,
                    user_id=None,
                    action="login_failed",
                    entity_type="auth",
                    entity_id=None,
                    details={"username": payload.username},
                    endpoint=str(request.url.path),
                    ip=(request.client.host if request.client else None),
                )
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    token = create_access_token(
        subject=user["username"],
        role=user["role"],
        user_id=user["id"],
    )
    perms = sorted(get_effective_permissions(db, user))

    # Update last_login
    try:
        db.rollback()
        with db.begin():
            db.execute(
                text("UPDATE public.users_new SET last_login = NOW() WHERE id = :id"),
                {"id": int(user["id"])},
            )
            write_audit_log(
                db,
                user_id=user["id"],
                action="login_success",
                entity_type="auth",
                entity_id=user["id"],
                details={"role": user["role"]},
                actor_user_id=user["id"],
                endpoint=str(request.url.path),
                ip=(request.client.host if request.client else None),
            )
    except Exception:
        pass

    return {
        "access_token": token,
        "token_type": "bearer",
        "role": normalize_role(user.get("role")),
        "permissions": perms,
        "force_password_change": bool(user.get("force_password_change", False)),
    }


@router.post("/change-password")
def change_password(
    payload: ChangePasswordIn,
    request: Request,
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Change own password. Used for forced password change on first login."""
    stored_hash = current_user.get("password_hash", "")
    if not verify_password(payload.current_password, stored_hash):
        raise HTTPException(400, "Current password is incorrect")

    if payload.current_password == payload.new_password:
        raise HTTPException(400, "New password must be different from current password")

    new_hash = hash_password(payload.new_password)

    # Update password in its own transaction
    db.rollback()
    with db.begin():
        db.execute(
            text(
                """
                UPDATE public.users_new
                SET password_hash = :ph, force_password_change = FALSE
                WHERE id = :id
                """
            ),
            {"ph": new_hash, "id": int(current_user["id"])},
        )

    # Audit log in a separate transaction — never block the main operation
    try:
        with db.begin():
            write_audit_log(
                db,
                user_id=current_user["id"],
                action="password_change",
                entity_type="user",
                entity_id=current_user["id"],
                details={"self_change": True},
                actor_user_id=current_user["id"],
                endpoint=str(request.url.path),
                ip=(request.client.host if request.client else None),
            )
    except Exception:
        pass

    # Issue new token after password change
    token = create_access_token(
        subject=current_user["username"],
        role=current_user["role"],
        user_id=current_user["id"],
    )
    perms = sorted(get_effective_permissions(db, current_user))

    return {
        "success": True,
        "access_token": token,
        "token_type": "bearer",
        "role": normalize_role(current_user.get("role")),
        "permissions": perms,
        "force_password_change": False,
    }


@router.get("/me", response_model=UserOut)
def me(current_user=Depends(get_current_user), db: Session = Depends(get_db)):
    perms = sorted(get_effective_permissions(db, current_user))
    return {
        "id": current_user["id"],
        "username": current_user["username"],
        "full_name": current_user.get("full_name"),
        "email": current_user.get("email"),
        "role": normalize_role(current_user.get("role")),
        "is_active": bool(current_user.get("is_active", True)),
        "permissions": perms,
        "force_password_change": bool(current_user.get("force_password_change", False)),
    }
