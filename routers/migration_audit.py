from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import text
from datetime import datetime
from typing import Optional, List, Dict, Any
import re
import traceback

import crud

from config import settings
from database import get_db
from security import get_current_user, require_permissions
from audit import write_audit_log

try:
    from pyxlsb import open_workbook  # type: ignore
except Exception:  # pragma: no cover
    open_workbook = None


router = APIRouter(
    prefix=f"{settings.api_prefix}/migration-audit",
    tags=["migration-audit"],
)




@router.get("/resolve-a-side")
def resolve_a_side_by_switch(switch_name: str, switch_port: str, db: Session = Depends(get_db)):
    """Resolve A-side patchpanel + port via pre_cabled_links (RFRA switch mapping)."""
    sw = (switch_name or "").strip()
    sp = (switch_port or "").strip()
    if not sw or not sp:
        return {"found": False}
    row = db.execute(
        text(
            """
            SELECT patchpanel_id, patchpanel_port, room, room_norm
            FROM public.pre_cabled_links
            WHERE switch_name = :sw
              AND switch_port = :sp
            ORDER BY id ASC
            LIMIT 1
            """
        ),
        {"sw": sw, "sp": sp},
    ).mappings().first()
    if not row:
        return {"found": False}
    return {
        "found": True,
        "a_pp_number": row.get("patchpanel_id"),
        "a_port_label": row.get("patchpanel_port"),
        "a_room": row.get("room"),
        "a_room_norm": row.get("room_norm"),
    }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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


ROOM_RE = re.compile(r"FR\d+\s*:\s*\d+\s*:\s*(5\.\d{2})", re.IGNORECASE)
ROOM_RE2 = re.compile(r"FR\d+\s*:\s*[^:]+\s*:\s*(5\.\d{2})", re.IGNORECASE)
PP_RE = re.compile(r"^PP:(\d{4}):(.+)$", re.IGNORECASE)


