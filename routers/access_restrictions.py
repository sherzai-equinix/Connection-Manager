"""Router for customer access restrictions + KW access request tracking."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from security import get_current_user

router = APIRouter(prefix=f"{settings.api_prefix}/access-restrictions", tags=["access-restrictions"])


# ---------------------------------------------------------------------------
# Ensure tables exist
# ---------------------------------------------------------------------------

def _ensure_tables(db: Session) -> None:
    db.execute(text(
        "ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS access_restricted BOOLEAN NOT NULL DEFAULT FALSE"
    ))
    db.execute(text(
        "ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS restriction_type TEXT NOT NULL DEFAULT 'access_approval'"
    ))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS public.kw_access_requests (
            id              BIGSERIAL PRIMARY KEY,
            kw_plan_id      BIGINT NOT NULL REFERENCES public.kw_plans(id) ON DELETE CASCADE,
            customer_id     BIGINT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
            requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            requested_by    BIGINT NULL,
            CONSTRAINT uq_kw_access_customer UNIQUE (kw_plan_id, customer_id)
        )
    """))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_kw_access_plan ON public.kw_access_requests(kw_plan_id)"))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_kw_access_customer ON public.kw_access_requests(customer_id)"))
    db.commit()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ToggleRestrictionIn(BaseModel):
    access_restricted: bool
    restriction_type: str | None = None


class AccessRequestIn(BaseModel):
    customer_id: int


# ---------------------------------------------------------------------------
# Endpoints: Customer restriction management
# ---------------------------------------------------------------------------

@router.get("/customers")
def list_customers_with_restriction(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List all customers with their access_restricted flag."""
    _ensure_tables(db)
    rows = db.execute(text(
        "SELECT id, name, access_restricted, restriction_type FROM public.customers ORDER BY name ASC"
    )).mappings().all()
    return {
        "items": [
            {"id": int(r["id"]), "name": r["name"], "access_restricted": bool(r["access_restricted"]), "restriction_type": r.get("restriction_type") or "access_approval"}
            for r in rows
        ]
    }


@router.patch("/customers/{customer_id}")
def toggle_customer_restriction(
    customer_id: int,
    body: ToggleRestrictionIn,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Toggle access_restricted for a customer."""
    _ensure_tables(db)
    params = {"val": body.access_restricted, "cid": customer_id}
    sql = "UPDATE public.customers SET access_restricted = :val"
    if body.restriction_type is not None:
        sql += ", restriction_type = :rtype"
        params["rtype"] = body.restriction_type
    sql += " WHERE id = :cid"
    result = db.execute(text(sql), params)
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Customer not found")
    db.commit()
    return {"ok": True, "customer_id": customer_id, "access_restricted": body.access_restricted, "restriction_type": body.restriction_type}


# ---------------------------------------------------------------------------
# Endpoints: KW access requests
# ---------------------------------------------------------------------------

@router.get("/kw/{plan_id}")
def get_access_requests_for_plan(
    plan_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Get all access requests for a specific KW plan + list restricted customers."""
    _ensure_tables(db)
    rows = db.execute(text("""
        SELECT ar.id, ar.customer_id, c.name AS customer_name, ar.requested_at, ar.requested_by
        FROM public.kw_access_requests ar
        JOIN public.customers c ON c.id = ar.customer_id
        WHERE ar.kw_plan_id = :pid
        ORDER BY c.name ASC
    """), {"pid": plan_id}).mappings().all()

    restricted = db.execute(text(
        "SELECT id, name FROM public.customers WHERE access_restricted = TRUE ORDER BY name ASC"
    )).mappings().all()

    return {
        "requests": [
            {
                "id": int(r["id"]),
                "customer_id": int(r["customer_id"]),
                "customer_name": r["customer_name"],
                "requested_at": str(r["requested_at"]),
                "requested_by": r["requested_by"],
            }
            for r in rows
        ],
        "restricted_customers": [
            {"id": int(r["id"]), "name": r["name"]}
            for r in restricted
        ],
    }


@router.post("/kw/{plan_id}/request")
def mark_access_requested(
    plan_id: int,
    body: AccessRequestIn,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Mark access as requested for a customer in a specific KW plan."""
    _ensure_tables(db)
    user_id = current_user.get("id") if current_user else None
    db.execute(text("""
        INSERT INTO public.kw_access_requests (kw_plan_id, customer_id, requested_by)
        VALUES (:pid, :cid, :uid)
        ON CONFLICT (kw_plan_id, customer_id) DO UPDATE SET requested_at = NOW(), requested_by = :uid
    """), {"pid": plan_id, "cid": body.customer_id, "uid": user_id})
    db.commit()
    return {"ok": True, "plan_id": plan_id, "customer_id": body.customer_id}


@router.delete("/kw/{plan_id}/request/{customer_id}")
def remove_access_request(
    plan_id: int,
    customer_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Remove an access request (undo)."""
    _ensure_tables(db)
    db.execute(text("""
        DELETE FROM public.kw_access_requests
        WHERE kw_plan_id = :pid AND customer_id = :cid
    """), {"pid": plan_id, "cid": customer_id})
    db.commit()
    return {"ok": True}
