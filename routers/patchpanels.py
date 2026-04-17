from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from security import get_current_user


router = APIRouter(prefix=settings.api_prefix, tags=["patchpanels"])

# Rooms that are A-Seite (pattern: digit.digitS-digit, e.g. 5.13S1, 5.4S6)
_A_SIDE_RE = re.compile(r"^\d+\.\d+S\d+$", re.IGNORECASE)


def _classify_pp(room: str, customer_id) -> str:
    """Return 'Z', 'A', or 'BB'."""
    if customer_id is not None:
        return "Z"
    if _A_SIDE_RE.match(room):
        return "A"
    return "BB"


def _derive_room(row: dict[str, Any]) -> str:
    room = str(row.get("room") or row.get("room_code") or "").strip()
    if room:
        return room

    instance_id = str(row.get("instance_id") or "").strip()
    if "/" in instance_id:
        left = instance_id.split("/", 1)[0].strip()
        if left:
            return left
    return instance_id


def _parse_port_int(value: Any) -> int | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    match = re.search(r"\d+", raw)
    if not match:
        return None
    try:
        return int(match.group(0))
    except Exception:
        return None


def _normalize_ports_total(raw_total: Any, known_port_count: int, occupied_labels: list[str]) -> int:
    if raw_total is not None:
        try:
            total = int(raw_total)
            if total <= 0:
                raise ValueError
            if total <= 48:
                return 48
            if total <= 96:
                return 96
            return total
        except Exception:
            pass

    if known_port_count > 0:
        return 48 if known_port_count <= 48 else 96

    parsed = [_parse_port_int(label) for label in occupied_labels]
    parsed = [x for x in parsed if x is not None]
    max_seen = max(parsed) if parsed else 0
    if max_seen <= 48:
        return 48
    return 96


_PP_SCHEMA_ENSURED = False


def _ensure_pp_schema(db: Session) -> None:
    """Add missing columns to patchpanel_instances and ensure related tables exist."""
    global _PP_SCHEMA_ENSURED
    if _PP_SCHEMA_ENSURED:
        return
    db.execute(text("""
        ALTER TABLE public.patchpanel_instances
          ADD COLUMN IF NOT EXISTS rack_label   TEXT,
          ADD COLUMN IF NOT EXISTS cage_no      TEXT,
          ADD COLUMN IF NOT EXISTS room_code    TEXT,
          ADD COLUMN IF NOT EXISTS customer_id  BIGINT,
          ADD COLUMN IF NOT EXISTS side         TEXT;
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS public.customers (
            id   BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        );
    """))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS public.customer_locations (
            id          BIGSERIAL PRIMARY KEY,
            customer_id BIGINT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
            room        TEXT,
            cage_no     TEXT
        );
    """))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_cl_customer ON public.customer_locations(customer_id)"))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS public.customer_racks (
            id          BIGSERIAL PRIMARY KEY,
            location_id BIGINT NOT NULL REFERENCES public.customer_locations(id) ON DELETE CASCADE,
            rack_label  TEXT
        );
    """))
    db.execute(text("CREATE INDEX IF NOT EXISTS ix_cr_location ON public.customer_racks(location_id)"))
    db.commit()
    _PP_SCHEMA_ENSURED = True


