# routers/jobs.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text
from database import get_db
from security import get_current_user
from audit import write_audit_log
import re
from datetime import datetime, date, time
from typing import Dict, List, Optional, Any

router = APIRouter(
    prefix="/api/v1/jobs",
    tags=["jobs"],
)


def has_column(db: Session, table: str, column: str, schema: str = "public") -> bool:
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



def _swap_backbone_fields(item: dict) -> dict:
    """Normalize BB IN/OUT for API consumers (see routers/cross_connects.py)."""
    if not item:
        return item
    bi_i = item.get("backbone_in_instance_id")
    bi_p = item.get("backbone_in_port_label")
    bo_i = item.get("backbone_out_instance_id")
    bo_p = item.get("backbone_out_port_label")
    item["backbone_in_instance_id"], item["backbone_out_instance_id"] = bo_i, bi_i
    item["backbone_in_port_label"], item["backbone_out_port_label"] = bo_p, bi_p
    return item


@router.get("")
def list_jobs(db: Session = Depends(get_db)):
    """Liste aller Import-Jobs (KW + Modus) inkl. einfacher Stats."""
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS public.import_jobs (
            id bigserial PRIMARY KEY,
            kw integer NOT NULL,
            mode text NOT NULL,
            file_name text,
            created_at timestamptz NOT NULL DEFAULT NOW()
        );
    """))

    rows = db.execute(text("""
        SELECT
          j.id,
          j.kw,
          j.mode,
          j.file_name,
          j.created_at,
          COALESCE(COUNT(cc.id), 0) AS total,
          COALESCE(SUM(CASE WHEN cc.status = 'planned' THEN 1 ELSE 0 END), 0) AS planned,
          COALESCE(SUM(CASE WHEN cc.status = 'review' THEN 1 ELSE 0 END), 0) AS review,
          COALESCE(SUM(CASE WHEN cc.status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
          COALESCE(SUM(CASE WHEN cc.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
          COALESCE(SUM(CASE WHEN cc.status = 'pending_serial' THEN 1 ELSE 0 END), 0) AS pending_serial,
          COALESCE(SUM(CASE WHEN cc.status = 'active' THEN 1 ELSE 0 END), 0) AS active
        FROM public.import_jobs j
        LEFT JOIN public.cross_connects cc ON cc.job_id = j.id
        GROUP BY j.id
        ORDER BY j.created_at DESC, j.id DESC;
    """)).mappings().all()

    return {"items": [dict(r) for r in rows]}


@router.get("/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    r = db.execute(text("""
        SELECT id, kw, mode, file_name, created_at
        FROM public.import_jobs
        WHERE id = :id
    """), {"id": int(job_id)}).mappings().first()
    return dict(r) if r else None


@router.get("/{job_id}/stats")
def job_stats(job_id: int, db: Session = Depends(get_db)):
    """Status counters for the job detail page tabs."""
    row = db.execute(text("""
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'planned' THEN 1 ELSE 0 END), 0) AS planned,
          COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) AS review,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
          COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
          COALESCE(SUM(CASE WHEN status = 'troubleshoot' THEN 1 ELSE 0 END), 0) AS troubleshoot,
          COALESCE(SUM(CASE WHEN status = 'pending_serial' THEN 1 ELSE 0 END), 0) AS pending_serial,
          COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
          COALESCE(SUM(CASE WHEN status = 'deinstalled' THEN 1 ELSE 0 END), 0) AS deinstalled
        FROM public.cross_connects
        WHERE job_id = :jid;
    """), {"jid": int(job_id)}).mappings().first()
    return dict(row) if row else {"total": 0}


@router.get("/{job_id}/lines")
def list_job_lines(
    job_id: int,
    status: str = "all",
    limit: int = 500,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    status = (status or "all").strip().lower()
    where = "WHERE cc.job_id = :job_id"
    params: Dict[str, Any] = {"job_id": int(job_id), "limit": int(limit), "offset": int(offset)}
    has_tc = has_column(db, "cross_connects", "tech_comment")
    has_ua = has_column(db, "cross_connects", "updated_at")
    has_pid = has_column(db, "cross_connects", "product_id")
    has_sn = has_column(db, "cross_connects", "serial_number")
    if status != "all":
        where += " AND cc.status = :status"
        params["status"] = status

    tech_comment_sel = "cc.tech_comment AS tech_comment" if has_tc else "NULL::text AS tech_comment"
    updated_at_sel = "cc.updated_at AS updated_at" if has_ua else "NULL::timestamptz AS updated_at"

    product_id_sel = "COALESCE(cc.product_id, cc.serial) AS product_id" if has_pid else "cc.serial AS product_id"
    serial_no_sel = "cc.serial_number AS serial_number" if has_sn else "NULL::text AS serial_number"

    rows = db.execute(text(f"""
        SELECT
          cc.id,
          {product_id_sel},
          {serial_no_sel},
          cc.status,
          cc.switch_name,
          cc.switch_port,
          cc.a_patchpanel_id,
          cc.a_port_label,
          cc.backbone_out_instance_id,
          cc.backbone_out_port_label,
          cc.backbone_in_instance_id,
          cc.backbone_in_port_label,
          cc.customer_patchpanel_id,
          cc.customer_port_label,
          COALESCE(cpp.instance_id, CAST(cc.customer_patchpanel_id AS text)) AS customer_pp_name,
          cc.assigned_to,
          cc.assigned_at,
          {tech_comment_sel},
          {updated_at_sel},
          cc.created_at
        FROM public.cross_connects cc
        LEFT JOIN public.patchpanel_instances cpp ON cpp.id = cc.customer_patchpanel_id
        {where}
        ORDER BY cc.id ASC
        LIMIT :limit OFFSET :offset;
    """), params).mappings().all()

    total = db.execute(text(f"""
        SELECT COUNT(*) AS c
        FROM public.cross_connects cc
        {where};
    """), params).mappings().first()

    write_audit_log(
        db,
        user_id=current_user.get("id") if isinstance(current_user, dict) else None,
        action="job_start",
        entity_type="import_job",
        entity_id=int(job_id),
        details={"status": status, "limit": int(limit), "offset": int(offset)},
    )

    return {
        "items": [_swap_backbone_fields(dict(r)) for r in rows],
        "total": int(total["c"]) if total else 0,
        "limit": int(limit),
        "offset": int(offset),
    }



from fastapi.responses import StreamingResponse
import csv
import io
from openpyxl import Workbook

@router.get("/{job_id}/export.csv")
def export_job_csv(
    job_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Export all lines for a job as CSV."""
    has_tc = has_column(db, "cross_connects", "tech_comment")
    has_ua = has_column(db, "cross_connects", "updated_at")
    has_pid = has_column(db, "cross_connects", "product_id")
    has_sn = has_column(db, "cross_connects", "serial_number")

    tech_comment_sel = "cc.tech_comment AS tech_comment" if has_tc else "NULL::text AS tech_comment"
    updated_at_sel = "COALESCE(cc.updated_at, cc.created_at) AS updated_at" if has_ua else "cc.created_at AS updated_at"

    product_id_sel = "COALESCE(cc.product_id, cc.serial) AS product_id" if has_pid else "cc.serial AS product_id"
    serial_no_sel = "cc.serial_number AS serial_number" if has_sn else "NULL::text AS serial_number"

    try:
        rows = db.execute(
            text(
                f"""
                SELECT
                  cc.id,
                  {product_id_sel},
                  {serial_no_sel},
                  cc.status,
                  cc.switch_name,
                  cc.switch_port,
                  cc.a_patchpanel_id,
                  cc.a_port_label,
                  cc.backbone_out_instance_id,
                  cc.backbone_out_port_label,
                  cc.backbone_in_instance_id,
                  cc.backbone_in_port_label,
                  COALESCE(cpp.instance_id, CAST(cc.customer_patchpanel_id AS text)) AS customer_pp_name,
                  cc.customer_port_label,
                  cc.assigned_to,
                  {tech_comment_sel},
                  {updated_at_sel},
                  cc.created_at
                FROM public.cross_connects cc
                LEFT JOIN public.patchpanel_instances cpp ON cpp.id = cc.customer_patchpanel_id
                WHERE cc.job_id = :jid
                ORDER BY cc.id ASC;
                """
            ),
            {"jid": int(job_id)},
        ).mappings().all()

        # Normalize BB fields for CSV (same as UI)
        items = [_swap_backbone_fields(dict(r)) for r in rows]

        out = io.StringIO()
        w = csv.writer(out, delimiter=";")
        w.writerow([
        "id","product_id","serial_number","status","switch_name","switch_port",
        "a_patchpanel_id","a_port_label",
        "bb_in_instance","bb_in_port",
        "bb_out_instance","bb_out_port",
        "customer_pp","customer_port",
        "assigned_to","tech_comment","updated_at","created_at"
        ])
        for r in items:
            w.writerow([
            r.get("id"), r.get("product_id"), (r.get("serial_number") or ""), r.get("status"),
            r.get("switch_name"), r.get("switch_port"),
            r.get("a_patchpanel_id"), r.get("a_port_label"),
            r.get("backbone_in_instance_id"), r.get("backbone_in_port_label"),
            r.get("backbone_out_instance_id"), r.get("backbone_out_port_label"),
            r.get("customer_pp_name"), r.get("customer_port_label"),
            r.get("assigned_to"), r.get("tech_comment"),
            r.get("updated_at"), r.get("created_at"),
            ])

        data = out.getvalue().encode("utf-8-sig")
        write_audit_log(
        db,
        user_id=current_user.get("id") if isinstance(current_user, dict) else None,
        action="job_finish",
        entity_type="import_job",
        entity_id=int(job_id),
        details={"export": "csv", "rows": len(rows)},
        )
        filename = f"job_{job_id}_export.csv"
        return StreamingResponse(
        io.BytesIO(data),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception as e:
        write_audit_log(
            db,
            user_id=current_user.get("id") if isinstance(current_user, dict) else None,
            action="job_error",
            entity_type="import_job",
            entity_id=int(job_id),
            details={"export": "csv", "error": str(e)},
        )
        raise


@router.get("/{job_id}/export.xlsx")
def export_job_xlsx(
    job_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Export all lines for a job as Excel (XLSX)."""
    has_tc = has_column(db, "cross_connects", "tech_comment")
    has_ua = has_column(db, "cross_connects", "updated_at")
    has_pid = has_column(db, "cross_connects", "product_id")
    has_sn = has_column(db, "cross_connects", "serial_number")

    tech_comment_sel = "cc.tech_comment AS tech_comment" if has_tc else "NULL::text AS tech_comment"
    updated_at_sel = "COALESCE(cc.updated_at, cc.created_at) AS updated_at" if has_ua else "cc.created_at AS updated_at"

    product_id_sel = "COALESCE(cc.product_id, cc.serial) AS product_id" if has_pid else "cc.serial AS product_id"
    serial_no_sel = "cc.serial_number AS serial_number" if has_sn else "NULL::text AS serial_number"

    try:
        rows = db.execute(
            text(
                f"""
                SELECT
                  cc.id,
                  {product_id_sel},
                  {serial_no_sel},
                  cc.status,
                  cc.switch_name,
                  cc.switch_port,
                  cc.a_patchpanel_id,
                  cc.a_port_label,
                  cc.backbone_out_instance_id,
                  cc.backbone_out_port_label,
                  cc.backbone_in_instance_id,
                  cc.backbone_in_port_label,
                  COALESCE(cpp.instance_id, CAST(cc.customer_patchpanel_id AS text)) AS customer_pp_name,
                  cc.customer_port_label,
                  cc.assigned_to,
                  {tech_comment_sel},
                  {updated_at_sel},
                  cc.created_at
                FROM public.cross_connects cc
                LEFT JOIN public.patchpanel_instances cpp ON cpp.id = cc.customer_patchpanel_id
                WHERE cc.job_id = :jid
                ORDER BY cc.id ASC;
                """
            ),
            {"jid": int(job_id)},
        ).mappings().all()

        items = [_swap_backbone_fields(dict(r)) for r in rows]

        def excel_safe(v: Any):
            """Make values safe for Excel/openpyxl.

            openpyxl raises if a datetime has tzinfo. We strip tzinfo.
            """
            if isinstance(v, datetime):
                return v.replace(tzinfo=None) if v.tzinfo else v
            # date and time are fine; strings/numbers/None fine.
            if isinstance(v, (date, time)):
                return v
            return v

        wb = Workbook()
        ws = wb.active
        ws.title = "Lines"

        headers = [
            "id","product_id","serial_number","status","switch_name","switch_port",
            "a_patchpanel_id","a_port_label",
            "bb_in_instance","bb_in_port",
            "bb_out_instance","bb_out_port",
            "customer_pp","customer_port",
            "assigned_to","tech_comment","updated_at","created_at"
        ]
        ws.append(headers)
        for r in items:
            ws.append([
                r.get("id"), r.get("product_id"), (r.get("serial_number") or ""), r.get("status"),
                r.get("switch_name"), r.get("switch_port"),
                r.get("a_patchpanel_id"), r.get("a_port_label"),
                r.get("backbone_in_instance_id"), r.get("backbone_in_port_label"),
                r.get("backbone_out_instance_id"), r.get("backbone_out_port_label"),
                r.get("customer_pp_name"), r.get("customer_port_label"),
                r.get("assigned_to"), r.get("tech_comment"),
                excel_safe(r.get("updated_at")), excel_safe(r.get("created_at")),
            ])

        bio = io.BytesIO()
        wb.save(bio)
        bio.seek(0)

        write_audit_log(
            db,
            user_id=current_user.get("id") if isinstance(current_user, dict) else None,
            action="job_finish",
            entity_type="import_job",
            entity_id=int(job_id),
            details={"export": "xlsx", "rows": len(rows)},
        )
        filename = f"job_{job_id}_export.xlsx"
        return StreamingResponse(
            bio,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    except Exception as e:
        write_audit_log(
            db,
            user_id=current_user.get("id") if isinstance(current_user, dict) else None,
            action="job_error",
            entity_type="import_job",
            entity_id=int(job_id),
            details={"export": "xlsx", "error": str(e)},
        )
        raise
# ------------------------------------------------------------
# Backbone (BB IN) PatchPanel lookup for a given cross-connect
# FINAL & STABLE: returns "patchpanels" like customer-pps (frontend-friendly)
# ------------------------------------------------------------

def _normalize_cage(cage: Optional[str]) -> Optional[str]:
    """S4 -> S04, S01 stays S01."""
    if cage is None:
        return None
    s = str(cage).strip().upper()
    m = re.match(r"^S(\d+)$", s)
    if not m:
        return s
    return "S" + m.group(1).zfill(2)

def _cage_short(cage: Optional[str]) -> Optional[str]:
    """S01 -> S1 (for old peer strings)."""
    if cage is None:
        return None
    s = str(cage).strip().upper()
    m = re.match(r"^S0*(\d+)$", s)
    if not m:
        return s
    return "S" + str(int(m.group(1)))


@router.get("/lines/{cc_id}/bbin-pps")
def bbin_patchpanels_for_line(cc_id: int, db: Session = Depends(get_db)):
    # 1) load cc + customer pp
    cc = db.execute(
        text("""
            SELECT id, customer_patchpanel_id
            FROM public.cross_connects
            WHERE id = :id
        """),
        {"id": int(cc_id)},
    ).mappings().first()

    if not cc:
        raise HTTPException(404, f"Cross-connect {cc_id} not found.")

    z_pp_id = cc.get("customer_patchpanel_id")
    if z_pp_id is None:
        return {"context": None, "patchpanels": []}

    # 2) customer pp context
    ctx = db.execute(
        text("""
            SELECT id, room_code, room, NULLIF(cage_no,'') AS cage_no
            FROM public.patchpanel_instances
            WHERE id = :ppid
        """),
        {"ppid": int(z_pp_id)},
    ).mappings().first()

    if not ctx:
        raise HTTPException(500, f"customer_patchpanel_id {z_pp_id} not found in patchpanel_instances")

    room_code = (ctx.get("room_code") or ctx.get("room") or "").strip()
    if not room_code:
        return {"context": dict(ctx), "patchpanels": []}

    cage = _normalize_cage(ctx.get("cage_no"))
    cage2 = _cage_short(cage)

    # 3) query
    if cage:
        prefix_a = f"{room_code}{cage}/%"
        prefix_b = f"{room_code}{cage2}/%" if cage2 and cage2 != cage else None

        if prefix_b:
            rows = db.execute(
                text("""
                    SELECT
                      pi.id,
                      pi.instance_id,
                      pi.rack_label,
                      pi.rack_unit,
                      pi.total_ports,
                      COUNT(*) AS matching_ports
                    FROM public.patchpanel_ports p
                    JOIN public.patchpanel_instances pi ON pi.id = p.patchpanel_id
                    WHERE p.peer_instance_id IS NOT NULL
                      AND p.peer_instance_id <> ''
                      AND (p.peer_instance_id LIKE :a OR p.peer_instance_id LIKE :b)
                      AND pi.customer_id IS NULL
                    GROUP BY pi.id, pi.instance_id, pi.rack_label, pi.rack_unit, pi.total_ports
                    ORDER BY pi.instance_id;
                """),
                {"a": prefix_a, "b": prefix_b},
            ).mappings().all()
            peer_patterns = [prefix_a, prefix_b]
        else:
            rows = db.execute(
                text("""
                    SELECT
                      pi.id,
                      pi.instance_id,
                      pi.rack_label,
                      pi.rack_unit,
                      pi.total_ports,
                      COUNT(*) AS matching_ports
                    FROM public.patchpanel_ports p
                    JOIN public.patchpanel_instances pi ON pi.id = p.patchpanel_id
                    WHERE p.peer_instance_id IS NOT NULL
                      AND p.peer_instance_id <> ''
                      AND p.peer_instance_id LIKE :a
                      AND pi.customer_id IS NULL
                    GROUP BY pi.id, pi.instance_id, pi.rack_label, pi.rack_unit, pi.total_ports
                    ORDER BY pi.instance_id;
                """),
                {"a": prefix_a},
            ).mappings().all()
            peer_patterns = [prefix_a]

    else:
        prefix = f"{room_code}%"
        rows = db.execute(
            text("""
                SELECT
                  pi.id,
                  pi.instance_id,
                  pi.rack_label,
                  pi.rack_unit,
                  pi.total_ports,
                  COUNT(*) AS matching_ports
                FROM public.patchpanel_ports p
                JOIN public.patchpanel_instances pi ON pi.id = p.patchpanel_id
                WHERE p.peer_instance_id IS NOT NULL
                  AND p.peer_instance_id <> ''
                  AND p.peer_instance_id LIKE :prefix
                  AND pi.customer_id IS NULL
                GROUP BY pi.id, pi.instance_id, pi.rack_label, pi.rack_unit, pi.total_ports
                ORDER BY pi.instance_id;
            """),
            {"prefix": prefix},
        ).mappings().all()
        peer_patterns = [prefix]

    # 4) output (frontend expects patchpanels!)
    patchpanels = []
    for r in rows:
        patchpanels.append({
            "id": int(r["id"]),
            "instance_id": r.get("instance_id"),
            "rack_label": r.get("rack_label"),
            "rack_unit": r.get("rack_unit"),
            "total_ports": r.get("total_ports"),
            "matching_ports": int(r.get("matching_ports") or 0),
        })

    return {
        "context": {
            "cc_id": int(cc_id),
            "customer_patchpanel_id": int(z_pp_id),
            "room_code": room_code,
            "cage_no": cage,
            "peer_patterns": peer_patterns,
        },
        "patchpanels": patchpanels,
    }