def parse_room_from_system_name(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    txt = str(s).strip()
    m = ROOM_RE.search(txt) or ROOM_RE2.search(txt)
    return m.group(1) if m else None


def parse_pp(pp_raw: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Return (rack_code, pp_number) from PP:0305:1071189."""
    if not pp_raw:
        return None, None
    s = str(pp_raw).strip()
    m = PP_RE.match(s)
    if not m:
        return None, None
    return m.group(1), m.group(2)


def normalize_pp_full(pp_raw: Optional[str], rack_code: Optional[str] = None, pp_number: Optional[str] = None) -> Optional[str]:
    """Normalize a patchpanel identifier into full form: PP:0307:1071186.

    Inputs we may see:
    - full form already: "PP:0307:1071186"
    - number only (rare): "1071186" + rack_code provided
    - messy whitespace / lower/upper differences
    """
    raw = (str(pp_raw).strip() if pp_raw is not None else "")
    if raw:
        m = PP_RE.match(raw)
        if m:
            rk = m.group(1).zfill(4)
            num = m.group(2).strip()
            return f"PP:{rk}:{num}"

    rk = (str(rack_code).strip() if rack_code is not None else "")
    num = (str(pp_number).strip() if pp_number is not None else "")
    if rk and num:
        rk = rk.zfill(4)
        return f"PP:{rk}:{num}"
    return raw or None


def normalize_trailing_dot_zero(v: Optional[str]) -> Optional[str]:
    """Excel sometimes exports numeric-looking IDs as "123.0".
    We only remove a single trailing ".0"."""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    s = re.sub(r"\.0$", "", s)
    return s


def parse_switch_and_port(raw: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Parse strings like "RFRA3312-ETH1/9/1" -> (RFRA3312, ETH1/9/1)."""
    if raw is None:
        return None, None
    s = str(raw).strip()
    if not s:
        return None, None
    if "-" in s:
        left, right = s.split("-", 1)
        left = left.strip() or None
        right = right.strip() or None
        return left, right
    # already just the port
    return None, s


def _swap_backbone_for_db(bb_in_i: str | None, bb_in_p: str | None, bb_out_i: str | None, bb_out_p: str | None):
    """DB has backbone_in/out swapped vs UI.
    Return (db_backbone_out_i, db_backbone_out_p, db_backbone_in_i, db_backbone_in_p)
    """
    return bb_in_i, bb_in_p, bb_out_i, bb_out_p



def parse_customer_room_and_cage(system_name: Optional[str]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Parse customer room + cage from system_name.

    Examples:
    - FR2:OG-M1A2:OC:DEUTSCHE BÖRSE AG   -> room=1A2, cage=None, mode=OC
    - FR2:OG-M4.5:S1:TOWER ...           -> room=4.5, cage=S1, mode=S
    - FR2:0G:054S05:EULINKS LTD.         -> room=5.04, cage=S5, mode=S
    - FR2:EG-M5.04:OC:Susquehanna        -> room=5.04, cage=None, mode=OC
    Returns: (room_without_M, cage_label_or_None, mode_token_or_None)
    """
    if not system_name:
        return None, None, None
    parts = [p.strip() for p in str(system_name).split(":") if str(p).strip()]
    # Flatten possible "XX-<room>" forms
    flat = []
    for p in parts:
        if "-" in p:
            flat.append(p.split("-")[-1].strip())
        else:
            flat.append(p)
    room = None
    room_idx = None

    # 1) Look for M<room> tokens like M1A2, M4.5, M5.04
    for i, tok in enumerate(flat):
        if tok.startswith("M") and len(tok) > 1:
            cand = tok[1:]
            if re.fullmatch(r"\d+[A-Z]\d+", cand) or re.fullmatch(r"\d+(?:\.\d+)?", cand):
                room = cand
                room_idx = i
                break

    # 2) Look for compact form like 054S05
    if room is None:
        for i, tok in enumerate(flat):
            m = re.fullmatch(r"(\d{3})S(\d{2})", tok)
            if m:
                abc = m.group(1)
                # Map 3-digit code "054" -> room 5.04 (b=5, c=4)
                major = int(abc[1])
                minor = int(abc[2])
                room = f"{major}.{minor:02d}"
                room_idx = i
                break

    cage = None
    mode = None
    # Mode / cage is typically the token after room: OC or S<n>
    if room_idx is not None and room_idx + 1 < len(flat):
        nxt = flat[room_idx + 1]
        if re.fullmatch(r"OC", nxt, re.IGNORECASE):
            mode = "OC"
            cage = None
        elif re.fullmatch(r"S\d+", nxt, re.IGNORECASE):
            mode = "S"
            cage = "S" + str(int(re.sub(r"\D", "", nxt)))
        else:
            # If room was compact "054S05", cage may be embedded
            pass

    # Embedded cage for compact token
    if cage is None:
        for tok in flat:
            m = re.fullmatch(r"\d{3}S(\d{2})", tok)
            if m:
                mode = "S"
                cage = "S" + str(int(m.group(1)))
                break

    return room, cage, mode


def normalize_customer_room_display(room: Optional[str]) -> Optional[str]:
    if not room:
        return None
    r = str(room).strip()
    if r.startswith("M"):
        r = r[1:]
    # numeric rooms like 5.04 -> store as M5.04
    if re.fullmatch(r"\d+(?:\.\d+)?", r):
        return "M" + r
    # alpha rooms like 1A2
    return r


def _get_pp_id_by_pp_number(db: Session, pp_number: str) -> Optional[int]:
    """Resolve patchpanel_instances.id by pp_number.

    In our DB, patchpanel_instances.pp_number may contain either:
    - digits only (e.g. "1071186")
    - or full form (e.g. "PP:0307:1071186")

    This helper accepts both and tries both variants.
    """
    if not pp_number:
        return None
    s = str(pp_number).strip()

    # If full PP form is passed, also try the numeric part
    num_only = None
    m = PP_RE.match(s)
    if m:
        num_only = m.group(2).strip()

    row = db.execute(
        text(
            """
            SELECT id
            FROM public.patchpanel_instances
            WHERE pp_number = :pp
               OR (:num_only IS NOT NULL AND pp_number = :num_only)
            ORDER BY id
            LIMIT 1
            """
        ),
        {"pp": s, "num_only": num_only},
    ).mappings().first()
    return int(row["id"]) if row else None


def _list_reserved_ports_for_jobwide(db: Session, exclude_cc_id: int | None = None) -> Dict[str, set]:
    """Return reserved ports by instance_id across cross_connects.

    We treat these statuses as reserving the port.
    """
    where = "WHERE status IN ('planned','review','in_progress','done','troubleshoot','pending_serial','active')"
    params = {}
    if exclude_cc_id is not None:
        where += " AND id <> :exclude_id"
        params["exclude_id"] = int(exclude_cc_id)

    rows = db.execute(
        text(
            f"""
            SELECT
              NULLIF(backbone_in_instance_id,'') AS bi_i,
              NULLIF(backbone_in_port_label,'')  AS bi_p,
              NULLIF(backbone_out_instance_id,'') AS bo_i,
              NULLIF(backbone_out_port_label,'')  AS bo_p
            FROM public.cross_connects
            {where}
            """
        ),
        params,
    ).mappings().all()
    m: Dict[str, set] = {}
    for r in rows:
        for inst, port in ((r.get("bi_i"), r.get("bi_p")), (r.get("bo_i"), r.get("bo_p"))):
            if inst and port:
                m.setdefault(str(inst), set()).add(str(port))
    return m


# ---------------------------------------------------------------------------
# Deduplication helpers (current-state view)
# ---------------------------------------------------------------------------

def _compute_group_key(row: dict) -> str:
    """Compute the grouping key for a migration audit line.

    Priority:
    1. serial_number  (most reliable circuit identifier)
    2. product_id     (fallback)
    3. switch + port + z_pp + z_port  (technical fallback)
    """
    sn = (row.get("serial_number") or "").strip()
    if sn:
        return f"serial:{sn}"
    pid = (row.get("product_id") or "").strip()
    if pid:
        return f"product:{pid}"
    parts = [
        (row.get("switch_name") or "").strip(),
        (row.get("switch_port") or "").strip(),
        (row.get("z_pp_number") or "").strip(),
        (row.get("z_port_label") or "").strip(),
    ]
    return f"tech:{':'.join(parts)}"


def _detect_event_type(prev: dict, curr: dict) -> str:
    """Detect what changed between two consecutive states of the same circuit.

    Returns one of: Install, Line Move, Path Move, A-Update, Z-Update, Update
    """
    sw_changed = (
        (prev.get("switch_name") or "") != (curr.get("switch_name") or "")
        or (prev.get("switch_port") or "") != (curr.get("switch_port") or "")
    )
    a_pp_changed = (
        (prev.get("a_pp_number") or "") != (curr.get("a_pp_number") or "")
        or (prev.get("a_port_label") or "") != (curr.get("a_port_label") or "")
    )
    z_pp_changed = (
        (prev.get("z_pp_number") or "") != (curr.get("z_pp_number") or "")
        or (prev.get("z_port_label") or "") != (curr.get("z_port_label") or "")
    )
    bb_changed = (
        (prev.get("backbone_in_instance_id") or "") != (curr.get("backbone_in_instance_id") or "")
        or (prev.get("backbone_out_instance_id") or "") != (curr.get("backbone_out_instance_id") or "")
    )

    # Line Move: switch/port changed (physical relocation of the circuit endpoint)
    if sw_changed:
        return "Line Move"
    # Path Move: backbone/patching changed but endpoints stay the same
    if bb_changed or (a_pp_changed and z_pp_changed):
        return "Path Move"
    # Only A-side changed
    if a_pp_changed:
        return "A-Update"
    # Only Z-side changed
    if z_pp_changed:
        return "Z-Update"
    # Something else changed (customer name, room, etc.)
    return "Update"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _build_port_occupancy_map(db: Session) -> Dict[str, dict]:
    """Build map of occupied ports: 'pp_instance_id:port_label' -> {serial, switch_name, switch_port, customer_pp, ...}.

    We query patchpanel_ports that are occupied, along with any cross_connect
    that references them (by a_patchpanel_id, customer_patchpanel_id, backbone_in, backbone_out).
    """
    occ_rows = db.execute(text("""
        SELECT
            pi.instance_id AS pp_instance_id,
            pp.port_label,
            pp.connected_to,
            cc.serial,
            cc.switch_name, cc.switch_port,
            z_pi.instance_id AS customer_pp,
            cc.status AS cc_status,
            cc.id AS cc_id
        FROM patchpanel_ports pp
        JOIN patchpanel_instances pi ON pi.id = pp.patchpanel_id
        LEFT JOIN cross_connects cc ON (
            (cc.a_patchpanel_id = pi.instance_id AND cc.a_port_label = pp.port_label)
            OR (cc.customer_patchpanel_id = pp.patchpanel_id AND cc.customer_port_label = pp.port_label)
            OR (cc.z_pp_number = pi.instance_id AND cc.customer_port_label = pp.port_label)
            OR (cc.backbone_in_instance_id = pi.instance_id AND cc.backbone_in_port_label = pp.port_label)
            OR (cc.backbone_out_instance_id = pi.instance_id AND cc.backbone_out_port_label = pp.port_label)
        )
        LEFT JOIN patchpanel_instances z_pi ON z_pi.id = cc.customer_patchpanel_id
        WHERE pp.status = 'occupied'
           OR (pp.connected_to IS NOT NULL AND pp.connected_to != '')
    """)).mappings().all()
    m: Dict[str, dict] = {}
    for r in occ_rows:
        key = f"{r['pp_instance_id']}:{r['port_label']}"
        entry = {
            "serial": r.get("serial") or "",
            "switch_name": r.get("switch_name") or "",
            "switch_port": r.get("switch_port") or "",
            "customer_pp": r.get("customer_pp") or "",
            "connected_to": r.get("connected_to") or "",
            "cc_status": r.get("cc_status") or "",
            "cc_id": r.get("cc_id"),
        }
        if key not in m:
            m[key] = entry
        elif (entry.get("serial") or entry.get("cc_id")) and not m[key].get("serial"):
            # Prefer entry with actual CC data over one without
            m[key] = entry
    return m


@router.get("/list")
def list_audit_lines(
    status: str = "imported",
    page: int = 1,
    page_size: int = 100,
    view: str = "current",
    db: Session = Depends(get_db),
):
    """List migration-audit lines with conflict classification and pagination.

    view=current (default): only the latest state per circuit (grouped by serial/product_id).
    view=all: show every imported row (legacy behaviour).
    """

    if status not in {"imported", "audited", "needs_review", "rejected"}:
        status = "imported"
    if view not in {"current", "all"}:
        view = "current"

    has_ln = has_column(db, "migration_audit_lines", "logical_name")
    ln_sel = ", logical_name" if has_ln else ", NULL::text AS logical_name"

    # Get total count
    total_row = db.execute(
        text("SELECT COUNT(*) AS cnt FROM public.migration_audit_lines WHERE audit_status = :st"),
        {"st": status},
    ).mappings().first()
    total = int(total_row["cnt"]) if total_row else 0

    rows = db.execute(
        text(
            f"""
            SELECT
              id,
              source_file,
              source_row,
              customer_name,
              system_name,
              room,
              rack_code,
              switch_name,
              switch_port{ln_sel},
              a_pp_raw,
              a_pp_number,
              a_port_label,
              a_eqx_port,
              z_pp_raw,
              z_pp_number,
              z_port_label,
              z_eqx_port,
              pp1_raw,
              pp1_number,
              pp1_port_label,
              pp1_eqx_port,
              pp2_raw,
              pp2_number,
              pp2_port_label,
              pp2_eqx_port,
              product_id,
              serial_number,
              backbone_in_instance_id,
              backbone_in_port_label,
              backbone_out_instance_id,
              backbone_out_port_label,
              audit_status,
              audited_by,
              audited_at,
              linked_cc_id
            FROM public.migration_audit_lines
            WHERE audit_status = :st
            ORDER BY id
            """
        ),
        {"st": status},
    ).mappings().all()

    # ── Current-state deduplication ──
    # Group rows by circuit identity and keep only the latest per group.
    all_rows_count = len(rows)
    group_map: Dict[str, List[dict]] = {}  # group_key -> [row_dicts ordered by id]
    rows_as_dicts = [dict(r) for r in rows]

    for rd in rows_as_dicts:
        gk = _compute_group_key(rd)
        rd["_group_key"] = gk
        group_map.setdefault(gk, []).append(rd)

    # Determine event_type + is_current for every row
    discarded_old_count = 0
    for gk, members in group_map.items():
        members.sort(key=lambda x: x["id"])  # oldest first
        for i, m in enumerate(members):
            m["_is_current"] = (i == len(members) - 1)
            m["_history_count"] = len(members)
            if i == 0:
                m["_event_type"] = "Install"
            else:
                m["_event_type"] = _detect_event_type(members[i - 1], m)
            if not m["_is_current"]:
                discarded_old_count += 1

    if view == "current":
        rows_for_display = [rd for rd in rows_as_dicts if rd["_is_current"]]
    else:
        rows_for_display = rows_as_dicts

    # ── Conflict analysis ──

    # 1) Excel-internal duplicates (A-side / Z-side)
    a_key_count: Dict[str, int] = {}
    z_key_count: Dict[str, int] = {}
    a_key_ids: Dict[str, List[int]] = {}
    z_key_ids: Dict[str, List[int]] = {}
    a_key_serials: Dict[str, List[str]] = {}
    z_key_serials: Dict[str, List[str]] = {}
    for r in rows_for_display:
        ak = f"{r.get('a_pp_number') or ''}:{r.get('a_port_label') or ''}".strip(':')
        zk = f"{r.get('z_pp_number') or ''}:{r.get('z_port_label') or ''}".strip(':')
        sn = (r.get("serial_number") or "").strip()
        if ak and ':' in ak:
            a_key_count[ak] = a_key_count.get(ak, 0) + 1
            a_key_ids.setdefault(ak, []).append(r["id"])
            a_key_serials.setdefault(ak, []).append(sn)
        if zk and ':' in zk:
            z_key_count[zk] = z_key_count.get(zk, 0) + 1
            z_key_ids.setdefault(zk, []).append(r["id"])
            z_key_serials.setdefault(zk, []).append(sn)

    # 2) BB reserved ports from existing cross_connects
    reserved_by_instance = _list_reserved_ports_for_jobwide(db)

    # 3) Port occupancy from patchpanel_ports (A-side + Z-side real conflicts)
    port_occ = _build_port_occupancy_map(db)

    # 4) Secondary Z-side CC lookup: cross_connects by z_pp_number + customer_port_label
    #    (catches cases where port is occupied but generic LEFT JOIN missed the CC)
    z_cc_lookup: Dict[str, dict] = {}
    try:
        z_cc_rows = db.execute(text("""
            SELECT cc.z_pp_number, cc.customer_port_label,
                   cc.serial, cc.switch_name, cc.switch_port,
                   cc.id AS cc_id,
                   pi.instance_id AS customer_pp_instance
            FROM cross_connects cc
            LEFT JOIN patchpanel_instances pi ON pi.id = cc.customer_patchpanel_id
            WHERE cc.status = 'active'
              AND cc.z_pp_number IS NOT NULL
              AND cc.customer_port_label IS NOT NULL
        """)).mappings().all()
        for zr in z_cc_rows:
            zkey = f"{zr['z_pp_number']}:{zr['customer_port_label']}"
            z_cc_lookup[zkey] = {
                "serial": zr.get("serial") or "",
                "switch_name": zr.get("switch_name") or "",
                "switch_port": zr.get("switch_port") or "",
                "customer_pp": zr.get("customer_pp_instance") or zr.get("z_pp_number") or "",
                "cc_id": zr.get("cc_id"),
            }
    except Exception:
        pass  # non-critical enrichment

    # ── Build items with conflict details + classification ──
    items_cat0: List[Dict[str, Any]] = []  # no errors
    items_cat1: List[Dict[str, Any]] = []  # single-side conflict
    items_cat2: List[Dict[str, Any]] = []  # both-sides conflict

    for r in rows_for_display:
        ak = f"{r.get('a_pp_number') or ''}:{r.get('a_port_label') or ''}".strip(':')
        zk = f"{r.get('z_pp_number') or ''}:{r.get('z_port_label') or ''}".strip(':')

        a_conflicts = []
        z_conflicts = []

        # Excel duplicates
        if ak and a_key_count.get(ak, 0) > 1:
            dup_ids = [x for x in a_key_ids.get(ak, []) if x != r["id"]]
            dup_sn = [s for i, s in zip(a_key_ids.get(ak, []), a_key_serials.get(ak, [])) if i != r["id"] and s]
            a_conflicts.append({
                "type": "excel_dup",
                "msg": "A-Seite Port doppelt im Excel",
                "dup_line_ids": dup_ids,
                "dup_serials": dup_sn,
            })
        if zk and z_key_count.get(zk, 0) > 1:
            dup_ids = [x for x in z_key_ids.get(zk, []) if x != r["id"]]
            dup_sn = [s for i, s in zip(z_key_ids.get(zk, []), z_key_serials.get(zk, [])) if i != r["id"] and s]
            z_conflicts.append({
                "type": "excel_dup",
                "msg": "Z-Seite Port doppelt im Excel",
                "dup_line_ids": dup_ids,
                "dup_serials": dup_sn,
            })

        # A-side port occupied in DB
        if ak and ':' in ak:
            occ = port_occ.get(ak)
            if occ:
                a_conflicts.append({
                    "type": "port_occupied",
                    "msg": "A-Seite Port bereits belegt",
                    "serial": occ.get("serial", ""),
                    "switch_name": occ.get("switch_name", ""),
                    "switch_port": occ.get("switch_port", ""),
                    "cc_id": occ.get("cc_id"),
                })

        # Z-side port occupied in DB
        if zk and ':' in zk:
            occ = port_occ.get(zk)
            if occ:
                # Enrich with secondary CC lookup if port_occ has no CC details
                cc_extra = z_cc_lookup.get(zk, {})
                z_serial = occ.get("serial") or cc_extra.get("serial", "")
                z_switch = occ.get("switch_name") or cc_extra.get("switch_name", "")
                z_swport = occ.get("switch_port") or cc_extra.get("switch_port", "")
                z_custpp = occ.get("customer_pp") or cc_extra.get("customer_pp", "")
                z_cc_id  = occ.get("cc_id") or cc_extra.get("cc_id")

                # 3rd fallback: if still no serial, check OTHER audit lines
                # that claim the same z_pp:port (self-occupancy from import)
                z_occ_serials_list: List[str] = []
                if not z_serial and zk in z_key_ids:
                    other_ids = [x for x in z_key_ids[zk] if x != r["id"]]
                    other_sn = [
                        s for i, s in zip(z_key_ids[zk], z_key_serials.get(zk, []))
                        if i != r["id"] and s
                    ]
                    if other_sn:
                        z_occ_serials_list = other_sn
                    elif not other_ids:
                        # Port is occupied but only THIS line uses it → self-occupation, skip conflict
                        occ = None

                if occ:
                    conflict_entry: Dict[str, Any] = {
                        "type": "port_occupied",
                        "msg": "Z-Seite Port bereits belegt",
                        "serial": z_serial,
                        "switch_name": z_switch,
                        "switch_port": z_swport,
                        "customer_pp": z_custpp,
                        "connected_to": occ.get("connected_to", ""),
                        "cc_id": z_cc_id,
                    }
                    if z_occ_serials_list:
                        conflict_entry["occupied_by_serials"] = z_occ_serials_list
                    # Also include the PP number for display
                    z_pp_num = (r.get("z_pp_number") or "").strip()
                    if z_pp_num:
                        conflict_entry["pp"] = z_pp_num
                    z_conflicts.append(conflict_entry)

        # BB reserved
        bi_i = (r.get("backbone_in_instance_id") or "").strip()
        bi_p = (r.get("backbone_in_port_label") or "").strip()
        bo_i = (r.get("backbone_out_instance_id") or "").strip()
        bo_p = (r.get("backbone_out_port_label") or "").strip()
        if bi_i and bi_p and bi_p in reserved_by_instance.get(bi_i, set()):
            a_conflicts.append({"type": "bb_reserved", "msg": "BB IN Port bereits reserviert"})
        if bo_i and bo_p and bo_p in reserved_by_instance.get(bo_i, set()):
            z_conflicts.append({"type": "bb_reserved", "msg": "BB OUT Port bereits reserviert"})

        # Legacy flat conflicts list (backward compat)
        conflicts = [c["msg"] for c in a_conflicts] + [c["msg"] for c in z_conflicts]

        # Classify
        has_a = len(a_conflicts) > 0
        has_z = len(z_conflicts) > 0
        if has_a and has_z:
            conflict_category = 2
        elif has_a or has_z:
            conflict_category = 1
        else:
            conflict_category = 0

        item = dict(r)
        item["conflicts"] = conflicts
        item["a_conflicts"] = a_conflicts
        item["z_conflicts"] = z_conflicts
        item["conflict_category"] = conflict_category
        item["ready"] = (conflict_category == 0) and bool(bi_i and bi_p and bo_i and bo_p)
        item["event_type"] = r.get("_event_type", "Install")
        item["history_count"] = r.get("_history_count", 1)
        item["group_key"] = r.get("_group_key", "")

        if conflict_category == 2:
            items_cat2.append(item)
        elif conflict_category == 1:
            items_cat1.append(item)
        else:
            items_cat0.append(item)

    # Combine: cat2 first (worst), then cat1, then cat0 (clean)
    all_items = items_cat2 + items_cat1 + items_cat0

    # Pagination
    total_items = len(all_items)
    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 100
    start = (page - 1) * page_size
    end = start + page_size
    paged = all_items[start:end]
    total_pages = max(1, (total_items + page_size - 1) // page_size)

    return {
        "success": True,
        "items": paged,
        "total": total_items,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "view": view,
        "counts": {
            "errors_both": len(items_cat2),
            "errors_single": len(items_cat1),
            "clean": len(items_cat0),
        },
        "dedup": {
            "total_imported": all_rows_count,
            "current_lines": all_rows_count - discarded_old_count,
            "discarded_old": discarded_old_count,
        },
    }


@router.get("/history")
def get_line_history(
    line_id: int = 0,
    group_key: str = "",
    db: Session = Depends(get_db),
):
    """Return all historical states for a given circuit.

    Can look up by line_id (computes group_key from the line) or by group_key directly.
    """
    has_ln = has_column(db, "migration_audit_lines", "logical_name")
    ln_sel = ", logical_name" if has_ln else ", NULL::text AS logical_name"

    rows = db.execute(
        text(
            f"""
            SELECT
              id, source_file, source_row,
              customer_name, system_name, room, rack_code,
              switch_name, switch_port{ln_sel},
              a_pp_raw, a_pp_number, a_port_label, a_eqx_port,
              z_pp_raw, z_pp_number, z_port_label, z_eqx_port,
              pp1_raw, pp1_number, pp1_port_label, pp1_eqx_port,
              pp2_raw, pp2_number, pp2_port_label, pp2_eqx_port,
              product_id, serial_number,
              backbone_in_instance_id, backbone_in_port_label,
              backbone_out_instance_id, backbone_out_port_label,
              audit_status, audited_by, audited_at, linked_cc_id
            FROM public.migration_audit_lines
            ORDER BY id
            """
        ),
    ).mappings().all()

    all_dicts = [dict(r) for r in rows]
    for rd in all_dicts:
        rd["_group_key"] = _compute_group_key(rd)

    # Determine the target group_key
    target_gk = (group_key or "").strip()
    if not target_gk and line_id:
        for rd in all_dicts:
            if rd["id"] == int(line_id):
                target_gk = rd["_group_key"]
                break

    if not target_gk:
        raise HTTPException(400, "line_id or group_key required")

    members = [rd for rd in all_dicts if rd["_group_key"] == target_gk]
    members.sort(key=lambda x: x["id"])

    # Annotate event_type
    for i, m in enumerate(members):
        if i == 0:
            m["event_type"] = "Install"
        else:
            m["event_type"] = _detect_event_type(members[i - 1], m)
        m["is_current"] = (i == len(members) - 1)
        m["group_key"] = target_gk

    return {
        "success": True,
        "group_key": target_gk,
        "history": members,
        "count": len(members),
    }


@router.delete("/{audit_id}", dependencies=[Depends(require_permissions("audit:write"))])
def delete_audit_line(
    audit_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Delete a single migration_audit_lines row."""
    row = db.execute(
        text("SELECT id, serial_number, switch_name FROM public.migration_audit_lines WHERE id = :id"),
        {"id": int(audit_id)},
    ).mappings().first()
    if not row:
        raise HTTPException(404, "Audit line not found")
    db.execute(
        text("DELETE FROM public.migration_audit_lines WHERE id = :id"),
        {"id": int(audit_id)},
    )
    db.commit()
    write_audit_log(
        db,
        user_id=current_user.get("user_id") if isinstance(current_user, dict) else None,
        action="delete_audit_line",
        entity_type="migration_audit_lines",
        entity_id=audit_id,
        details=f"Deleted audit line {audit_id} (serial={row.get('serial_number','')}, switch={row.get('switch_name','')})",
    )
    return {"success": True, "deleted_id": audit_id}


@router.post("/import", dependencies=[Depends(require_permissions("upload:write"))])
async def import_audit_xlsb(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Import the active lines from the provided XLSB into migration_audit_lines.

    We intentionally do NOT create cross_connects here.
    """

    if open_workbook is None:
        raise HTTPException(500, "pyxlsb not installed")

    if not file.filename:
        raise HTTPException(400, "Missing filename")

    content = await file.read()
    # Save to temp (pyxlsb needs a path)
    import tempfile

    with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsb") as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    inserted = 0
    skipped = 0
    errors: List[str] = []

    try:
        with open_workbook(tmp_path) as wb:
            if "Dateie" not in wb.sheets:
                raise HTTPException(400, "Sheet 'Dateie' not found")
            with wb.get_sheet("Dateie") as sh:
                it = sh.rows()
                header = [c.v for c in next(it)]

                # Build column indices by header names (robust against column order).
                # The workbook contains repeated column names like "Port"/"EQX Port",
                # so we anchor them relative to the PP columns (PP A, PP 1., PP 2., PP Z).
                def _hnorm(x):
                    if x is None:
                        return ""
                    s = str(x).strip().lower()
                    s = re.sub(r"\s+", " ", s)
                    s = s.replace("?", "")
                    return s

                # trim trailing empty header cells
                last = 0
                for i, v in enumerate(header):
                    if v not in (None, ""):
                        last = i
                header = header[: last + 1]

                hmap: dict[str, list[int]] = {}
                for i, name in enumerate(header):
                    k = _hnorm(name)
                    if not k:
                        continue
                    hmap.setdefault(k, []).append(i)

                def _find_one(*aliases: str) -> int | None:
                    for a in aliases:
                        k = _hnorm(a)
                        if k in hmap and hmap[k]:
                            return hmap[k][0]
                    return None

                def _find_pp_block(*pp_labels: str) -> tuple[int | None, int | None, int | None]:
                    """Find a PP block (PP column + following Port + EQX Port).

                    The XLSB headers vary slightly ("PP 1." vs "PP 1" vs "PP1").
                    We therefore accept multiple aliases.
                    """
                    i = _find_one(*pp_labels)
                    if i is None:
                        return None, None, None
                    port_i = i + 1 if i + 1 < len(header) else None
                    eqx_i = i + 2 if i + 2 < len(header) else None
                    return i, port_i, eqx_i

                IDX = {
                    "trunk": _find_one("Trunk"),
                    "loc_a_room": _find_one("Loc A: Room", "Loc A Room"),
                    "logical_name": _find_one("LOGICAL NAME", "Logical Name"),
                    "customer_name": _find_one("Customer Name"),
                    "system_name": _find_one("System Name"),
                    "rfra_ports": _find_one("RFRAPorts", "RFRA Ports"),
                    "serial": _find_one("Serial"),
                    "product_id": _find_one("Product ID", "ProductID"),
                    "active": _find_one("Active Line ?", "Active Line"),
                }

                pp_a_i, pp_a_port_i, pp_a_eqx_i = _find_pp_block("PP A", "PP A.")
                pp1_i, pp1_port_i, pp1_eqx_i = _find_pp_block("PP 1.", "PP 1", "PP1")
                pp2_i, pp2_port_i, pp2_eqx_i = _find_pp_block("PP 2.", "PP 2", "PP2")
                pp_z_i, pp_z_port_i, pp_z_eqx_i = _find_pp_block("PP Z", "PP Z.")

                for row_idx, row in enumerate(it, start=2):
                    vals = [c.v for c in row]
                    if not vals:
                        continue

                    def _cell(i: int | None):
                        return vals[i] if i is not None and i < len(vals) else None

                    active_flag = str(_cell(IDX["active"]) or "").strip().lower()
                    if active_flag not in {"yes", "y", "1", "true"}:
                        continue

                    system_name = str(_cell(IDX["system_name"]) or "").strip()
                    customer_name = str(_cell(IDX["customer_name"]) or "").strip()

                    # Excel columns
                    logical_name = str(_cell(IDX["logical_name"]) or "").strip()
                    rfra_ports_raw = str(_cell(IDX["rfra_ports"]) or "").strip()

                    # Desired normalization:
                    # - switch_name   = real switch (e.g. RFRA3312)
                    # - switch_port   = ETH1/...
                    # - logical_name  = Excel LOGICAL NAME
                    sw_name, sw_port = parse_switch_and_port(rfra_ports_raw)
                    switch_name = (sw_name or "").strip()
                    switch_port = (sw_port or "").strip()

                    pp_a_raw = str(_cell(pp_a_i) or "").strip()
                    pp_a_port = str(_cell(pp_a_port_i) or "").strip()
                    pp_z_raw = str(_cell(pp_z_i) or "").strip()
                    pp_z_port = str(_cell(pp_z_port_i) or "").strip()

                    a_eqx_port = str(_cell(pp_a_eqx_i) or "").strip()
                    z_eqx_port = str(_cell(pp_z_eqx_i) or "").strip()

                    pp1_raw = str(_cell(pp1_i) or "").strip()
                    pp1_port = str(_cell(pp1_port_i) or "").strip()
                    pp1_eqx = str(_cell(pp1_eqx_i) or "").strip()

                    pp2_raw = str(_cell(pp2_i) or "").strip()
                    pp2_port = str(_cell(pp2_port_i) or "").strip()
                    pp2_eqx = str(_cell(pp2_eqx_i) or "").strip()

                    _, pp1_number = parse_pp(pp1_raw)
                    _, pp2_number = parse_pp(pp2_raw)
                    rack_code, z_pp_num_only = parse_pp(pp_z_raw)
                    a_rack_code, a_pp_num_only = parse_pp(pp_a_raw)

                    # Room is A-side room (most important). Prefer explicit Excel column.
                    room = str(_cell(IDX["loc_a_room"]) or "").strip() or None
                    if not room:
                        # fallback: try parse from system name (best effort)
                        room = parse_room_from_system_name(system_name)

                    # Store PP numbers in full form to match patchpanel_instances.pp_number
                    a_pp_number = normalize_pp_full(pp_a_raw, a_rack_code, a_pp_num_only)
                    z_pp_number = normalize_pp_full(pp_z_raw, rack_code, z_pp_num_only)

                    serial_number = normalize_trailing_dot_zero(_cell(IDX["serial"]))
                    product_id = normalize_trailing_dot_zero(_cell(IDX["product_id"]))

                    # minimum required fields
                    if not (switch_name and switch_port and a_pp_number and pp_a_port and z_pp_number and pp_z_port):
                        skipped += 1
                        continue

                    # -----------------------------------------------------------------
                    # Prefill BB IN / BB OUT from Excel
                    #
                    # As per current process definition:
                    #   - BB IN patchpanel+port come from Excel block "PP 1." (+ its Port)
                    #   - BB OUT patchpanel+port come from Excel block "PP 2." (+ its Port)
                    #
                    # Stored in migration_audit_lines.backbone_* fields so UI can show
                    # them immediately; auditor can overwrite via the modal.
                    # -----------------------------------------------------------------
                    # Note: backbone_* fields are stored as TEXT in our schema (instance_id strings).
                    # We therefore keep the Excel labels as-is, and allow the auditor to override.
                    bb_in_instance_id = str(pp1_raw).strip() if pp1_raw else None
                    bb_out_instance_id = str(pp2_raw).strip() if pp2_raw else None

                    bb_in_port_label = str(pp1_port).strip() if pp1_port else None
                    bb_out_port_label = str(pp2_port).strip() if pp2_port else None

                    # De-dup: same switch_name+switch_port+z_pp_number+z_port
                    # If the line already exists, we *update* missing Excel-derived
                    # fields (esp. BB IN/OUT) instead of skipping, so re-importing the
                    # same file after code changes repairs old rows.
                    exists = db.execute(
                        text(
                            """
                            SELECT id,
                                   backbone_in_instance_id,
                                   backbone_in_port_label,
                                   backbone_out_instance_id,
                                   backbone_out_port_label
                            FROM public.migration_audit_lines
                            WHERE switch_name = :sn
                              AND switch_port = :sp
                              AND z_pp_number = :zpp
                              AND z_port_label = :zp
                              AND audit_status IN ('imported','needs_review')
                            LIMIT 1
                            """
                        ),
                        {"sn": switch_name, "sp": switch_port, "zpp": z_pp_number, "zp": pp_z_port},
                    ).mappings().first()
                    if exists:
                        # only fill if currently empty
                        upd = {
                            "id": exists["id"],
                            "bb_in_i": bb_in_instance_id,
                            "bb_in_p": bb_in_port_label,
                            "bb_out_i": bb_out_instance_id,
                            "bb_out_p": bb_out_port_label,
                            "a_raw": pp_a_raw,
                            "app": a_pp_number,
                            "aport": pp_a_port,
                            "a_eqx": a_eqx_port,
                            "z_raw": pp_z_raw,
                            "zpp": z_pp_number,
                            "zport": pp_z_port,
                            "z_eqx": z_eqx_port,
                            "p1_raw": pp1_raw,
                            "p1_num": pp1_number,
                            "p1_port": pp1_port,
                            "p1_eqx": pp1_eqx,
                            "p2_raw": pp2_raw,
                            "p2_num": pp2_number,
                            "p2_port": pp2_port,
                            "p2_eqx": pp2_eqx,
                            "pid": product_id,
                            "ser": serial_number,
                            "room": room,
                            "rack": rack_code,
                            "cn": customer_name,
                            "sys": system_name,
                            "ln": logical_name,
                        }

                        has_ln = has_column(db, "migration_audit_lines", "logical_name")
                        ln_set = "logical_name = COALESCE(NULLIF(logical_name,''), :ln)," if has_ln else ""

                        db.rollback()
                        with db.begin():
                            db.execute(
                                text(
                                    f"""
                                UPDATE public.migration_audit_lines
                                SET
                                  source_file = COALESCE(source_file, :sf),
                                  source_row  = COALESCE(source_row, :sr),
                                  customer_name = COALESCE(NULLIF(customer_name,''), :cn),
                                  system_name   = COALESCE(NULLIF(system_name,''), :sys),
                                  {ln_set}
                                  room          = COALESCE(NULLIF(room,''), :room),
                                  rack_code     = COALESCE(NULLIF(rack_code,''), :rack),

                                  a_pp_raw     = COALESCE(NULLIF(a_pp_raw,''), :a_raw),
                                  a_pp_number  = COALESCE(NULLIF(a_pp_number,''), :app),
                                  a_port_label = COALESCE(NULLIF(a_port_label,''), :aport),
                                  a_eqx_port   = COALESCE(NULLIF(a_eqx_port,''), :a_eqx),

                                  z_pp_raw     = COALESCE(NULLIF(z_pp_raw,''), :z_raw),
                                  z_pp_number  = COALESCE(NULLIF(z_pp_number,''), :zpp),
                                  z_port_label = COALESCE(NULLIF(z_port_label,''), :zport),
                                  z_eqx_port   = COALESCE(NULLIF(z_eqx_port,''), :z_eqx),

                                  pp1_raw        = COALESCE(NULLIF(pp1_raw,''), :p1_raw),
                                  pp1_number     = COALESCE(NULLIF(pp1_number,''), :p1_num),
                                  pp1_port_label = COALESCE(NULLIF(pp1_port_label,''), :p1_port),
                                  pp1_eqx_port   = COALESCE(NULLIF(pp1_eqx_port,''), :p1_eqx),

                                  pp2_raw        = COALESCE(NULLIF(pp2_raw,''), :p2_raw),
                                  pp2_number     = COALESCE(NULLIF(pp2_number,''), :p2_num),
                                  pp2_port_label = COALESCE(NULLIF(pp2_port_label,''), :p2_port),
                                  pp2_eqx_port   = COALESCE(NULLIF(pp2_eqx_port,''), :p2_eqx),

                                  product_id    = COALESCE(NULLIF(product_id,''), :pid),
                                  serial_number = COALESCE(NULLIF(serial_number,''), :ser),

                                  backbone_in_instance_id  = COALESCE(NULLIF(backbone_in_instance_id,''), :bb_in_i),
                                  backbone_in_port_label   = COALESCE(NULLIF(backbone_in_port_label,''), :bb_in_p),
                                  backbone_out_instance_id = CASE
                                        WHEN backbone_out_instance_id IS NULL OR backbone_out_instance_id = '' THEN :bb_out_i
                                        WHEN backbone_out_instance_id ILIKE 'PP:%' THEN :bb_out_i
                                        ELSE backbone_out_instance_id
                                  END,
                                  backbone_out_port_label  = CASE
                                        WHEN backbone_out_port_label IS NULL OR backbone_out_port_label = '' THEN :bb_out_p
                                        WHEN backbone_out_instance_id ILIKE 'PP:%' THEN :bb_out_p
                                        ELSE backbone_out_port_label
                                  END
                                WHERE id = :id
                                    """
                                ),
                                {**upd, "sf": file.filename, "sr": int(row_idx)},
                            )

                        skipped += 1
                        continue

                    has_ln = has_column(db, "migration_audit_lines", "logical_name")
                    ln_cols = ", logical_name" if has_ln else ""
                    ln_vals = ", :ln" if has_ln else ""

                    db.rollback()
                    with db.begin():
                        db.execute(
                            text(
                                f"""
                            INSERT INTO public.migration_audit_lines (
                              source_file, source_row,
                              customer_name, system_name,
                              room, rack_code,
                              switch_name, switch_port{ln_cols},

                              a_pp_raw, a_pp_number, a_port_label, a_eqx_port,
                              z_pp_raw, z_pp_number, z_port_label, z_eqx_port,

                              pp1_raw, pp1_number, pp1_port_label, pp1_eqx_port,
                              pp2_raw, pp2_number, pp2_port_label, pp2_eqx_port,

                              product_id, serial_number,
                              backbone_in_instance_id,
                              backbone_in_port_label,
                              backbone_out_instance_id,
                              backbone_out_port_label,
                              audit_status
                            ) VALUES (
                              :sf, :sr,
                              :cn, :sys,
                              :room, :rack,
                              :sw, :sp{ln_vals},

                              :a_raw, :app, :aport, :a_eqx,
                              :z_raw, :zpp, :zport, :z_eqx,

                              :p1_raw, :p1_num, :p1_port, :p1_eqx,
                              :p2_raw, :p2_num, :p2_port, :p2_eqx,

                              :pid, :ser,
                              :bb_in_i, :bb_in_p,
                              :bb_out_i, :bb_out_p,
                              'imported'
                            )
                                """
                            ),
                            {
                                "sf": file.filename,
                                "sr": int(row_idx),
                                "cn": customer_name,
                                "sys": system_name,
                                "room": room,
                                "rack": rack_code,
                                "sw": switch_name,
                                "sp": switch_port,
                                "ln": logical_name,

                                "a_raw": pp_a_raw,
                                "app": a_pp_number,
                                "aport": pp_a_port,
                                "a_eqx": a_eqx_port,

                                "z_raw": pp_z_raw,
                                "zpp": z_pp_number,
                                "zport": pp_z_port,
                                "z_eqx": z_eqx_port,

                                "p1_raw": pp1_raw,
                                "p1_num": pp1_number,
                                "p1_port": pp1_port,
                                "p1_eqx": pp1_eqx,

                                "p2_raw": pp2_raw,
                                "p2_num": pp2_number,
                                "p2_port": pp2_port,
                                "p2_eqx": pp2_eqx,

                                "pid": product_id,
                                "ser": serial_number,

                                "bb_in_i": bb_in_instance_id,
                                "bb_in_p": bb_in_port_label,
                                "bb_out_i": bb_out_instance_id,
                                "bb_out_p": bb_out_port_label,
                            },
                        )
                    inserted += 1

        db.rollback()
        with db.begin():
            write_audit_log(
                db,
                user_id=current_user.get("id") if isinstance(current_user, dict) else None,
                action="migration_audit_import",
                entity_type="migration_audit_batch",
                entity_id=None,
                details={
                    "file": file.filename,
                    "inserted": inserted,
                    "skipped": skipped,
                    "errors": len(errors),
                },
            )
    except HTTPException:
        db.rollback()
        with db.begin():
            write_audit_log(
                db,
                user_id=current_user.get("id") if isinstance(current_user, dict) else None,
                action="migration_audit_import_error",
                entity_type="migration_audit_batch",
                entity_id=None,
                details={"file": file.filename, "errors": errors},
            )
        raise
    except Exception as e:
        errors.append(str(e))
        db.rollback()
        with db.begin():
            write_audit_log(
                db,
                user_id=current_user.get("id") if isinstance(current_user, dict) else None,
                action="migration_audit_import_error",
                entity_type="migration_audit_batch",
                entity_id=None,
                details={"file": file.filename, "errors": errors},
            )
        raise HTTPException(500, f"Import failed: {str(e)}")
    finally:
        try:
            import os
            os.unlink(tmp_path)
        except Exception:
            pass

    return {"success": True, "inserted": inserted, "skipped": skipped, "errors": errors}


# ---------------------------------------------------------------------------
# Z-Side Customer Structure Import
# ---------------------------------------------------------------------------
_PP_RE      = re.compile(r"^PP\s*:\s*(\d{3,4})\s*:\s*(\d{6,8})", re.IGNORECASE)
_PP_RE_NC   = re.compile(r"^PP(\d{4})\s*:\s*(\d{6,8})", re.IGNORECASE)


def _clean_pp_number(raw: str):
    """Return (clean_pp, rack_code, rack_unit) or (None, None, None)."""
    s = (raw or "").strip()
    if not s:
        return None, None, None
    ru_m = re.search(r"[/\s]+(?:RU|HU)\s*(\d+)\s*$", s, re.IGNORECASE)
    rack_unit = int(ru_m.group(1)) if ru_m else None
    if ru_m:
        s = s[:ru_m.start()].strip()
    if re.match(r"^P:", s) and not re.match(r"^PP:", s, re.IGNORECASE):
        s = "P" + s
    m = _PP_RE.match(s)
    if m:
        return f"PP:{m.group(1).zfill(4)}:{m.group(2).strip()}", m.group(1).zfill(4), rack_unit
    m2 = _PP_RE_NC.match(s)
    if m2:
        return f"PP:{m2.group(1).zfill(4)}:{m2.group(2).strip()}", m2.group(1).zfill(4), rack_unit
    return None, None, rack_unit


def _parse_system_name(system_name: str) -> dict:
    """Extract room, cage, mode from system_name."""
    result = {"room": None, "cage": None, "mode": None, "room_display": None}
    if not system_name:
        return result
    parts = [p.strip() for p in str(system_name).split(":") if p.strip()]
    flat = [p.split("-")[-1].strip() if "-" in p else p for p in parts]

    room = cage = mode = None
    room_idx = None

    # Strategy 1: M<room> tokens
    for i, tok in enumerate(flat):
        if tok.startswith("M") and len(tok) > 1:
            cand = tok[1:]
            ce = re.match(r"^(\d+\.\d+)S(\d+)$", cand)
            if ce:
                room, cage, mode, room_idx = ce.group(1), f"S{int(ce.group(2))}", "S", i
                break
            if re.fullmatch(r"\d+[A-Z]\d+", cand) or re.fullmatch(r"\d+(?:\.\d+)?", cand):
                room, room_idx = cand, i
                break

    # Strategy 2: compact digit codes
    if room is None:
        for i, tok in enumerate(flat):
            m = re.fullmatch(r"(\d{2,4})S(\d{1,2})", tok)
            if m:
                code = m.group(1)
                if len(code) == 4:
                    major = int(code[0:2])
                    minor = int(code[2:4])
                elif len(code) == 3:
                    major = int(code[1])
                    minor = int(code[2])
                else:
                    major = int(code[0])
                    minor = int(code[1])
                room = f"{major}.{minor}" if minor > 0 else str(major)
                cage, mode, room_idx = f"S{int(m.group(2))}", "S", i
                break
            m2 = re.fullmatch(r"(\d{6})", tok)
            if m2:
                code = m2.group(1)
                alpha_m = re.fullmatch(r"(\d{2})([A-Z])(\d)(\d{2})", tok)
                if alpha_m:
                    room = re.sub(r"^0+", "", f"{int(alpha_m.group(1))}{alpha_m.group(2)}{int(alpha_m.group(3))}") or "0"
                    mode, room_idx = "OC", i
                    break
                x, yy = int(code[1:2]), int(code[2:4])
                if x > 0 and yy > 0:
                    room = f"{x}.{yy:02d}"
                elif yy > 0:
                    room = f"{yy // 10}.{yy % 10}" if yy >= 10 else str(yy)
                else:
                    room = code
                room_idx = i
                break

    if cage is None and room_idx is not None and room_idx + 1 < len(flat):
        nxt = flat[room_idx + 1]
        if re.fullmatch(r"OC", nxt, re.IGNORECASE):
            mode = "OC"
        elif re.fullmatch(r"S\d+", nxt, re.IGNORECASE):
            mode, cage = "S", "S" + str(int(re.sub(r"\D", "", nxt)))

    if room:
        result["room_display"] = f"M{room}" if re.fullmatch(r"\d+(?:\.\d+)?", room) else room
    result.update(room=room, cage=cage, mode=mode)
    return result


def _run_zside_import(db: Session) -> dict:
    """Core Z-side import logic. Returns stats dict."""
    from crud import generate_ports

    rows = db.execute(text("""
        SELECT id, system_name, customer_name, rack_code,
               z_pp_number, z_pp_raw, z_port_label, room
        FROM migration_audit_lines
        WHERE z_pp_number IS NOT NULL AND z_pp_number != ''
        ORDER BY id
    """)).mappings().all()

    pp_records: dict = {}
    audit_line_updates: list = []
    skipped_no_pp = 0
    skipped_no_system = 0
    warnings: list = []
    errors_list: list = []

    for r in rows:
        r = dict(r)
        raw_pp = (r["z_pp_number"] or "").strip()
        system_name = (r["system_name"] or "").strip()
        audit_id = r["id"]

        clean_pp, rack_code, ru_from_suffix = _clean_pp_number(raw_pp)
        if not clean_pp:
            warnings.append(f"Audit #{audit_id}: Cannot parse z_pp_number '{raw_pp}'")
            skipped_no_pp += 1
            continue

        if clean_pp != raw_pp:
            audit_line_updates.append((audit_id, clean_pp, ru_from_suffix))

        customer_name_full = system_name or (r["customer_name"] or "").strip()
        if not customer_name_full:
            warnings.append(f"Audit #{audit_id}: No customer name available")
            skipped_no_system += 1
            continue

        parsed = _parse_system_name(system_name)
        customer_room = parsed["room_display"] or parsed["room"]
        customer_cage = parsed["cage"]
        if not rack_code:
            rack_code = (r["rack_code"] or "").strip()

        if clean_pp not in pp_records:
            pp_records[clean_pp] = {
                "clean_pp": clean_pp, "rack_code": rack_code,
                "ru": ru_from_suffix, "customer_name": customer_name_full,
                "customer_room": customer_room, "customer_cage": customer_cage,
                "audit_ids": [], "port_labels_used": set(),
            }
        rec = pp_records[clean_pp]
        rec["audit_ids"].append(audit_id)
        if r["z_port_label"]:
            rec["port_labels_used"].add(r["z_port_label"])

    # Check existing PPs
    existing_pps: dict = {}
    for clean_pp in pp_records:
        pp_num_only = clean_pp.split(":")[-1] if ":" in clean_pp else clean_pp
        row = db.execute(text("""
            SELECT id FROM patchpanel_instances
            WHERE instance_id = :iid OR pp_number = :ppn OR pp_number = :iid
            LIMIT 1
        """), {"iid": clean_pp, "ppn": pp_num_only}).mappings().first()
        if row:
            existing_pps[clean_pp] = int(row["id"])

    stats = {
        "customers_created": 0, "customers_reused": 0,
        "locations_created": 0, "locations_reused": 0,
        "racks_created": 0, "racks_reused": 0,
        "pps_created": 0, "pps_existed": len(existing_pps),
        "audit_lines_updated": 0, "ports_marked": 0, "errors": 0,
    }

    customer_cache: dict = {}
    db.rollback()

    for clean_pp, rec in pp_records.items():
        if clean_pp in existing_pps:
            continue
        try:
            with db.begin():
                cust_name = rec["customer_name"]
                if cust_name in customer_cache:
                    customer_id = customer_cache[cust_name]
                    stats["customers_reused"] += 1
                else:
                    cust = db.execute(text(
                        "SELECT id FROM customers WHERE lower(name) = lower(:name) ORDER BY id LIMIT 1"
                    ), {"name": cust_name}).mappings().first()
                    if cust:
                        customer_id = int(cust["id"])
                        stats["customers_reused"] += 1
                    else:
                        cust = db.execute(text(
                            "INSERT INTO customers (name) VALUES (:name) RETURNING id"
                        ), {"name": cust_name}).mappings().first()
                        customer_id = int(cust["id"])
                        stats["customers_created"] += 1
                    customer_cache[cust_name] = customer_id

                c_room = rec["customer_room"] or "UNKNOWN"
                c_cage = rec["customer_cage"]
                cage_no = None
                if c_cage and c_cage.upper().startswith("S"):
                    try:
                        cage_no = str(int(c_cage[1:]))
                    except ValueError:
                        cage_no = c_cage[1:]

                loc = db.execute(text("""
                    SELECT id FROM customer_locations
                    WHERE customer_id = :cid AND room = :room
                      AND COALESCE(cage_no, '') = COALESCE(:cage_no, '')
                    ORDER BY id LIMIT 1
                """), {"cid": customer_id, "room": c_room, "cage_no": cage_no}).mappings().first()
                if loc:
                    location_id = int(loc["id"])
                    stats["locations_reused"] += 1
                else:
                    loc = db.execute(text("""
                        INSERT INTO customer_locations (customer_id, room, cage, room_code, cage_no)
                        VALUES (:cid, :room, :cage, :room_code, :cage_no) RETURNING id
                    """), {"cid": customer_id, "room": c_room, "cage": c_cage,
                           "room_code": c_room, "cage_no": cage_no}).mappings().first()
                    location_id = int(loc["id"])
                    stats["locations_created"] += 1

                rack_label = rec["rack_code"] or "0000"
                rack = db.execute(text("""
                    SELECT id FROM customer_racks
                    WHERE room = :room AND btrim(rack_label::text) = :rl
                    ORDER BY id LIMIT 1
                """), {"room": c_room, "rl": rack_label}).mappings().first()
                if not rack:
                    rack = db.execute(text("""
                        SELECT id FROM customer_racks
                        WHERE location_id = :lid AND rack_label = :rl
                        ORDER BY id LIMIT 1
                    """), {"lid": location_id, "rl": rack_label}).mappings().first()
                if rack:
                    rack_id = int(rack["id"])
                    stats["racks_reused"] += 1
                else:
                    rack = db.execute(text("""
                        INSERT INTO customer_racks (location_id, rack_label, room)
                        VALUES (:lid, :rl, :room) RETURNING id
                    """), {"lid": location_id, "rl": rack_label, "room": c_room}).mappings().first()
                    rack_id = int(rack["id"])
                    stats["racks_created"] += 1

                ru = rec["ru"] or 1
                pp_num_only = clean_pp.split(":")[-1] if ":" in clean_pp else clean_pp
                pp_row = db.execute(text("""
                    INSERT INTO patchpanel_instances (
                        instance_id, room, rack_unit, panel_type, total_ports,
                        customer_id, cage_no, rack_label, customer_rack_id,
                        pp_number, side
                    ) VALUES (
                        :instance_id, :room, :rack_unit, 'customer', 48,
                        :customer_id, :cage_no, :rack_label, :customer_rack_id,
                        :pp_number, 'Z'
                    ) RETURNING id
                """), {
                    "instance_id": clean_pp, "room": c_room, "rack_unit": ru,
                    "customer_id": customer_id, "cage_no": cage_no,
                    "rack_label": rack_label, "customer_rack_id": rack_id,
                    "pp_number": pp_num_only,
                }).mappings().first()
                pp_id = int(pp_row["id"])

                ports = generate_ports(48)
                db.execute(text("""
                    INSERT INTO patchpanel_ports
                        (patchpanel_id, row_number, row_letter, position, port_label, status)
                    VALUES
                        (:patchpanel_id, :row_number, :row_letter, :position, :port_label, :status)
                """), [{"patchpanel_id": pp_id, **p} for p in ports])

                stats["pps_created"] += 1
                existing_pps[clean_pp] = pp_id

        except Exception as e:
            stats["errors"] += 1
            errors_list.append(f"PP {clean_pp}: {e}")
            try:
                db.rollback()
            except Exception:
                pass

    # Update audit lines with cleaned PP numbers
    if audit_line_updates:
        batch_size = 50
        for i in range(0, len(audit_line_updates), batch_size):
            batch = audit_line_updates[i:i + batch_size]
            try:
                db.rollback()
                with db.begin():
                    for audit_id, clean_pp, _ in batch:
                        db.execute(text("""
                            UPDATE migration_audit_lines
                            SET z_pp_number = :pp WHERE id = :id AND z_pp_number != :pp
                        """), {"pp": clean_pp, "id": audit_id})
                        stats["audit_lines_updated"] += 1
            except Exception as e:
                stats["errors"] += 1
                errors_list.append(f"Audit update batch {i}: {e}")
                try:
                    db.rollback()
                except Exception:
                    pass

    # Mark occupied ports
    for clean_pp, rec in pp_records.items():
        pp_id = existing_pps.get(clean_pp)
        if not pp_id or not rec["port_labels_used"]:
            continue
        for port_label in rec["port_labels_used"]:
            try:
                db.rollback()
                with db.begin():
                    db.execute(text("""
                        UPDATE patchpanel_ports SET status = 'occupied'
                        WHERE patchpanel_id = :ppid AND port_label = :pl AND status != 'occupied'
                    """), {"ppid": pp_id, "pl": port_label})
                    stats["ports_marked"] += 1
            except Exception:
                pass

    stats["total_unique_pps"] = len(pp_records)
    stats["skipped_no_pp"] = skipped_no_pp
    stats["skipped_no_system"] = skipped_no_system
    stats["warnings"] = warnings[:50]
    stats["error_details"] = errors_list[:50]
    return stats


@router.post("/import-zside", dependencies=[Depends(require_permissions("upload:write"))])
def import_zside_structure(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Import Z-side customer hierarchy from migration_audit_lines into master data.

    Creates: Customer → Location → Rack → Patchpanel → Ports.
    Cleans PP numbers, marks occupied ports, updates audit lines.
    """
    try:
        stats = _run_zside_import(db)
        # Audit log
        try:
            db.rollback()
            with db.begin():
                write_audit_log(
                    db,
                    user_id=current_user.get("id") if isinstance(current_user, dict) else None,
                    action="zside_import",
                    entity_type="zside_structure",
                    entity_id=None,
                    details={k: v for k, v in stats.items() if k not in ("warnings", "error_details")},
                )
        except Exception:
            pass
        return {"success": True, **stats}
    except Exception as e:
        raise HTTPException(500, f"Z-Side import failed: {str(e)}")


@router.get("/zside-status")
def zside_status(db: Session = Depends(get_db)):
    """Return current Z-side import status (counts)."""
    r = db.execute(text("""
        SELECT
            (SELECT count(*) FROM customers) AS customers,
            (SELECT count(*) FROM customer_locations) AS locations,
            (SELECT count(*) FROM customer_racks) AS racks,
            (SELECT count(*) FROM patchpanel_instances WHERE side = 'Z') AS zside_pps,
            (SELECT count(*) FROM patchpanel_instances) AS total_pps,
            (SELECT count(DISTINCT z_pp_number)
             FROM migration_audit_lines
             WHERE z_pp_number IS NOT NULL AND z_pp_number != ''
               AND z_pp_number NOT IN (SELECT instance_id FROM patchpanel_instances)
            ) AS missing_zpp
    """)).mappings().first()
    return dict(r)


@router.patch("/{audit_id}")
def update_audit_line(
    audit_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    row = db.execute(
        text(
            """
            SELECT id, audit_status
            FROM public.migration_audit_lines
            WHERE id = :id
            """
        ),
        {"id": int(audit_id)},
    ).mappings().first()
    if not row:
        raise HTTPException(404, "Audit line not found")
    # allow editing imported AND audited lines
    if row["audit_status"] not in ("imported", "audited"):
        raise HTTPException(400, "Audit line locked")


    allowed = {
        # editable fields in audit modal
        "switch_name",
        "switch_port",
        "a_pp_number",
        "a_port_label",
        "z_pp_number",
        "z_port_label",
        "product_id",
        "serial_number",
        "backbone_in_instance_id",
        "backbone_in_port_label",
        "backbone_out_instance_id",
        "backbone_out_port_label",
        "tech_comment",
    }
    upd = {k: payload.get(k) for k in allowed if k in payload}
    if not upd:
        return {"success": True}

    sets = ", ".join([f"{k} = :{k}" for k in upd.keys()])
    upd["id"] = int(audit_id)

    try:
        db.rollback()
        with db.begin():
            db.execute(text(f"UPDATE public.migration_audit_lines SET {sets} WHERE id = :id"), upd)
            write_audit_log(
                db,
                user_id=current_user.get("id") if isinstance(current_user, dict) else None,
                action="migration_audit_update",
                entity_type="migration_audit_line",
                entity_id=audit_id,
                details={"fields": sorted([k for k in upd.keys() if k != "id"])},
            )
        return {"success": True}
    except Exception as e:
        raise HTTPException(500, f"Update failed: {str(e)}")


@router.post("/{audit_id}/audited")
def approve_audit_line(
    audit_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Approve a migration audit line.

    ✅ What this does (atomic):
    - mark migration_audit_lines as audited
    - ensure Customer + Location (Rack/Cage) exist
    - ensure Z-side patchpanel exists (RU optional)
    - create an ACTIVE cross_connect
    - write linked_cc_id back to the audit line
    """
    # Always start from a clean transaction (prevents "InFailedSqlTransaction")
    db.rollback()

    current_user_name = (
        current_user.get("username") if isinstance(current_user, dict) else "migration-audit"
    )
    current_user_id = current_user.get("id") if isinstance(current_user, dict) else None

    try:
        with db.begin():
            # 1) Lock audit line
            r = db.execute(
                text(
                    """
                    SELECT *
                    FROM public.migration_audit_lines
                    WHERE id = :id
                    FOR UPDATE
                    """
                ),
                {"id": int(audit_id)},
            ).mappings().first()
            if not r:
                raise HTTPException(404, "Audit line not found")

            status_now = (r.get("audit_status") or "").strip().lower()
            if status_now not in {"imported", "audited"}:
                raise HTTPException(400, "Audit line already processed")

            # If the line was audited before, we will *sync* the already-created cross_connect
            # using the current values from migration_audit_lines.
            linked_cc_id = r.get("linked_cc_id")
            try:
                linked_cc_id = int(linked_cc_id) if linked_cc_id not in (None, "", "null") else None
            except Exception:
                linked_cc_id = None

            # 2) Build customer_name (prefer system_name suffix)
            system_name = (r.get("system_name") or "").strip()
            customer_name = (r.get("customer_name") or "").strip()
            if system_name and ":" in system_name:
                cand = system_name.split(":")[-1].strip()
                if cand:
                    customer_name = cand
            customer_name = customer_name or "UNKNOWN"

            # 3) Ensure customer exists
            cust = db.execute(
                text(
                    """
                    SELECT id
                    FROM public.customers
                    WHERE lower(name) = lower(:name)
                    ORDER BY id
                    LIMIT 1
                    """
                ),
                {"name": customer_name},
            ).mappings().first()

            if cust:
                customer_id = int(cust["id"])
            else:
                cust_ins = db.execute(
                    text(
                        """
                        INSERT INTO public.customers (name)
                        VALUES (:name)
                        RETURNING id
                        """
                    ),
                    {"name": customer_name},
                ).mappings().first()
                customer_id = int(cust_ins["id"])

            # 4) Resolve A-side room (RFRA / backbone side) + Customer location (from system_name)
            # A-side room is what the audit UI shows in the "A ROOM" column (e.g. M5.04 S6 / M5.13 S1).
            a_room = ((payload.get("room") or payload.get("a_room") or payload.get("audit_room") or "")).strip()
            if not a_room:
                a_room = ((r.get("room") or "")).strip()
            if not a_room:
                # last resort: try regex extraction from system_name
                a_room = (parse_room_from_system_name(system_name) or "").strip()

            if not a_room:
                raise HTTPException(400, "A-side room missing (room column in Excel)")

            # Customer location must NOT be derived from A-side room.
            # It is derived from system_name (Z-side customer identifier).
            cust_room_raw, cust_cage_label, cust_mode = parse_customer_room_and_cage(system_name)
            customer_room = normalize_customer_room_display(cust_room_raw) or None

            # If customer is OpenColo (OC) then cage is None.
            # If customer has a cage (S1 / S05) then store as "S<n>".
            customer_cage = cust_cage_label  # e.g. "S1" or "S5" or None

            # Safety fallback (do not block): if we cannot parse customer room, use A-side room.
            if not customer_room:
                customer_room = a_room

            # Determine customer_location_id (create if missing)
            loc_row = db.execute(
                text(
                    """
                    SELECT id
                    FROM public.customer_locations
                    WHERE customer_id = :cid
                      AND room = :room
                      AND COALESCE(cage,'') = COALESCE(:cage,'')
                    ORDER BY id
                    LIMIT 1
                    """
                ),
                {"cid": int(customer_id), "room": customer_room, "cage": customer_cage},
            ).mappings().first()

            if not loc_row:
                loc_row = db.execute(
                    text(
                        """
                        INSERT INTO public.customer_locations (customer_id, room, cage, room_code, cage_no)
                        VALUES (:cid, :room, :cage, :room_code, :cage_no)
                        RETURNING id
                        """
                    ),
                    {
                        "cid": int(customer_id),
                        "room": customer_room,
                        "cage": customer_cage,
                        "room_code": customer_room,
                        "cage_no": (str(int(customer_cage[1:])) if customer_cage and customer_cage.upper().startswith("S") else None),
                    },
                ).mappings().first()

            customer_location_id = int(loc_row["id"])

            # Z-side PP input
            z_pp_raw = (payload.get("z_pp_number") or payload.get("z_pp_number_raw") or r.get("z_pp_number") or r.get("z_pp_raw") or "").strip()
            if not z_pp_raw:
                raise HTTPException(400, "Z-side patchpanel missing (z_pp_number)")

            rack_code, z_pp_number_only = parse_pp(z_pp_raw)
            rack_label = (payload.get("rack_label") or payload.get("rackLabel") or rack_code or r.get("rack_code") or "").strip()
            if not rack_label:
                raise HTTPException(400, "Rack label/code missing (cannot determine customer rack)")

            # RU optional
            ru_val = payload.get("rack_unit") or payload.get("rackUnit") or payload.get("ru") or payload.get("RU")
            try:
                rack_unit = int(ru_val) if ru_val not in (None, "", "null") else 1
            except Exception:
                rack_unit = 1
            if rack_unit < 1:
                rack_unit = 1

            # 5) Ensure Z-side patchpanel exists
            # Our DB may store pp_number as digits-only => try both
            z_pp_id = _get_pp_id_by_pp_number(db, z_pp_raw) or (_get_pp_id_by_pp_number(db, z_pp_number_only or "") if z_pp_number_only else None)

            if not z_pp_id:
                # Create customer rack/location + patchpanel (ports included)
                pp_full = normalize_pp_full(z_pp_raw, rack_code=rack_label, pp_number=z_pp_number_only) or z_pp_raw
                created = crud.create_zside_patchpanel(
                    db,
                    instance_id=pp_full,
                    room=customer_room,
                    rack_unit=rack_unit,
                    rack_label=rack_label,
                    customer_id=int(customer_id),
                    cage_no=(str(int(customer_cage[1:])) if customer_cage else None),
                    panel_type="customer",
                    port_layout=96,
                    enabled_cassettes=None,
                    pp_number=z_pp_number_only,
                )
                z_pp_id = int(created["patchpanel_id"])

            # 6) Resolve A-side patchpanel
            # IMPORTANT: A-side in migration audit is the RFRA / pre-cabled (backbone) side.
            # It may not exist in patchpanel_instances at all, so we must *not* validate it against
            # patchpanel_instances. We store the provided label (e.g. "PP:0102:1071239") as-is.
            a_pp_raw = (payload.get("a_pp_number") or r.get("a_pp_number") or r.get("a_pp_raw") or "").strip()
            a_port_label = (payload.get("a_port_label") or r.get("a_port_label") or "").strip()

            if not a_pp_raw:
                raise HTTPException(400, "A-side patchpanel label missing (a_pp_number)")
            if not a_port_label:
                raise HTTPException(400, "A-side port label missing (a_port_label)")

            # Keep A-side as text label for cross_connects.a_patchpanel_id (text NOT NULL)
            a_pp_id = a_pp_raw

            # 7) BB selection must exist (already selected in UI)
            bb_in_i = (r.get("backbone_in_instance_id") or "").strip()
            bb_in_p = (r.get("backbone_in_port_label") or "").strip()
            bb_out_i = (r.get("backbone_out_instance_id") or "").strip()
            bb_out_p = (r.get("backbone_out_port_label") or "").strip()
            if not (bb_in_i and bb_in_p and bb_out_i and bb_out_p):
                raise HTTPException(400, "BB IN/OUT must be selected before auditing")

            # 8) Conflicts: reserved ports
            # When syncing an existing CC (re-audit), ignore its own ports in conflict checks.
            reserved = _list_reserved_ports_for_jobwide(db, exclude_cc_id=linked_cc_id)
            if bb_in_p in reserved.get(bb_in_i, set()):
                raise HTTPException(409, "BB IN port already used")
            if bb_out_p in reserved.get(bb_out_i, set()):
                raise HTTPException(409, "BB OUT port already used")

            # 9) Insert cross_connect (keep legacy compatibility)
            has_pid = has_column(db, "cross_connects", "product_id")
            has_sn = has_column(db, "cross_connects", "serial_number")

            db_bo_i, db_bo_p, db_bi_i, db_bi_p = _swap_backbone_for_db(bb_in_i, bb_in_p, bb_out_i, bb_out_p)

            # Common values used for INSERT or UPDATE
            common_params = {
                "product_id": r.get("product_id"),
                "serial_number": r.get("serial_number"),
                "serial": r.get("serial") or r.get("serial_number") or r.get("product_id"),
                "switch_name": r.get("switch_name"),
                "switch_port": r.get("switch_port"),
                "a_pp_id": str(a_pp_id),
                "a_port": a_port_label,
                "bo_i": db_bo_i,
                "bo_p": db_bo_p,
                "bi_i": db_bi_i,
                "bi_p": db_bi_p,
                "z_pp_id": int(z_pp_id),
                "z_port": r.get("z_port_label"),
                "customer_id": int(customer_id),
                "customer_location_id": int(customer_location_id),
                "rack_code": rack_label,
                "z_pp_number": z_pp_raw,
                "system_name": system_name,
                "source_audit_line_id": int(audit_id),
            }

            if linked_cc_id:
                # Re-audit: sync existing cross_connect with the latest values from the audit line.
                if has_pid and has_sn:
                    q = text(
                        """
                        UPDATE public.cross_connects
                        SET
                          product_id = :product_id,
                          serial_number = :serial_number,
                          serial = :serial,
                          switch_name = :switch_name,
                          switch_port = :switch_port,
                          a_patchpanel_id = :a_pp_id,
                          a_port_label = :a_port,
                          backbone_out_instance_id = :bo_i,
                          backbone_out_port_label = :bo_p,
                          backbone_in_instance_id = :bi_i,
                          backbone_in_port_label = :bi_p,
                          customer_patchpanel_id = :z_pp_id,
                          customer_port_label = :z_port,
                          customer_id = :customer_id,
                          customer_location_id = :customer_location_id,
                          rack_code = :rack_code,
                          z_pp_number = :z_pp_number,
                          system_name = :system_name,
                          source_audit_line_id = :source_audit_line_id,
                          status = 'active',
                          updated_at = NOW()
                        WHERE id = :cc_id
                        RETURNING id
                        """
                    )
                    new_id = db.execute(q, {**common_params, "cc_id": int(linked_cc_id)}).fetchone()[0]
                else:
                    q = text(
                        """
                        UPDATE public.cross_connects
                        SET
                          serial = :serial,
                          switch_name = :switch_name,
                          switch_port = :switch_port,
                          a_patchpanel_id = :a_pp_id,
                          a_port_label = :a_port,
                          backbone_out_instance_id = :bo_i,
                          backbone_out_port_label = :bo_p,
                          backbone_in_instance_id = :bi_i,
                          backbone_in_port_label = :bi_p,
                          customer_patchpanel_id = :z_pp_id,
                          customer_port_label = :z_port,
                          customer_id = :customer_id,
                          customer_location_id = :customer_location_id,
                          rack_code = :rack_code,
                          z_pp_number = :z_pp_number,
                          system_name = :system_name,
                          source_audit_line_id = :source_audit_line_id,
                          status = 'active',
                          updated_at = NOW()
                        WHERE id = :cc_id
                        RETURNING id
                        """
                    )
                    new_id = db.execute(q, {**common_params, "cc_id": int(linked_cc_id)}).fetchone()[0]
            else:
                # First audit: create a new cross_connect
                if has_pid and has_sn:
                    q = text(
                        """
                        INSERT INTO public.cross_connects (
                          product_id,
                          serial_number,
                          serial,
                          switch_name, switch_port,
                          a_patchpanel_id, a_port_label,
                          backbone_out_instance_id, backbone_out_port_label,
                          backbone_in_instance_id, backbone_in_port_label,
                          customer_patchpanel_id, customer_port_label,
                          customer_id,
                          customer_location_id,
                          rack_code,
                          z_pp_number,
                          system_name,
                          source_audit_line_id,
                          status
                        ) VALUES (
                          :product_id,
                          :serial_number,
                          :serial,
                          :switch_name, :switch_port,
                          :a_pp_id, :a_port,
                          :bo_i, :bo_p,
                          :bi_i, :bi_p,
                          :z_pp_id, :z_port,
                          :customer_id,
                          :customer_location_id,
                          :rack_code,
                          :z_pp_number,
                          :system_name,
                          :source_audit_line_id,
                          'active'
                        )
                        RETURNING id
                        """
                    )
                    new_id = db.execute(q, common_params).fetchone()[0]
                else:
                    q = text(
                        """
                        INSERT INTO public.cross_connects (
                          serial,
                          switch_name, switch_port,
                          a_patchpanel_id, a_port_label,
                          backbone_out_instance_id, backbone_out_port_label,
                          backbone_in_instance_id, backbone_in_port_label,
                          customer_patchpanel_id, customer_port_label,
                          customer_id,
                          customer_location_id,
                          rack_code,
                          z_pp_number,
                          system_name,
                          source_audit_line_id,
                          status
                        ) VALUES (
                          :serial,
                          :switch_name, :switch_port,
                          :a_pp_id, :a_port,
                          :bo_i, :bo_p,
                          :bi_i, :bi_p,
                          :z_pp_id, :z_port,
                          :customer_id,
                          :customer_location_id,
                          :rack_code,
                          :z_pp_number,
                          :system_name,
                          :source_audit_line_id,
                          'active'
                        )
                        RETURNING id
                        """
                    )
                    new_id = db.execute(q, common_params).fetchone()[0]

            # 10) Update audit line (audited + link CC)
            db.execute(
                text(
                    """
                    UPDATE public.migration_audit_lines
                    SET audit_status = 'audited',
                        audited_by = :by,
                        audited_at = NOW(),
                        linked_cc_id = :cc
                    WHERE id = :id
                    """
                ),
                {"by": current_user_name, "cc": int(new_id), "id": int(audit_id)},
            )

            write_audit_log(
                db,
                user_id=current_user_id,
                action="migration_audit_status_change",
                entity_type="migration_audit_line",
                entity_id=audit_id,
                details={"from": status_now, "to": "audited", "linked_cc_id": int(new_id)},
            )

            return {"success": True, "cross_connect_id": int(new_id), "audit_id": int(audit_id)}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print("🔥 approve_audit_line failed:", repr(e))
        traceback.print_exc()
        raise HTTPException(500, f"Approve failed: {str(e)}")


@router.get("/{audit_id}/bbin-pps")
def bbin_patchpanels_for_audit(audit_id: int, db: Session = Depends(get_db)):
    """Return backbone patchpanels that go to the *customer (Z-side) room*.

    Project rule:
    - migration_audit_lines.room is the A-side room (source) and must not be
      used for BB-IN filtering.
    - For the BB-IN picker we must filter by the customer room (Z-side), which
      we derive from the customer patchpanel instance referenced by
      migration_audit_lines.z_pp_number.

    Fallback:
    - If the customer PP instance does not exist yet, we fall back to the
      audit line's room.
    """
    r = db.execute(
        text(
            """
            SELECT id,
                   room,
                   z_pp_number,
                   backbone_in_instance_id,
                   backbone_out_instance_id
            FROM public.migration_audit_lines
            WHERE id = :id
            """
        ),
        {"id": int(audit_id)},
    ).mappings().first()
    if not r:
        raise HTTPException(404, "Audit line not found")

    # A-side room comes from the audit line (Excel). We use it ONLY to restrict
    # which *source* patchpanels are shown (so we don't show panels from other
    # rooms like 5.13 when the switch / A-side is in 5.04).
    a_room = " ".join(((r.get("room") or "").strip()).split())
    # Determine the *target* customer room for BB-IN filtering.
    # Priority:
    # 1) If Excel provided "BB IN PP" like "M5.04S6/1 -> M4.5" use the right side ("M4.5").
    # 2) Else if Excel provided "BB OUT PP" like "M4.5/7" use the part before "/" ("M4.5").
    # 3) Else try to resolve the room from the customer (Z-side) patchpanel instance.
    # 4) If everything fails, we return an empty list (better than showing all panels).
    room_raw = ""
    bb_in_raw = (r.get("backbone_in_instance_id") or "").strip()
    bb_out_raw = (r.get("backbone_out_instance_id") or "").strip()

    # Excel format example: "M5.04S6/1 -> M4.5"
    if "->" in bb_in_raw:
        right = bb_in_raw.split("->", 1)[1].strip()
        if right:
            room_raw = right

    # Excel format example: "M4.5/7"
    if not room_raw and bb_out_raw:
        left = bb_out_raw.split("/", 1)[0].strip()
        if left:
            room_raw = left
    z_pp_number = (r.get("z_pp_number") or "").strip()
    if z_pp_number:
        zrow = db.execute(
            text(
                """
                SELECT room
                FROM public.patchpanel_instances
                WHERE regexp_replace(upper(pp_number), '[^A-Z0-9]', '', 'g')
                    = regexp_replace(upper(:pp),       '[^A-Z0-9]', '', 'g')
                LIMIT 1
                """
            ),
            {"pp": z_pp_number},
        ).mappings().first()
        if zrow and (zrow.get("room") or "").strip():
            room_raw = (zrow.get("room") or "").strip()

    # IMPORTANT: migration_audit_lines.room is the A-side room.
    # If we cannot resolve the *target* customer room, we MUST NOT show "all" backbone panels.
    if not room_raw:
        # No resolvable customer target room -> show nothing (never "all panels").
        return {"context": {"room": None, "a_room": a_room}, "patchpanels": []}

    # If Excel already provides the BB-IN patchpanel (common case), always include it.
    # BUT we also want to show other possible BB-IN panels to the same target room,
    # so technicians can correct wrong patching by selecting a different panel.
    bb_in_inst = bb_in_raw.split("->", 1)[0].strip() if bb_in_raw else ""
    primary_pp = None
    if bb_in_inst:
        primary_pp = db.execute(
            text(
                """
                SELECT id, instance_id, room, rack_label, rack_unit, total_ports
                FROM public.patchpanel_instances
                WHERE regexp_replace(upper(instance_id), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(:iid), '[^A-Z0-9]', '', 'g')
                LIMIT 1
                """
            ),
            {"iid": bb_in_inst},
        ).mappings().first()

    # The audit table may contain room strings like "M5.04 S6".
    # In DB, patchpanel_ports.peer_instance_id often looks like: "5.4S6/RU2".
    # So we generate multiple prefixes to match both styles:
    # - keep leading zeros:   5.04
    # - strip leading zeros:  5.4
    # - with cage:            5.4S6
    # - with cage + slash:    5.4S6/
    def _room_prefix_candidates(raw: str) -> tuple[list[str], str, str]:
        """
        Build candidate prefixes for patchpanel_ports.peer_instance_id.

        Handles:
        - dotted rooms:   M4.5, 4.05, 5.04 S6, etc.
        - alpha rooms:    M1A2, 1A2
        - optional cage:  S6 / S06 (accept both, and with/without slash)
        - optional leading 'M' prefix is legacy and must be ignored / mirrored.
        """
        raw = (raw or "").strip()
        raw = " ".join(raw.split())

        # Extract cage token like S6, S06
        cage_m = re.search(r"\bS0*(\d+)\b", raw, flags=re.IGNORECASE)
        cage_num = cage_m.group(1) if cage_m else ""
        cage = ("S" + str(int(cage_num))) if cage_num else ""

        # Remove cage tokens for base parsing
        raw_wo_cage = re.sub(r"\bS0*\d+\b", "", raw, flags=re.IGNORECASE).strip()

        def base_variants(s: str) -> list[str]:
            s = (s or "").strip()
            if not s:
                return []
            core = s[1:] if s.upper().startswith("M") and len(s) > 1 else s
            out = [core, "M" + core]
            seen=set(); res=[]
            for x in out:
                if x and x not in seen:
                    seen.add(x); res.append(x)
            return res

        # Dotted numeric base?
        m = re.search(r"(\d+)\.(\d+)", raw_wo_cage)
        bases: list[str] = []
        if m:
            major = m.group(1)
            minor = m.group(2)
            base_keep = f"{major}.{minor}"
            base_strip = f"{major}.{int(minor)}"
            bases = [base_keep]
            if base_strip != base_keep:
                bases.append(base_strip)
        else:
            cleaned = re.sub(r"[^A-Za-z0-9\.]", "", raw_wo_cage)
            bases = [cleaned] if cleaned else []

        prefs: list[str] = []
        for b in bases:
            for v in base_variants(b):
                prefs.append(v)
                if cage:
                    prefs.append(f"{v}{cage}")
                    prefs.append(f"{v}{cage}/")

        seen = set()
        out: list[str] = []
        for p in prefs:
            if p and p not in seen:
                seen.add(p)
                out.append(p)

        room_norm = bases[0] if bases else ""
        return out, room_norm, cage

    prefixes, room_norm, cage = _room_prefix_candidates(room_raw)
    if not prefixes:
        return {"context": {"room": room_raw, "a_room": a_room, "room_norm": None, "cage": None}, "patchpanels": []}

    # Build OR ... LIKE ... clause from all candidates.
    like_parts = []
    params = {}
    for i, pref in enumerate(prefixes):
        k = f"pref{i}"
        params[k] = f"{pref}%"
        like_parts.append(f"p.peer_instance_id LIKE :{k}")
    like_sql = " OR ".join(like_parts)

    # NOTE:
    # patchpanel_instances.room is NOT the same as migration_audit_lines.room.
    # In DB, patchpanel_instances.room is often something like "1A2" or "4.5",
    # while the audit line room is like "M5.04 S6".
    # Therefore we MUST NOT filter by a_room here, otherwise we hide valid panels.
    extra_room_sql = ""

    # If Excel provided a BB-IN instance, we restrict the candidate list to the
    # same BB-IN *group* (same prefix without RUxx), but still allow picking a
    # different panel (RU) that goes to the same target room.
    group_sql = ""
    if bb_in_inst:
        # Example bb_in_inst: "M5.04S6/36" or "5.13S1/RU24"
        raw_no_ru = re.sub(r"/(RU\d+|\d+)$", "", bb_in_inst, flags=re.IGNORECASE).strip()

        def _group_variants(s: str) -> list[str]:
            s = (s or "").strip()
            if not s:
                return []
            # Strip leading M for parsing, but we'll add both back later
            core0 = s[1:] if s.upper().startswith("M") and len(s) > 1 else s

            # Parse dotted base with optional cage like 5.04S6
            mm = re.match(r"^(\d+)\.(\d+)(S\d+)?$", core0, flags=re.IGNORECASE)
            cores = []
            if mm:
                major = mm.group(1)
                minor = mm.group(2)
                cage_part = mm.group(3) or ""
                keep = f"{major}.{minor}{cage_part}"
                strip = f"{major}.{int(minor)}{cage_part}"
                cores = [keep]
                if strip != keep:
                    cores.append(strip)
            else:
                cores = [core0]

            out = []
            for c in cores:
                out.append(c)
                out.append("M" + c)
            # unique
            seen=set(); res=[]
            for x in out:
                if x and x not in seen:
                    seen.add(x); res.append(x)
            return res

        variants = _group_variants(raw_no_ru)
        norms = [re.sub(r"[^A-Z0-9]", "", v.upper()) for v in variants]
        norms = [n for n in norms if n]

        if norms:
            parts = []
            for i, n in enumerate(norms):
                params[f"grp{i}"] = n
                parts.append(f"regexp_replace(upper(pi.instance_id), '[^A-Z0-9]', '', 'g') LIKE :grp{i} || '%'")
            group_sql = "AND (" + " OR ".join(parts) + ")"


    rows = db.execute(
        text(
            f"""
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
              AND ({like_sql})
              {extra_room_sql}
              {group_sql}
              AND pi.customer_id IS NULL
            GROUP BY pi.id, pi.instance_id, pi.rack_label, pi.rack_unit, pi.total_ports
            ORDER BY pi.instance_id
            """
        ),
        params,
    ).mappings().all()

    patchpanels = [
        {
            "id": int(x["id"]),
            "instance_id": x.get("instance_id"),
            "rack_label": x.get("rack_label"),
            "rack_unit": x.get("rack_unit"),
            "total_ports": x.get("total_ports"),
            "matching_ports": int(x.get("matching_ports") or 0),
        }
        for x in rows
    ]

    # Ensure the Excel-provided BB-IN panel is always visible and first.
    if primary_pp:
        pid = int(primary_pp["id"])
        # remove if already present
        patchpanels = [pp for pp in patchpanels if int(pp.get("id") or 0) != pid]
        patchpanels.insert(
            0,
            {
                "id": pid,
                "instance_id": primary_pp.get("instance_id"),
                "rack_label": primary_pp.get("rack_label"),
                "rack_unit": primary_pp.get("rack_unit"),
                "total_ports": primary_pp.get("total_ports"),
                "matching_ports": int(primary_pp.get("matching_ports") or 0),
            },
        )

    return {
        "context": {"room": room_raw, "a_room": a_room, "room_norm": room_norm or None, "cage": cage or None, "prefixes": prefixes},
        "patchpanels": patchpanels,
    }