@router.get("/patchpanels")
def list_patchpanels(
    room: str | None = Query(default=None),
    q: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_pp_schema(db)
    rows = db.execute(
        text(
            """
            SELECT
                pi.id,
                pi.instance_id,
                pi.room,
                pi.room_code,
                pi.rack_label,
                pi.cage_no,
                pi.total_ports,
                pi.customer_id,
                pi.pp_number,
                pi.rack_unit,
                pi.side,
                c.name AS customer_name
            FROM public.patchpanel_instances pi
            LEFT JOIN public.customers c ON c.id = pi.customer_id
            ORDER BY COALESCE(pi.room, pi.room_code, ''),
                     COALESCE(pi.rack_label, ''),
                     COALESCE(pi.instance_id, ''),
                     pi.id
            """
        )
    ).mappings().all()

    # ── Bulk occupancy counts (all sides) ────────────────────────
    occ_rows = db.execute(
        text(
            """
            WITH all_occ AS (
                SELECT customer_patchpanel_id AS pp_id,
                       customer_port_label     AS port_label
                FROM   cross_connects
                WHERE  COALESCE(status, '') <> 'deinstalled'
                  AND  customer_patchpanel_id IS NOT NULL
                  AND  customer_port_label IS NOT NULL
                  AND  TRIM(customer_port_label) <> ''

                UNION

                SELECT pi.id                   AS pp_id,
                       cc.a_port_label          AS port_label
                FROM   cross_connects cc
                JOIN   patchpanel_instances pi
                       ON (cc.a_patchpanel_id = pi.id::text
                           OR cc.a_patchpanel_id = pi.instance_id)
                WHERE  COALESCE(cc.status, '') <> 'deinstalled'
                  AND  cc.a_patchpanel_id IS NOT NULL
                  AND  cc.a_port_label IS NOT NULL
                  AND  TRIM(cc.a_port_label) <> ''

                UNION

                SELECT pi.id                         AS pp_id,
                       cc.backbone_in_port_label      AS port_label
                FROM   cross_connects cc
                JOIN   patchpanel_instances pi
                       ON cc.backbone_in_instance_id = pi.instance_id
                WHERE  COALESCE(cc.status, '') <> 'deinstalled'
                  AND  cc.backbone_in_instance_id IS NOT NULL
                  AND  cc.backbone_in_port_label IS NOT NULL
                  AND  TRIM(cc.backbone_in_port_label) <> ''

                UNION

                SELECT pi.id                          AS pp_id,
                       cc.backbone_out_port_label      AS port_label
                FROM   cross_connects cc
                JOIN   patchpanel_instances pi
                       ON cc.backbone_out_instance_id = pi.instance_id
                WHERE  COALESCE(cc.status, '') <> 'deinstalled'
                  AND  cc.backbone_out_instance_id IS NOT NULL
                  AND  cc.backbone_out_port_label IS NOT NULL
                  AND  TRIM(cc.backbone_out_port_label) <> ''
            )
            SELECT pp_id, COUNT(DISTINCT port_label) AS occupied_count
            FROM   all_occ
            GROUP  BY pp_id
            """
        )
    ).mappings().all()

    occ_map: dict[int, int] = {}
    for r in occ_rows:
        try:
            occ_map[int(r["pp_id"])] = int(r["occupied_count"])
        except Exception:
            pass

    # ── Build items ──────────────────────────────────────────────
    selected_room = str(room or "").strip().lower()
    search_q = str(q or "").strip().lower()

    items = []
    for row in rows:
        room_name = _derive_room(dict(row))
        if selected_room and room_name.lower() != selected_room:
            continue

        rack = (row.get("rack_label") or "").strip()
        cage = (row.get("cage_no") or "").strip()
        parts = [x for x in [room_name, rack, cage] if x]
        location = " / ".join(parts) if parts else None
        name = row.get("instance_id") or f"Patchpanel {row['id']}"

        if search_q:
            hay = f"{name} {room_name} {rack} {cage} {location or ''} {row.get('customer_name') or ''}".lower()
            if search_q not in hay:
                continue

        pp_id = int(row["id"])
        ports_total = _normalize_ports_total(row.get("total_ports"), 0, [])
        occupied = min(occ_map.get(pp_id, 0), ports_total)
        customer_id = row.get("customer_id")
        category = _classify_pp(room_name, customer_id)

        items.append(
            {
                "id": pp_id,
                "name": name,
                "room": room_name or None,
                "rack": rack or None,
                "cage": cage or None,
                "location": location,
                "ports_total": ports_total,
                "ports_occupied": occupied,
                "ports_free": ports_total - occupied,
                "category": category,
                "customer_id": int(customer_id) if customer_id else None,
                "customer_name": row.get("customer_name") or None,
                "pp_number": row.get("pp_number") or None,
                "rack_unit": row.get("rack_unit") or None,
            }
        )

    return {"success": True, "items": items}


@router.post("/patchpanels")
def create_patchpanel(
    body: dict,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Create a new Z-side (customer) patchpanel with full workflow."""
    _ensure_pp_schema(db)
    customer_id = body.get("customer_id")
    customer_name = str(body.get("customer_name") or "").strip()
    room_val = str(body.get("room") or "").strip()
    rack_label = str(body.get("rack_label") or "").strip() or None
    cage_no = str(body.get("cage_no") or "").strip() or None
    pp_number = str(body.get("pp_number") or "").strip() or None
    rack_unit = int(body.get("rack_unit", 1) or 1)
    total_ports = int(body.get("total_ports", 48) or 48)
    cassettes = body.get("cassettes") or []  # e.g. ["1A","1B"]

    if not room_val:
        raise HTTPException(status_code=400, detail="room ist erforderlich")

    # Resolve or create customer
    if not customer_id and customer_name:
        row = db.execute(
            text("SELECT id FROM customers WHERE LOWER(name) = LOWER(:n) LIMIT 1"),
            {"n": customer_name},
        ).mappings().first()
        if row:
            customer_id = int(row["id"])
        else:
            r = db.execute(
                text("INSERT INTO customers (name) VALUES (:n) RETURNING id"),
                {"n": customer_name},
            )
            customer_id = r.scalar()

    # Build instance_id: PP:{rack}:{pp_number} /RU{rack_unit}
    if pp_number and rack_label:
        instance_id = f"PP:{rack_label}:{pp_number}"
    elif pp_number:
        instance_id = f"PP:{pp_number}"
    else:
        instance_id = str(body.get("instance_id") or "").strip()

    if not instance_id:
        raise HTTPException(status_code=400, detail="instance_id oder pp_number ist erforderlich")

    result = db.execute(
        text(
            """
            INSERT INTO patchpanel_instances
                (instance_id, room, rack_unit, rack_label, cage_no, total_ports,
                 customer_id, pp_number, side)
            VALUES
                (:instance_id, :room, :rack_unit, :rack_label, :cage_no, :total_ports,
                 :customer_id, :pp_number, :side)
            RETURNING id
            """
        ),
        {
            "instance_id": instance_id,
            "room": room_val,
            "rack_unit": rack_unit,
            "rack_label": rack_label,
            "cage_no": cage_no,
            "total_ports": total_ports,
            "customer_id": customer_id,
            "pp_number": pp_number,
            "side": "Z" if customer_id else None,
        },
    )
    new_id = result.scalar()

    # Create port rows (all start as 'unavailable'; selected cassettes become 'free')
    selected_slots = {s.upper() for s in cassettes} if cassettes else set()
    port_inserts = []
    for pn in range(1, total_ports + 1):
        ci = (pn - 1) // 24 + 1
        within = (pn - 1) % 24
        gi = within // 6
        pos = (within % 6) + 1
        letter = "ABCD"[gi]
        label = f"{ci}{letter}{pos}"
        slot = f"{ci}{letter}"
        status = "free" if slot in selected_slots or not selected_slots else "unavailable"
        port_inserts.append({
            "ppid": new_id, "rn": ci, "rl": letter, "pos": pos,
            "label": label, "status": status,
        })

    if port_inserts:
        db.execute(
            text(
                "INSERT INTO patchpanel_ports "
                "(patchpanel_id, row_number, row_letter, position, port_label, status) "
                "VALUES (:ppid, :rn, :rl, :pos, :label, :status)"
            ),
            port_inserts,
        )

    db.commit()
    return {"success": True, "id": int(new_id), "instance_id": instance_id}


@router.get("/patchpanels/customers")
def list_customers(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List all customers with their locations and racks."""
    _ensure_pp_schema(db)
    rows = db.execute(
        text(
            """
            SELECT c.id, c.name,
                   cl.id AS loc_id, cl.room AS loc_room, cl.cage_no,
                   cr.id AS rack_id, cr.rack_label
            FROM customers c
            LEFT JOIN customer_locations cl ON cl.customer_id = c.id
            LEFT JOIN customer_racks cr ON cr.location_id = cl.id
            ORDER BY c.name, cl.room, cr.rack_label
            """
        )
    ).mappings().all()

    cust_map: dict[int, dict] = {}
    for r in rows:
        cid = int(r["id"])
        if cid not in cust_map:
            cust_map[cid] = {"id": cid, "name": r["name"], "locations": []}
        if r["loc_id"] is not None:
            loc_exists = any(
                l["id"] == int(r["loc_id"]) for l in cust_map[cid]["locations"]
            )
            if not loc_exists:
                loc = {
                    "id": int(r["loc_id"]),
                    "room": r["loc_room"],
                    "cage_no": r["cage_no"],
                    "racks": [],
                }
                cust_map[cid]["locations"].append(loc)
            # Find location and add rack
            for loc in cust_map[cid]["locations"]:
                if loc["id"] == int(r["loc_id"]) and r["rack_id"] is not None:
                    if not any(rk["id"] == int(r["rack_id"]) for rk in loc["racks"]):
                        loc["racks"].append({
                            "id": int(r["rack_id"]),
                            "rack_label": r["rack_label"],
                        })
                    break

    # Fetch all existing racks across the entire system
    system_racks_rows = db.execute(
        text("SELECT DISTINCT rack_label FROM patchpanel_instances WHERE rack_label IS NOT NULL AND TRIM(rack_label) <> '' ORDER BY rack_label")
    ).mappings().all()
    system_racks = [str(r["rack_label"]) for r in system_racks_rows]

    return {"success": True, "customers": list(cust_map.values()), "system_racks": system_racks}


@router.get("/patchpanels/rooms")
def list_patchpanel_rooms(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_pp_schema(db)
    rows = db.execute(
        text(
            """
            SELECT
                instance_id,
                room,
                room_code
            FROM public.patchpanel_instances
            """
        )
    ).mappings().all()

    rooms = sorted({r for r in (_derive_room(dict(row)) for row in rows) if r})
    return {"success": True, "rooms": rooms}


@router.get("/patchpanels/{pp_id}/ports")
def patchpanel_ports(
    pp_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    _ensure_pp_schema(db)
    panel = db.execute(
        text(
            """
            SELECT
                id,
                instance_id,
                room,
                room_code,
                rack_label,
                cage_no,
                total_ports,
                customer_id
            FROM public.patchpanel_instances
            WHERE id = :id
            LIMIT 1
            """
        ),
        {"id": int(pp_id)},
    ).mappings().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Patchpanel not found")

    port_rows = db.execute(
        text(
            """
            SELECT
                port_label,
                row_number,
                row_letter,
                position,
                COALESCE(status, 'free') AS base_status,
                connected_to,
                peer_instance_id,
                peer_port_label
            FROM public.patchpanel_ports
            WHERE patchpanel_id = :ppid
            ORDER BY row_number NULLS LAST, row_letter NULLS LAST, position NULLS LAST, port_label
            """
        ),
        {"ppid": int(pp_id)},
    ).mappings().all()

    panel_instance_id = str(panel.get("instance_id") or "").strip()
    occupied_rows = db.execute(
        text(
            """
            WITH occupied AS (
                SELECT
                    customer_port_label AS port_label,
                    serial,
                    COALESCE(system_name, '') AS customer,
                    'Z' AS side,
                    id AS cross_connect_id
                FROM public.cross_connects
                WHERE COALESCE(status, '') <> 'deinstalled'
                  AND customer_patchpanel_id = :ppid
                  AND customer_port_label IS NOT NULL

                UNION ALL

                SELECT
                    a_port_label AS port_label,
                    serial,
                    COALESCE(system_name, '') AS customer,
                    'A' AS side,
                    id AS cross_connect_id
                FROM public.cross_connects
                WHERE COALESCE(status, '') <> 'deinstalled'
                  AND a_port_label IS NOT NULL
                  AND (
                    a_patchpanel_id = :ppid_text
                    OR a_patchpanel_id = :instance_id
                  )

                UNION ALL

                SELECT
                    backbone_in_port_label AS port_label,
                    serial,
                    COALESCE(system_name, '') AS customer,
                    'BB_IN' AS side,
                    id AS cross_connect_id
                FROM public.cross_connects
                WHERE COALESCE(status, '') <> 'deinstalled'
                  AND backbone_in_port_label IS NOT NULL
                  AND backbone_in_instance_id = :instance_id

                UNION ALL

                SELECT
                    backbone_out_port_label AS port_label,
                    serial,
                    COALESCE(system_name, '') AS customer,
                    'BB_OUT' AS side,
                    id AS cross_connect_id
                FROM public.cross_connects
                WHERE COALESCE(status, '') <> 'deinstalled'
                  AND backbone_out_port_label IS NOT NULL
                  AND backbone_out_instance_id = :instance_id
            )
            SELECT
                port_label,
                serial,
                customer,
                side,
                cross_connect_id
            FROM occupied
            WHERE port_label IS NOT NULL AND TRIM(port_label) <> ''
            """
        ),
        {"ppid": int(pp_id), "ppid_text": str(pp_id), "instance_id": panel_instance_id},
    ).mappings().all()

    occupied_by_label: dict[str, dict[str, Any]] = {}
    ordered_occupied_labels: list[str] = []
    for row in occupied_rows:
        label = str(row.get("port_label") or "").strip()
        if not label:
            continue
        key = label.lower()
        if key in occupied_by_label:
            continue
        occupied_by_label[key] = {
            "serial": row.get("serial"),
            "customer": row.get("customer") or None,
            "side": row.get("side"),
            "cross_connect_id": int(row.get("cross_connect_id")) if row.get("cross_connect_id") is not None else None,
        }
        ordered_occupied_labels.append(label)

    labels: list[str] = []
    port_meta_by_label: dict[str, dict[str, Any]] = {}
    seen = set()
    for row in port_rows:
        label = str(row.get("port_label") or "").strip()
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        labels.append(label)
        port_meta_by_label[key] = {
            "peer_instance_id": row.get("peer_instance_id"),
            "peer_port_label": row.get("peer_port_label"),
            "connected_to": row.get("connected_to"),
            "base_status": str(row.get("base_status") or "free").strip().lower(),
        }

    ports_total = _normalize_ports_total(panel.get("total_ports"), len(labels), ordered_occupied_labels)

    if not labels:
        labels = [str(i) for i in range(1, ports_total + 1)]
    elif len(labels) < ports_total:
        numeric_seen = {str(_parse_port_int(x)) for x in labels if _parse_port_int(x) is not None}
        i = 1
        while len(labels) < ports_total:
            key = str(i)
            if key not in numeric_seen:
                labels.append(key)
                numeric_seen.add(key)
            i += 1
    elif len(labels) > ports_total:
        ports_total = len(labels)

    ports = []
    has_real_port_rows = len(port_rows) > 0
    for idx in range(ports_total):
        label = labels[idx] if idx < len(labels) else str(idx + 1)
        key = label.lower()
        occ = occupied_by_label.get(label.lower())
        meta = port_meta_by_label.get(key) or {}
        synthetic_unavailable = has_real_port_rows and key not in port_meta_by_label
        base_status = str(meta.get("base_status") or "free").lower()
        if synthetic_unavailable:
            normalized_status = "unavailable"
        else:
            normalized_status = "occupied" if occ else base_status
            if normalized_status in {"connected", "linked", "precabled"}:
                normalized_status = "free"
            if normalized_status in {"used", "consumed", "busy", "in_use"}:
                normalized_status = "occupied"
            if normalized_status not in {"occupied", "free", "unavailable"}:
                normalized_status = "free"

        legacy_occupied = bool(occ) or synthetic_unavailable

        ports.append(
            {
                "port_number": idx + 1,
                "port_label": label,
                "status": normalized_status,
                "occupied": legacy_occupied,
                "selectable": not legacy_occupied and normalized_status != "unavailable",
                "usable": normalized_status != "unavailable",
                "connected_to": meta.get("connected_to"),
                "peer_instance_id": meta.get("peer_instance_id"),
                "peer_port_label": meta.get("peer_port_label"),
                "is_occupied": bool(occ),
                # If no dedicated trunk table exists, occupancy is used as trunk indicator.
                "trunk_present": bool(occ),
                "trunk_id": None,
                "trunk_label": None,
                "serial": (occ or {}).get("serial"),
                "customer": (occ or {}).get("customer"),
                "side": (occ or {}).get("side"),
                "cross_connect_id": (occ or {}).get("cross_connect_id"),
            }
        )

    # ── Auto-activate cassettes: if ANY port in a cassette is occupied,
    #    set all "unavailable" sibling ports in that cassette to "free" ──
    occupied_cassettes: set[str] = set()
    for p in ports:
        if p["status"] == "occupied" or p.get("is_occupied"):
            m = re.match(r'^(\d+[A-D])\d+$', p["port_label"])
            if m:
                occupied_cassettes.add(m.group(1))
    if occupied_cassettes:
        for p in ports:
            if p["status"] == "unavailable":
                m = re.match(r'^(\d+[A-D])\d+$', p["port_label"])
                if m and m.group(1) in occupied_cassettes:
                    p["status"] = "free"
                    p["occupied"] = False
                    p["selectable"] = True
                    p["usable"] = True

    room = (panel.get("room") or panel.get("room_code") or "").strip()
    rack = (panel.get("rack_label") or "").strip()
    cage = (panel.get("cage_no") or "").strip()
    parts = [x for x in [room, rack, cage] if x]
    location = " / ".join(parts) if parts else None

    customer_id = panel.get("customer_id")
    category = _classify_pp(room, customer_id)

    return {
        "success": True,
        "patchpanel": {
            "id": int(panel["id"]),
            "name": panel.get("instance_id") or f"Patchpanel {panel['id']}",
            "location": location,
            "ports_total": int(ports_total),
            "customer_id": int(customer_id) if customer_id else None,
            "category": category,
        },
        "ports_total": int(ports_total),
        "ports": ports,
        "slots": [],
    }


@router.put("/patchpanels/{pp_id}/cassette/{cassette_slot}/release")
def release_cassette(
    pp_id: int = Path(..., ge=1),
    cassette_slot: str = Path(..., description="Kassette slot, e.g. 1A, 2B, 3D"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Release (freigeben) a cassette on a Z-side customer patchpanel.

    A cassette is a 6-port group identified by row+letter, e.g. '1A' = ports 1A1-1A6.
    Sets all ports in the given cassette from 'unavailable' to 'free'.
    Only allowed for Z-side (customer) patchpanels.
    """
    cassette_slot = cassette_slot.strip().upper()
    if len(cassette_slot) < 2 or not cassette_slot[:-1].isdigit() or cassette_slot[-1] not in "ABCD":
        raise HTTPException(status_code=400, detail=f"Ungültige Kassette: {cassette_slot}. Format: z.B. 1A, 2B, 3D")

    row_num = int(cassette_slot[:-1])
    letter = cassette_slot[-1]

    panel = db.execute(
        text("SELECT id, customer_id, total_ports FROM patchpanel_instances WHERE id = :id"),
        {"id": pp_id},
    ).mappings().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Patchpanel nicht gefunden")
    if not panel.get("customer_id"):
        raise HTTPException(status_code=400, detail="Kassette freigeben ist nur bei Kunden-Patchpanels (Z-Seite) möglich")

    # Build port labels for this cassette: e.g. slot '2B' → 2B1, 2B2, 2B3, 2B4, 2B5, 2B6
    labels = [f"{row_num}{letter}{pos}" for pos in range(1, 7)]

    # Check if any ports in this cassette are occupied (have active cross connects)
    occupied_check = db.execute(
        text(
            """
            SELECT COUNT(*) AS cnt
            FROM patchpanel_ports pp
            JOIN cross_connects cc ON (
                (cc.customer_patchpanel_id = pp.patchpanel_id
                 AND cc.customer_port_label = pp.port_label)
            )
            WHERE pp.patchpanel_id = :ppid
              AND pp.port_label = ANY(:labels)
              AND COALESCE(cc.status, '') <> 'deinstalled'
            """
        ),
        {"ppid": pp_id, "labels": labels},
    ).mappings().first()
    if occupied_check and int(occupied_check["cnt"]) > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Kassette {cassette_slot} hat noch belegte Ports und kann nicht freigegeben werden"
        )

    # Update unavailable → free for this cassette
    result = db.execute(
        text(
            """
            UPDATE patchpanel_ports
            SET status = 'free', updated_at = NOW()
            WHERE patchpanel_id = :ppid
              AND port_label = ANY(:labels)
              AND COALESCE(status, 'unavailable') = 'unavailable'
            """
        ),
        {"ppid": pp_id, "labels": labels},
    )
    updated = result.rowcount

    # If no port rows existed yet for this cassette, create them
    if updated == 0:
        existing = db.execute(
            text(
                "SELECT port_label FROM patchpanel_ports WHERE patchpanel_id = :ppid AND port_label = ANY(:labels)"
            ),
            {"ppid": pp_id, "labels": labels},
        ).mappings().all()
        existing_labels = {str(r["port_label"]).strip() for r in existing}
        inserts = []
        for pos in range(1, 7):
            label = f"{row_num}{letter}{pos}"
            if label not in existing_labels:
                inserts.append({
                    "ppid": pp_id,
                    "rn": row_num,
                    "rl": letter,
                    "pos": pos,
                    "label": label,
                    "status": "free",
                })
        if inserts:
            db.execute(
                text(
                    "INSERT INTO patchpanel_ports "
                    "(patchpanel_id, row_number, row_letter, position, port_label, status) "
                    "VALUES (:ppid, :rn, :rl, :pos, :label, :status)"
                ),
                inserts,
            )
            updated = len(inserts)

    db.commit()
    return {"success": True, "cassette": cassette_slot, "ports_released": updated}


@router.put("/patchpanels/{pp_id}/cassette/{cassette_slot}/lock")
def lock_cassette(
    pp_id: int = Path(..., ge=1),
    cassette_slot: str = Path(..., description="Kassette slot, e.g. 1A, 2B, 3D"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Lock (sperren / deinstallieren) a cassette on a Z-side customer patchpanel.

    Sets all free (unoccupied) ports in the given cassette to 'unavailable'.
    Only allowed for Z-side (customer) patchpanels.
    Refuses if any port in the cassette is still occupied.
    """
    cassette_slot = cassette_slot.strip().upper()
    if len(cassette_slot) < 2 or not cassette_slot[:-1].isdigit() or cassette_slot[-1] not in "ABCD":
        raise HTTPException(status_code=400, detail=f"Ungültige Kassette: {cassette_slot}. Format: z.B. 1A, 2B, 3D")

    row_num = int(cassette_slot[:-1])
    letter = cassette_slot[-1]

    panel = db.execute(
        text("SELECT id, customer_id, total_ports FROM patchpanel_instances WHERE id = :id"),
        {"id": pp_id},
    ).mappings().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Patchpanel nicht gefunden")
    if not panel.get("customer_id"):
        raise HTTPException(status_code=400, detail="Kassette sperren ist nur bei Kunden-Patchpanels (Z-Seite) möglich")

    labels = [f"{row_num}{letter}{pos}" for pos in range(1, 7)]

    # Check if any ports in this cassette are occupied
    occupied_check = db.execute(
        text(
            """
            SELECT COUNT(*) AS cnt
            FROM patchpanel_ports pp
            JOIN cross_connects cc ON (
                cc.customer_patchpanel_id = pp.patchpanel_id
                AND cc.customer_port_label = pp.port_label
            )
            WHERE pp.patchpanel_id = :ppid
              AND pp.port_label = ANY(:labels)
              AND COALESCE(cc.status, '') <> 'deinstalled'
            """
        ),
        {"ppid": pp_id, "labels": labels},
    ).mappings().first()
    if occupied_check and int(occupied_check["cnt"]) > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Kassette {cassette_slot} hat noch belegte Ports und kann nicht gesperrt werden"
        )

    # Update free → unavailable for this cassette
    result = db.execute(
        text(
            """
            UPDATE patchpanel_ports
            SET status = 'unavailable', updated_at = NOW()
            WHERE patchpanel_id = :ppid
              AND port_label = ANY(:labels)
              AND COALESCE(status, 'free') <> 'unavailable'
            """
        ),
        {"ppid": pp_id, "labels": labels},
    )
    updated = result.rowcount

    db.commit()
    return {"success": True, "cassette": cassette_slot, "ports_locked": updated}


# ────────────────────────────────────────────────────────────
# DELETE PATCHPANEL (Deinstall)
# ────────────────────────────────────────────────────────────
@router.delete("/patchpanels/{pp_id}")
def delete_patchpanel(
    pp_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Deinstall / delete a patchpanel completely.

    Only allowed when NO active cross-connects reference this PP.
    """
    panel = db.execute(
        text("SELECT id, instance_id, customer_id FROM patchpanel_instances WHERE id = :id"),
        {"id": pp_id},
    ).mappings().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Patchpanel nicht gefunden")

    # Check for active cross-connects on Z-side
    occ_z = db.execute(
        text(
            """
            SELECT COUNT(*) AS cnt
            FROM cross_connects
            WHERE customer_patchpanel_id = :ppid
              AND COALESCE(status, '') <> 'deinstalled'
            """
        ),
        {"ppid": pp_id},
    ).mappings().first()
    if occ_z and int(occ_z["cnt"]) > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Patchpanel hat noch {occ_z['cnt']} aktive Leitung(en). Bitte zuerst alle Leitungen deinstallieren."
        )

    # Check for active cross-connects referencing this PP via a_patchpanel_id (instance_id match)
    inst_id = panel["instance_id"]
    occ_a = db.execute(
        text(
            """
            SELECT COUNT(*) AS cnt
            FROM cross_connects
            WHERE a_patchpanel_id = :inst
              AND COALESCE(status, '') <> 'deinstalled'
            """
        ),
        {"inst": inst_id},
    ).mappings().first()
    if occ_a and int(occ_a["cnt"]) > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Patchpanel wird noch als A-Seite bei {occ_a['cnt']} Leitung(en) verwendet."
        )

    # Delete ports first, then the patchpanel
    db.execute(
        text("DELETE FROM patchpanel_ports WHERE patchpanel_id = :ppid"),
        {"ppid": pp_id},
    )
    db.execute(
        text("DELETE FROM patchpanel_instances WHERE id = :ppid"),
        {"ppid": pp_id},
    )
    db.commit()
    return {"success": True, "deleted_id": pp_id, "instance_id": inst_id}
