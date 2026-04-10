from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from database import get_db
from models import Device, Connection

router = APIRouter(tags=["topology"])


@router.get("/topology")
def get_topology(
    room: str | None = Query(default=None, description="Filter: nur Devices in diesem Room"),
    device_type: str | None = Query(default=None, alias="type", description="Filter: nur Devices von diesem Type"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    # 1) Devices (optional gefiltert)
    dq = db.query(Device)
    if room:
        dq = dq.filter(Device.room == room)
    if device_type:
        dq = dq.filter(Device.type == device_type)

    devices = dq.order_by(Device.id).all()
    device_ids = [d.id for d in devices]

    # 2) Connections (bei Filter: nur Edges innerhalb des Subgraphs)
    cq = db.query(Connection)
    if room or device_type:
        if not device_ids:
            return {
                "nodes": [],
                "edges": [],
                "meta": {
                    "node_count": 0,
                    "edge_count": 0,
                    "filters": {"room": room, "type": device_type},
                },
                "adjacency": {},
            }

        cq = cq.filter(
            Connection.source_id.in_(device_ids),
            Connection.target_id.in_(device_ids),
        )

    connections = cq.order_by(Connection.id).all()

    # 3) Frontend-friendly Format
    nodes = [
        {
            "id": d.id,
            "label": d.name,
            "room": d.room,
            "type": d.type,
            "ip": getattr(d, "ip", None),
        }
        for d in devices
    ]

    edges = [
        {
            "id": c.id,
            "source": c.source_id,
            "target": c.target_id,
            "label": c.link_type,
            "notes": c.notes,
        }
        for c in connections
    ]

    # 4) adjacency fürs Sidepanel
    adjacency: dict[str, list[dict[str, Any]]] = {}
    for e in edges:
        adjacency.setdefault(str(e["source"]), []).append(
            {"to": e["target"], "type": e["label"], "edge_id": e["id"]}
        )

    return {
        "nodes": nodes,
        "edges": edges,
        "meta": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "filters": {"room": room, "type": device_type},
        },
        "adjacency": adjacency,
    }