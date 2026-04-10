from fastapi import APIRouter, Depends, HTTPException, Query, Body
from sqlalchemy.orm import Session
from sqlalchemy import func, text
from typing import List
from datetime import datetime

from database import get_db
from crud import (
    get_all_rooms,
    get_room_overview,
    get_switch_details,
    get_precabling_stats,
    get_switches_in_room
)
from models import (
    RoomOverview,
    PatchPanelInstance,
    PatchPanelPort,
    PatchPanelInstanceRead,
    PreCabledLink
)

router = APIRouter()

# =========================================================
# PATCHPANEL VIEW (Dropdown + Ports)
# =========================================================

@router.get("/patchpanel-rooms")
def get_patchpanel_rooms(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT DISTINCT room
        FROM patchpanel_instances
        WHERE room IS NOT NULL AND room <> ''
        ORDER BY room
    """)).fetchall()

    return {"success": True, "rooms": [r.room for r in rows]}


@router.get("/patchpanel-instances")
def get_patchpanel_instances_by_room(
    room: str = Query(..., description="Room Name, z.B. '5.13S1'"),
    db: Session = Depends(get_db)
):
    norms = _room_norm_variants(room)
    if not norms:
        return {"success": True, "instances": []}

    params = {f"n{i}": n for i, n in enumerate(norms)}
    where_in = ", ".join([f":n{i}" for i in range(len(norms))])

    rows = db.execute(text(f"""
        SELECT instance_id, rack_unit, panel_type, total_ports
        FROM patchpanel_instances
        WHERE regexp_replace(upper(room), '[^A-Z0-9]', '', 'g') IN ({where_in})
        ORDER BY rack_unit, instance_id
    """), params).fetchall()

    return {
        "success": True,
        "instances": [
            {
                "instance_id": r.instance_id,
                "rack_unit": r.rack_unit,
                "panel_type": r.panel_type,
                "total_ports": r.total_ports
            } for r in rows
        ]
    }


@router.get("/patchpanel-ports")
def get_patchpanel_ports(
    instance_id: str = Query(..., description="PatchPanel ID wie '5.4S6/RU1'", example="5.4S6/RU1"),
    db: Session = Depends(get_db)
):
    """
    ✅ FIX:
    - connected  = Peer vorhanden (Info, NICHT belegt)
    - occupied   = wirklich belegt (connected_to != '')
    - selectable = nur wenn NICHT occupied
    - RESPONSE: ports ist LISTE (frontend-friendly)
    """
    try:
        panel = db.execute(text("""
            SELECT id, room, rack_unit, total_ports, panel_type, instance_id
            FROM patchpanel_instances
            WHERE instance_id = :iid
            LIMIT 1
        """), {"iid": instance_id}).fetchone()

        if not panel:
            raise HTTPException(status_code=404, detail=f"PatchPanel '{instance_id}' nicht gefunden")

        ports = db.execute(text("""
            SELECT
                port_label,
                row_number,
                row_letter,
                position,
                status,
                peer_instance_id,
                peer_port_label,
                connected_to
            FROM patchpanel_ports
            WHERE patchpanel_id = :pid
            ORDER BY row_number, row_letter, position
            LIMIT 96
        """), {"pid": panel.id}).fetchall()

        ports_list = []
        peer_count = 0
        occupied_count = 0

        for p in ports:
            ct = (p.connected_to or "").strip()
            peer_present = (p.peer_instance_id is not None) and (str(p.peer_instance_id).strip() != "")
            occupied = (ct != "")                 # ✅ NUR connected_to blockiert
            selectable = not occupied              # ✅ UI: grün wenn True

            if peer_present:
                peer_count += 1
            if occupied:
                occupied_count += 1

            ports_list.append({
                "label": p.port_label,
                "row": p.row_number,
                "letter": p.row_letter,
                "position": p.position,

                # original status bleibt drin (falls UI irgendwo nutzt)
                "status": p.status,

                # ✅ eindeutiger status für UI:
                "ui_status": ("occupied" if occupied else ("connected" if peer_present else "free")),

                # ✅ wichtig:
                "connected": peer_present,
                "occupied": occupied,
                "selectable": selectable,

                "peer": {
                    "instance_id": p.peer_instance_id,
                    "port_label": p.peer_port_label
                } if peer_present else None,

                "switch_connection": ct if occupied else None
            })

        total = len(ports_list)

        # ✅ WICHTIG: ports als LISTE zurückgeben + meta extra
        return {
            "success": True,
            "patchpanel": {
                "instance_id": panel.instance_id,
                "id": panel.id,
                "room": panel.room,
                "rack_unit": panel.rack_unit,
                "total_ports": panel.total_ports,
                "panel_type": panel.panel_type
            },
            "ports": ports_list,
            "ports_meta": {
                "total": total,
                "connected": peer_count,                 # peer count (info)
                "occupied": occupied_count,              # real occupied
                "available": total - occupied_count,     # real available
                "utilization_percent": round((occupied_count / total * 100), 2) if total else 0
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
@router.get("/patchpanel-backbone-instances")
def get_backbone_instances_by_room(
    room: str = Query(..., description="Room Name, z.B. '5.13S1'"),
    db: Session = Depends(get_db)
):
    """
    Liefert NUR Panels im Raum, die Ports haben, deren Peer in einem ANDEREN Raum ist.
    => das sind deine 'kleinen Backbone PPs' die in andere Räume gehen.
    """
    rows = db.execute(text("""
        SELECT DISTINCT
            i.instance_id, i.rack_unit, i.panel_type, i.total_ports
        FROM patchpanel_instances i
        JOIN patchpanel_ports p
          ON p.patchpanel_id = i.id
        JOIN patchpanel_instances peer
          ON peer.instance_id = p.peer_instance_id
        WHERE i.room = :room
          AND p.peer_instance_id IS NOT NULL
          AND peer.room IS NOT NULL AND peer.room <> ''
          AND peer.room <> :room
        ORDER BY i.rack_unit, i.instance_id
    """), {"room": room}).fetchall()

    return {
        "success": True,
        "instances": [
            {
                "instance_id": r.instance_id,
                "rack_unit": r.rack_unit,
                "panel_type": r.panel_type,
                "total_ports": r.total_ports
            } for r in rows
        ]
    }
    


@router.get("/patchpanel-peer")
def get_patchpanel_peer(
    instance_id: str = Query(...),
    port_label: str = Query(...),
    db: Session = Depends(get_db)
):
    # instance meta
    panel = db.execute(text("""
        SELECT id, room
        FROM patchpanel_instances
        WHERE instance_id = :iid
        LIMIT 1
    """), {"iid": instance_id}).fetchone()

    if not panel:
        raise HTTPException(status_code=404, detail=f"PatchPanel '{instance_id}' nicht gefunden")

    # port + peer
    port = db.execute(text("""
        SELECT peer_instance_id, peer_port_label, status, connected_to
        FROM patchpanel_ports
        WHERE patchpanel_id = :pid AND port_label = :lbl
        LIMIT 1
    """), {"pid": panel.id, "lbl": port_label}).fetchone()

    if not port:
        raise HTTPException(status_code=404, detail=f"Port '{port_label}' nicht gefunden")

    # peer room (wenn peer existiert)
    peer_room = None
    if port.peer_instance_id:
        peer_row = db.execute(text("""
            SELECT room
            FROM patchpanel_instances
            WHERE instance_id = :piid
            LIMIT 1
        """), {"piid": port.peer_instance_id}).fetchone()
        peer_room = peer_row.room if peer_row else None

    ct = (port.connected_to or "").strip()
    peer_present = (port.peer_instance_id is not None)
    occupied = (ct != "")

    return {
        "success": True,
        "instance_id": instance_id,
        "instance_room": panel.room,
        "port_label": port_label,

        "connected": peer_present,   # peer-info
        "occupied": occupied,        # real occupied

        "peer_instance_id": port.peer_instance_id,
        "peer_port_label": port.peer_port_label,
        "peer_room": peer_room,

        "switch_connection": ct if occupied else None
    }
@router.get("/patchpanel-backbone-out")
def get_backbone_out_panels(
    room: str = Query(...),
    db: Session = Depends(get_db)
):
    """
    Step2: nur Panels IM room, die Ports haben, deren Peer in ANDEREM room liegt.
    (= deine grünen Panels)
    """
    rows = db.execute(text("""
        SELECT DISTINCT
            i.instance_id, i.rack_unit, i.panel_type, i.total_ports
        FROM patchpanel_instances i
        JOIN patchpanel_ports p ON p.patchpanel_id = i.id
        JOIN patchpanel_instances peer ON peer.instance_id = p.peer_instance_id
        WHERE i.room = :room
          AND p.peer_instance_id IS NOT NULL
          AND peer.room IS NOT NULL AND peer.room <> ''
          AND peer.room <> :room
        ORDER BY i.rack_unit, i.instance_id
    """), {"room": room}).fetchall()

    return {
        "success": True,
        "instances": [
            {
                "instance_id": r.instance_id,
                "rack_unit": r.rack_unit,
                "panel_type": r.panel_type,
                "total_ports": r.total_ports
            } for r in rows
        ]
    }



# =========================================================
# CONNECTION WORKFLOW (Switch -> PreCabled -> Save Patch)
# =========================================================

@router.get("/precabled-by-switch")
def precabled_by_switch(
    switch_name: str = Query(...),
    switch_port: str = Query(...),
    db: Session = Depends(get_db)
):
    row = db.execute(text("""
        SELECT id, room, switch_name, switch_port, patchpanel_id, patchpanel_port, patchpanel_pair
        FROM pre_cabled_links
        WHERE switch_name = :sn AND switch_port = :sp
        ORDER BY id ASC
        LIMIT 1
    """), {"sn": switch_name, "sp": switch_port}).fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Kein Pre-Cabled Link für diesen Switch-Port gefunden")

    return {
        "success": True,
        "link": {
            "id": row.id,
            "room": row.room,
            "switch_name": row.switch_name,
            "switch_port": row.switch_port,
            "patchpanel_id": row.patchpanel_id,
            "patchpanel_port": row.patchpanel_port,
            "patchpanel_pair": row.patchpanel_pair
        }
    }


@router.get("/manual-patch")
def get_manual_patch(
    a_patchpanel_id: str = Query(...),
    a_port: str = Query(...),
    db: Session = Depends(get_db)
):
    row = db.execute(text("""
        SELECT id, a_patchpanel_id, a_port, b_instance_id, b_port_label, cable_type, note, created_by, created_at
        FROM manual_patches
        WHERE a_patchpanel_id = :aid AND a_port = :aport
        LIMIT 1
    """), {"aid": a_patchpanel_id, "aport": a_port}).fetchone()

    return {
        "success": True,
        "patch": {
            "id": row.id,
            "a_patchpanel_id": row.a_patchpanel_id,
            "a_port": row.a_port,
            "b_instance_id": row.b_instance_id,
            "b_port_label": row.b_port_label,
            "cable_type": row.cable_type,
            "note": row.note,
            "created_by": row.created_by,
            "created_at": row.created_at.isoformat() if row.created_at else None
        } if row else None
    }


@router.post("/manual-patch")
def create_manual_patch(
    payload: dict = Body(...),
    db: Session = Depends(get_db)
):
    a_id = (payload.get("a_patchpanel_id") or "").strip()
    a_port = (payload.get("a_port") or "").strip()
    b_iid = (payload.get("b_instance_id") or "").strip()
    b_port = (payload.get("b_port_label") or "").strip()

    if not a_id or not a_port or not b_iid or not b_port:
        raise HTTPException(status_code=400, detail="Missing fields")

    # Source schon dokumentiert?
    existing_a = db.execute(text("""
        SELECT b_instance_id, b_port_label
        FROM manual_patches
        WHERE a_patchpanel_id = :a_id AND a_port = :a_port
        LIMIT 1
    """), {"a_id": a_id, "a_port": a_port}).fetchone()

    if existing_a:
        raise HTTPException(status_code=409, detail=f"Source {a_id}/{a_port} ist schon dokumentiert")

    # Ziel schon dokumentiert?
    used_target = db.execute(text("""
        SELECT a_patchpanel_id, a_port
        FROM manual_patches
        WHERE b_instance_id = :b_iid AND b_port_label = :b_port
        LIMIT 1
    """), {"b_iid": b_iid, "b_port": b_port}).fetchone()

    if used_target:
        raise HTTPException(status_code=409, detail=f"Ziel {b_iid}/{b_port} ist schon belegt")

    # Ziel Panel
    panel = db.execute(text("""
        SELECT id, room
        FROM patchpanel_instances
        WHERE instance_id = :iid
        LIMIT 1
    """), {"iid": b_iid}).fetchone()

    if not panel:
        raise HTTPException(status_code=404, detail=f"Ziel Patchpanel '{b_iid}' nicht gefunden")

    # Ziel Port
    port_row = db.execute(text("""
        SELECT peer_instance_id, connected_to
        FROM patchpanel_ports
        WHERE patchpanel_id = :pid AND port_label = :lbl
        LIMIT 1
    """), {"pid": panel.id, "lbl": b_port}).fetchone()

    if not port_row:
        raise HTTPException(status_code=404, detail=f"Ziel Port '{b_port}' nicht gefunden")

    ct_existing = (port_row.connected_to or "").strip()

    # ✅ FIX: Peer bedeutet NICHT belegt – nur connected_to blockiert
    target_is_occupied = (ct_existing != "")
    if target_is_occupied:
        raise HTTPException(status_code=409, detail=f"Ziel-Port {b_iid}/{b_port} ist bereits belegt")

    # Insert
    db.execute(text("""
        INSERT INTO manual_patches (a_patchpanel_id, a_port, b_instance_id, b_port_label, cable_type, note, created_by)
        VALUES (:a_id, :a_port, :b_iid, :b_port, :cable_type, :note, :created_by)
    """), {
        "a_id": a_id,
        "a_port": a_port,
        "b_iid": b_iid,
        "b_port": b_port,
        "cable_type": (payload.get("cable_type") or "LC").strip(),
        "note": payload.get("note"),
        "created_by": payload.get("created_by")
    })

    # Markiere Ziel-Port belegt
    connected_to = f"manual:{a_id}:{a_port}"
    db.execute(text("""
        UPDATE patchpanel_ports
        SET status = 'connected',
            connected_to = :ct
        WHERE patchpanel_id = :pid AND port_label = :lbl
    """), {"ct": connected_to, "pid": panel.id, "lbl": b_port})

    db.commit()

    return {
        "success": True,
        "saved": {
            "a_patchpanel_id": a_id,
            "a_port": a_port,
            "b_instance_id": b_iid,
            "b_port_label": b_port,
            "b_room": panel.room
        }
    }


# =========================================================
# INSTALL-FORM HELPERS  (switch autocomplete, A-side resolve,
#                        customer PP lookup, BB panel search)
# =========================================================

@router.get("/switch-names")
def get_switch_names(q: str = Query("", description="Optional prefix filter"),
                     db: Session = Depends(get_db)):
    """Distinct RFRA switch names from pre_cabled_links (for autocomplete)."""
    if q.strip():
        rows = db.execute(text("""
            SELECT DISTINCT switch_name
            FROM pre_cabled_links
            WHERE switch_name ILIKE :q
            ORDER BY switch_name
            LIMIT 50
        """), {"q": f"{q.strip()}%"}).fetchall()
    else:
        rows = db.execute(text("""
            SELECT DISTINCT switch_name
            FROM pre_cabled_links
            ORDER BY switch_name
        """)).fetchall()
    return {"success": True, "items": [r.switch_name for r in rows]}


@router.get("/switch-ports")
def get_switch_ports(switch_name: str = Query(...),
                     q: str = Query("", description="Optional prefix filter"),
                     db: Session = Depends(get_db)):
    """Distinct ports for a given RFRA switch name (for autocomplete).
    Excludes ports already used by active/pending cross-connects."""
    params = {"sn": switch_name.strip()}
    sql = """
        SELECT DISTINCT pcl.switch_port
        FROM pre_cabled_links pcl
        WHERE pcl.switch_name = :sn
          AND NOT EXISTS (
              SELECT 1 FROM cross_connects cc
              WHERE cc.switch_name = pcl.switch_name
                AND cc.switch_port = pcl.switch_port
                AND cc.status NOT IN ('deinstalled', 'canceled')
          )
    """
    if q.strip():
        sql += " AND pcl.switch_port ILIKE :q"
        params["q"] = f"{q.strip()}%"
    sql += " ORDER BY pcl.switch_port LIMIT 100"
    rows = db.execute(text(sql), params).fetchall()
    return {"success": True, "items": [r.switch_port for r in rows]}


@router.get("/resolve-switch-port")
def resolve_switch_port(switch_name: str = Query(...),
                        switch_port: str = Query(...),
                        db: Session = Depends(get_db)):
    """Resolve RFRA switch+port → A-side PP (instance_id + integer DB id) + port + room."""
    sw = switch_name.strip()
    sp = switch_port.strip()
    link = db.execute(text("""
        SELECT patchpanel_id, patchpanel_port, room,
               COALESCE(room_norm, room) AS room_norm
        FROM pre_cabled_links
        WHERE switch_name = :sw AND switch_port = :sp
        LIMIT 1
    """), {"sw": sw, "sp": sp}).mappings().first()
    if not link:
        return {"found": False}

    pp_instance_id = link["patchpanel_id"]
    pp_port = link["patchpanel_port"]
    a_room = link["room_norm"] or link["room"]

    # Resolve instance_id → integer DB id for port grid
    pp_row = db.execute(text("""
        SELECT id FROM patchpanel_instances WHERE instance_id = :iid LIMIT 1
    """), {"iid": pp_instance_id}).fetchone()

    return {
        "found": True,
        "a_pp_instance_id": pp_instance_id,
        "a_pp_db_id": pp_row.id if pp_row else None,
        "a_port_label": pp_port,
        "a_room": a_room,
    }


# Backbone (A-side) rooms — never a real customer room
_BACKBONE_ROOMS_RAW = [
    "5.4S6", "5.13S1",
    "M5.04 S6", "M5.04S6", "M5.4S6", "5.04S6", "5.04 S6",
    "M5.13 S1", "M5.13S1",
]
_BACKBONE_ROOMS = {r.upper().replace(" ", "") for r in _BACKBONE_ROOMS_RAW}


def _is_backbone_room(room: str) -> bool:
    if not room:
        return False
    return room.upper().replace(" ", "") in _BACKBONE_ROOMS


def _find_customer_rooms(db: Session, customer_id) -> list[str]:
    """Return the customer's non-backbone location rooms (the *real* customer rooms)."""
    if not customer_id:
        return []
    rows = db.execute(text("""
        SELECT DISTINCT cl.room
        FROM customer_locations cl
        WHERE cl.customer_id = :cid AND cl.room IS NOT NULL AND cl.room <> ''
    """), {"cid": customer_id}).fetchall()
    return [r.room for r in rows if not _is_backbone_room(r.room)]


@router.get("/customer-pp-lookup")
def customer_pp_lookup(instance_id: str = Query(...),
                       db: Session = Depends(get_db)):
    """Lookup a patchpanel by instance_id → return customer name, room, DB id.
    Also returns the real customer room(s) (non-backbone) for BB routing.
    """
    iid = instance_id.strip()
    row = db.execute(text("""
        SELECT pi.id, pi.instance_id, pi.room, pi.customer_id,
               pi.rack_label, pi.cage_no, pi.room_code,
               c.name AS customer_name
        FROM patchpanel_instances pi
        LEFT JOIN customers c ON c.id = pi.customer_id
        WHERE pi.instance_id = :iid
        LIMIT 1
    """), {"iid": iid}).mappings().first()
    if not row:
        return {"found": False}
    cust_rooms = _find_customer_rooms(db, row["customer_id"])

    # Look up existing system_name from active cross_connects using this PP
    existing_sn = db.execute(text("""
        SELECT system_name FROM public.cross_connects
        WHERE customer_patchpanel_id = :ppid
          AND system_name IS NOT NULL AND system_name <> ''
        LIMIT 1
    """), {"ppid": row["id"]}).scalars().first()

    return {
        "found": True,
        "db_id": row["id"],
        "instance_id": row["instance_id"],
        "room": row["room"],
        "rack_label": row["rack_label"],
        "cage_no": row["cage_no"],
        "room_code": row["room_code"],
        "customer_id": row["customer_id"],
        "customer_name": row["customer_name"],
        "customer_rooms": cust_rooms,              # non-backbone rooms
        "existing_system_name": existing_sn,        # from active cross_connects
    }


@router.get("/patchpanel-search")
def patchpanel_search(q: str = Query(..., min_length=2),
                      db: Session = Depends(get_db)):
    """Search patchpanels by instance_id prefix. Returns with customer info."""
    rows = db.execute(text("""
        SELECT pi.id, pi.instance_id, pi.room, pi.customer_id,
               pi.rack_label, pi.cage_no, pi.room_code,
               c.name AS customer_name
        FROM patchpanel_instances pi
        LEFT JOIN customers c ON c.id = pi.customer_id
        WHERE pi.instance_id ILIKE :q
        ORDER BY pi.instance_id
        LIMIT 20
    """), {"q": f"%{q.strip()}%"}).mappings().fetchall()
    # Collect unique customer_ids and batch-lookup their real rooms
    cust_ids = {r["customer_id"] for r in rows if r["customer_id"]}
    cust_room_map = {}
    for cid in cust_ids:
        cust_room_map[cid] = _find_customer_rooms(db, cid)
    # Batch-lookup existing system_names from cross_connects for each PP
    pp_ids = [r["id"] for r in rows]
    sn_map: dict[int, str] = {}
    if pp_ids:
        sn_rows = db.execute(text("""
            SELECT DISTINCT ON (customer_patchpanel_id)
                   customer_patchpanel_id, system_name
            FROM public.cross_connects
            WHERE customer_patchpanel_id = ANY(:ids)
              AND system_name IS NOT NULL AND system_name <> ''
            ORDER BY customer_patchpanel_id, id
        """), {"ids": pp_ids}).mappings().fetchall()
        for sr in sn_rows:
            sn_map[sr["customer_patchpanel_id"]] = sr["system_name"]
    return {
        "success": True,
        "items": [
            {
                "db_id": r["id"],
                "instance_id": r["instance_id"],
                "room": r["room"],
                "rack_label": r["rack_label"],
                "cage_no": r["cage_no"],
                "room_code": r["room_code"],
                "customer_id": r["customer_id"],
                "customer_name": r["customer_name"],
                "customer_rooms": cust_room_map.get(r["customer_id"], []),
                "existing_system_name": sn_map.get(r["id"], None),
            }
            for r in rows
        ],
    }


@router.get("/bb-panels-for-customer-room")
def bb_panels_for_customer_room(customer_room: str = Query(...),
                                db: Session = Depends(get_db)):
    """
    BB panels in backbone rooms (5.4S6 / 5.13S1) whose ports peer to panels
    in the given customer room.  Tries multiple room variants for matching.
    """
    cr = customer_room.strip()
    # Build room variants: e.g. "M4.5" → {"M4.5", "4.5"}, "5.04S6" → {"5.04S6", "5.4S6"}
    variants = {cr}
    # Strip leading M
    if cr.upper().startswith("M") and len(cr) > 1 and cr[1:2].isdigit():
        variants.add(cr[1:])
    # Remove spaces
    variants.add(cr.replace(" ", ""))
    if cr.upper().startswith("M"):
        variants.add(cr[1:].replace(" ", ""))
    # Also try adding M prefix
    if not cr.upper().startswith("M"):
        variants.add("M" + cr)
    # Strip leading zeros in minor (5.04 → 5.4)
    for v in list(variants):
        import re as _r
        m = _r.match(r"^(M?)(\d+)\.0*(\d+)(.*)", v)
        if m:
            variants.add(f"{m.group(1)}{m.group(2)}.{m.group(3)}{m.group(4)}")
    match_rooms = list(variants)

    # Use IN clause with explicit bind params
    placeholders = ", ".join(f":r{i}" for i in range(len(match_rooms)))
    params = {f"r{i}": r for i, r in enumerate(match_rooms)}
    rows = db.execute(text(f"""
        SELECT DISTINCT
            i.id        AS bb_db_id,
            i.instance_id AS bb_instance_id,
            i.room      AS bb_room,
            i.rack_unit,
            i.panel_type,
            i.total_ports,
            peer.instance_id AS peer_instance_id,
            peer.room        AS peer_room
        FROM patchpanel_instances i
        JOIN patchpanel_ports p   ON p.patchpanel_id = i.id
        JOIN patchpanel_instances peer ON peer.instance_id = p.peer_instance_id
        WHERE i.room IN ('5.4S6','5.13S1')
          AND peer.room IN ({placeholders})
        ORDER BY i.room, i.instance_id
    """), params).mappings().fetchall()
    return {
        "success": True,
        "items": [
            {
                "bb_db_id": r["bb_db_id"],
                "bb_instance_id": r["bb_instance_id"],
                "bb_room": r["bb_room"],
                "rack_unit": r["rack_unit"],
                "panel_type": r["panel_type"],
                "total_ports": r["total_ports"],
                "peer_instance_id": r["peer_instance_id"],
                "peer_room": r["peer_room"],
            }
            for r in rows
        ],
    }


# =========================================================
# EXISTING ENDPOINTS (Switch/Rooms)
# =========================================================

@router.get("/rooms", response_model=list[str])
def read_all_rooms(db: Session = Depends(get_db)):
    return get_all_rooms(db)

@router.get("/room/{room_name}", response_model=RoomOverview)
def read_room_overview(room_name: str, db: Session = Depends(get_db)):
    return get_room_overview(db, room_name)

@router.get("/switch/{switch_name}")
def read_switch_details(switch_name: str, db: Session = Depends(get_db)):
    return get_switch_details(db, switch_name)

@router.get("/room/{room_name}/switches", response_model=list[str])
def read_switches_in_room(room_name: str, db: Session = Depends(get_db)):
    return get_switches_in_room(db, room_name)

@router.get("/stats")
def read_precabling_stats(db: Session = Depends(get_db)):
    return get_precabling_stats(db)

@router.get("/health")
def rackview_health():
    return {"status": "healthy", "service": "rackview-api"}
import re as _re

def _room_norm_variants(room: str):
    """Return normalized variants for matching rooms like 5.04S6 vs 5.4S6 and optional leading M."""
    if not room:
        return []
    s = str(room).strip()
    # remove spaces
    s = s.replace(" ", "")
    # strip leading 'Room' etc not expected but safe
    # remove leading M for parsing
    core0 = s[1:] if s.upper().startswith("M") and len(s) > 1 else s
    m = _re.match(r"^(\d+)\.(\d+)(S\d+)?$", core0, flags=_re.IGNORECASE)
    cores = []
    if m:
        major = m.group(1)
        minor = m.group(2)
        cage = m.group(3) or ""
        keep = f"{major}.{minor}{cage}"
        strip = f"{major}.{int(minor)}{cage}"
        cores = [keep]
        if strip != keep:
            cores.append(strip)
    else:
        cores = [core0]
    out = []
    for c in cores:
        out.append(c)
        out.append("M" + c)
    # normalize to alnum uppercase
    norms = []
    seen=set()
    for v in out:
        n = _re.sub(r"[^A-Z0-9]", "", v.upper())
        if n and n not in seen:
            seen.add(n)
            norms.append(n)
    return norms



