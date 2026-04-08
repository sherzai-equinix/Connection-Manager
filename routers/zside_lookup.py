from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any

from database import get_db

router = APIRouter(tags=["zside-lookup"])


# =========================================
# GET /rooms
# =========================================
@router.get("/rooms")
def get_rooms(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT DISTINCT room
        FROM customer_locations
        WHERE room IS NOT NULL AND room <> ''
        ORDER BY room;
    """)).fetchall()
    return [r[0] for r in rows]


# =========================================
# GET /rooms/{room}/racks?cage_no=...
# =========================================
@router.get("/rooms/{room}/racks")
def get_racks_by_room(room: str, cage_no: Optional[str] = None, db: Session = Depends(get_db)):
    cage_no = (cage_no or "").strip() or None

    sql = """
        SELECT r.id, r.rack_label
        FROM customer_racks r
        JOIN customer_locations l ON l.id = r.location_id
        WHERE l.room = :room
    """
    params: Dict[str, Any] = {"room": room}

    if cage_no is None:
        sql += " AND NULLIF(l.cage_no,'') IS NULL "
    else:
        sql += " AND NULLIF(l.cage_no,'') = :cage_no "
        params["cage_no"] = cage_no

    sql += " ORDER BY r.rack_label; "

    rows = db.execute(text(sql), params).mappings().all()
    return [{"id": int(r["id"]), "name": r["rack_label"]} for r in rows]


# =========================================
# GET /racks/{rack_id}/patchpanels?customer_id=...
# =========================================
@router.get("/racks/{rack_id}/patchpanels")
def get_patchpanels_by_rack(rack_id: int, customer_id: Optional[int] = None, db: Session = Depends(get_db)):
    sql = """
        SELECT id, instance_id, room, rack_label, rack_unit, total_ports, cage_no
        FROM patchpanel_instances
        WHERE customer_rack_id = :rid
    """
    params: Dict[str, Any] = {"rid": int(rack_id)}

    if customer_id is not None:
        sql += " AND customer_id = :cid "
        params["cid"] = int(customer_id)

    sql += " ORDER BY rack_unit NULLS LAST, instance_id;"

    rows = db.execute(text(sql), params).mappings().all()
    return [
        {
            "id": int(r["id"]),
            "name": r["instance_id"],   # frontend zeigt meistens instance_id an
            "instance_id": r["instance_id"],
            "room": r["room"],
            "rack_label": r["rack_label"],
            "rack_unit": r["rack_unit"],
            "total_ports": r["total_ports"],
            "cage_no": r["cage_no"],
        }
        for r in rows
    ]


# =========================================
# GET /patchpanels/{pp_id}/ports
# =========================================
@router.get("/patchpanels/{pp_id}/ports")
def get_ports_by_patchpanel(pp_id: int, db: Session = Depends(get_db)):
    # NOTE:
    # In practice, occupancy for customer ports is best derived from the
    # cross_connects table (workflow/asset truth) instead of relying only on
    # patchpanel_ports.status which might not be maintained for every flow.
    # We therefore overlay an "occupied" flag when a non-deinstalled
    # cross-connect uses the same customer_patchpanel_id + customer_port_label.

    rows = db.execute(text("""
        SELECT
          p.port_label,
          COALESCE(p.status,'free') AS base_status,
          p.connected_to,
          p.peer_instance_id,
          p.peer_port_label,
          pi.instance_id AS patchpanel_instance_id,
          -- Occupied overlay derived from cross_connects (assets/workflow truth)
          EXISTS(
            SELECT 1
            FROM public.cross_connects cc
            WHERE COALESCE(cc.status,'') <> 'deinstalled'
              AND (
                -- customer side
                (cc.customer_patchpanel_id = :ppid AND cc.customer_port_label = p.port_label)
                -- backbone fields (DB may have IN/OUT swapped historically, so check both)
                OR (cc.backbone_in_instance_id = pi.instance_id AND cc.backbone_in_port_label = p.port_label)
                OR (cc.backbone_out_instance_id = pi.instance_id AND cc.backbone_out_port_label = p.port_label)
              )
          ) AS used_in_cc
        FROM public.patchpanel_ports p
        LEFT JOIN public.patchpanel_instances pi ON pi.id = p.patchpanel_id
        WHERE p.patchpanel_id = :ppid
        ORDER BY p.row_number, p.row_letter, p.position;
    """), {"ppid": int(pp_id)}).mappings().all()

    ports = []
    for r in rows:
        st = (r["base_status"] or "free").lower()

        # Normalize values to match frontend expectations.
        # IMPORTANT:
        # In this project, a port can be "precabled" (has a peer mapping) but is
        # still selectable/free until a cross-connect actually uses it.
        if st in ("connected", "linked", "precabled"):
            st = "free"

        if st in ("used", "consumed", "busy", "in_use"):
            st = "occupied"

        if bool(r.get("used_in_cc")):
            st = "occupied"
        ports.append({
            "port_label": r["port_label"],
            "status": st,
            "usable": (st != "unavailable"),
            "connected_to": r["connected_to"],
            "peer_instance_id": r.get("peer_instance_id"),
            "peer_port_label": r.get("peer_port_label"),
        })

    return {"ports": ports, "slots": []}
