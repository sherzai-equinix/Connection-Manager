from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session
from typing import Optional, List, Tuple

import crud
from database import get_db
from models import LinkPeerCustomerIn

router = APIRouter(
    prefix="/zside",
    tags=["zside"],
)


# =========================
# Pydantic Models
# =========================

class ZSidePatchpanelCreate(BaseModel):
    # Beispiel: "PP:609:01"
    instance_id: str = Field(..., examples=["PP:609:01"])
    room: str = Field(..., examples=["1A2"])

    rack_unit: Optional[int] = Field(default=None, ge=1, examples=[17])
    rack_label: Optional[str] = Field(default=None, examples=["609"])

    customer_id: int = Field(..., examples=[8])

    cage_no: Optional[str] = Field(default=None, examples=["CAGE-TEST", None])
    panel_type: str = Field(default="customer")
    port_layout: int = Field(..., description="48 / 72 / 96", examples=[48, 72, 96])

    enabled_cassettes: List[str] = Field(default_factory=list, examples=[["1A"], ["1A", "1B"], ["1A", "2A"]])

    class Config:
        extra = "ignore"
        allow_population_by_field_name = True
        fields = {
            "customer_id": {"alias": "customerId"},
            "rack_label": {"alias": "rackLabel"},
            "rack_unit": {"alias": "rackUnit"},
            "cage_no": {"alias": "cageNo"},
            "panel_type": {"alias": "panelType"},
            "port_layout": {"alias": "portLayout"},
            "enabled_cassettes": {"alias": "enabledCassettes"},
        }


class ZSidePatchpanelOut(BaseModel):
    ok: bool
    patchpanel_id: int
    instance_id: str
    total_ports: int


class ZSidePatchpanelListItem(BaseModel):
    id: int
    instance_id: str
    room: str
    rack_label: Optional[str] = None
    rack_unit: Optional[int] = None
    total_ports: Optional[int] = None
    cage_no: Optional[str] = None


class ZSidePortItem(BaseModel):
    id: int
    patchpanel_id: int
    row_number: int
    row_letter: str
    position: int
    port_label: str
    peer_instance_id: str | None = None
    peer_port_label: str | None = None
    connected_to: str | None = None
    status: str | None = None


class CustomerOut(BaseModel):
    id: int
    name: str


class LocationOut(BaseModel):
    id: int
    cage_no: Optional[str] = None


class RackOut(BaseModel):
    id: int
    rack_label: str


# =========================
# ✅ NEW: Onboarding Models
# =========================

class SlotIn(BaseModel):
    slot_code: str
    has_cassette: bool
    trunk_status: str  # missing/installed/tested

    class Config:
        extra = "ignore"
        allow_population_by_field_name = True
        fields = {
            "slot_code": {"alias": "slotCode"},
            "has_cassette": {"alias": "hasCassette"},
            "trunk_status": {"alias": "trunkStatus"},
        }



class ZSideOnboardIn(BaseModel):
    customer_name: str
    customer_code: Optional[str] = None
    comment: Optional[str] = None

    room: str
    has_cage: bool = False
    cage_name: Optional[str] = None

    rack_label: str
    rack_unit: int = Field(..., ge=1)
    pp_label: str
    port_count: int = 48

    selected_port: Optional[str] = None
    slots: List[SlotIn] = []

    class Config:
        extra = "ignore"
        allow_population_by_field_name = True
        fields = {
            "customer_name": {"alias": "customerName"},
            "customer_code": {"alias": "customerCode"},
            "has_cage": {"alias": "hasCage"},
            "cage_name": {"alias": "cageName"},
            "rack_label": {"alias": "rackLabel"},
            "rack_unit": {"alias": "rackUnit"},
            "pp_label": {"alias": "ppLabel"},
            "port_count": {"alias": "portCount"},
            "selected_port": {"alias": "selectedPort"},
        }



# =========================
# ✅ NEW: Existing Onboarding Models + helpers
# =========================

class ZSideOnboardExistingIn(BaseModel):
    room: str
    customer_id: int

    # existing location or create new via has_cage/cage_name
    location_id: Optional[int] = None
    has_cage: bool = False
    cage_name: Optional[str] = None

    # existing rack or create new via rack_label
    rack_id: Optional[int] = None
    rack_label: Optional[str] = None

    rack_unit: int = Field(..., ge=1)
    pp_label: str
    port_count: int = 48

    selected_port: Optional[str] = None
    slots: List[SlotIn] = []

    class Config:
        extra = "ignore"


class EnableCassettesIn(BaseModel):
    patchpanel_id: int
    slot_codes: List[str] = Field(default_factory=list)  # z.B. ["1C","1D"]
    trunk_status: str = "installed"  # optional info only


def _pp_format(pp_label: str) -> str:
    v = (pp_label or "").strip()
    if v.isdigit():
        return str(int(v)).zfill(2)
    return v


def _build_instance_id(rack_label: str, pp_label: str) -> str:
    r = (rack_label or "").strip()
    p = _pp_format(pp_label)
    return f"PP:{r}:{p}"


# =========================
# Ports
# =========================

@router.get("/patchpanel-ports", response_model=List[ZSidePortItem])
def get_patchpanel_ports(patchpanel_id: int, db: Session = Depends(get_db)):
    return crud.list_patchpanel_ports(db, patchpanel_id)


@router.get("/ports", response_model=List[ZSidePortItem])
def get_ports_alias(patchpanel_id: int, db: Session = Depends(get_db)):
    return crud.list_patchpanel_ports(db, patchpanel_id)


# =========================
# Patchpanels
# =========================

@router.post("/patchpanels", response_model=ZSidePatchpanelOut)
def create_patchpanel(payload: ZSidePatchpanelCreate, db: Session = Depends(get_db)):
    try:
        pp_number = (payload.instance_id or "").strip().split(":")[-1]  # always last part of instance_id

        res = crud.create_zside_patchpanel(
            db,
            instance_id=payload.instance_id,
            room=payload.room,
            rack_unit=payload.rack_unit,
            rack_label=payload.rack_label,
            customer_id=payload.customer_id,
            cage_no=payload.cage_no,
            panel_type=payload.panel_type,
            port_layout=payload.port_layout,
            enabled_cassettes=payload.enabled_cassettes,
            pp_number=pp_number,
        )

        return {"ok": True, **res}

    except Exception as e:
        msg = str(e)
        if "patchpanel_instances_instance_id_key" in msg or "duplicate key" in msg.lower():
            raise HTTPException(status_code=409, detail="instance_id already exists")
        if "uq_pp_port" in msg:
            raise HTTPException(status_code=409, detail="ports already exist for this patchpanel")
        raise HTTPException(status_code=400, detail=msg)


@router.get("/patchpanels", response_model=List[ZSidePatchpanelListItem])
def list_patchpanels(
    room: str,
    customer_id: int,
    rack_label: str,
    cage_no: Optional[str] = None,
    db: Session = Depends(get_db),
):
    try:
        rows = crud.list_zside_patchpanels(
            db,
            room=room,
            customer_id=customer_id,
            rack_label=rack_label,
            cage_no=cage_no,
        )
        return rows
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/racks/{rack_id}/patchpanels", response_model=List[ZSidePatchpanelListItem])
def list_patchpanels_by_rack(
    rack_id: int,
    customer_id: int,
    db: Session = Depends(get_db),
):
    try:
        rows = crud.list_zside_patchpanels_by_rack_id(db, rack_id=rack_id, customer_id=customer_id)
        return rows
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# =========================
# ✅ NEW: Onboarding Endpoint (FIX) — NEW CUSTOMER
# =========================

@router.post("/onboard")
def onboard_customer(payload: ZSideOnboardIn, db: Session = Depends(get_db)):
    """
    ✅ FIX: Onboarding läuft ab jetzt über crud.onboard_zside_customer()
    und schreibt patchpanel_instances korrekt:
    - instance_id = PP:<rack>:<pp>
    - rack_label gesetzt
    - rack_unit = RU (1..)
    - cage_no gesetzt
    - customer_id gesetzt
    - customer_rack_id gesetzt
    """
    try:
        res = crud.onboard_zside_customer(db, payload.dict())
        return {"message": "Z-Side onboarded", **res}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# =========================
# ✅ NEW: Onboarding Existing Customer
# =========================

@router.post("/onboard-existing")
def onboard_existing_customer(payload: ZSideOnboardExistingIn, db: Session = Depends(get_db)):
    """
    Bestehender Kunde:
    - location_id optional: sonst upsert customer_locations (room+customer_id+cage_no)
    - rack_id optional: sonst upsert customer_racks (location_id+rack_label)
    - patchpanel_instances via crud.create_zside_patchpanel()
    - danach patchpanel_instances.customer_rack_id setzen
    """
    try:
        room = (payload.room or "").strip()
        if not room:
            raise HTTPException(status_code=400, detail="room fehlt")

        customer_id = int(payload.customer_id)

        # 1) LOCATION bestimmen (existing oder new)
        cage_no = None
        location_id = payload.location_id

        if location_id:
            row = db.execute(text("""
                SELECT id, room, customer_id, cage_no
                FROM customer_locations
                WHERE id = :id
                LIMIT 1
            """), {"id": location_id}).mappings().first()

            if not row:
                raise HTTPException(status_code=404, detail="location_id not found")
            if int(row["customer_id"]) != customer_id:
                raise HTTPException(status_code=400, detail="location_id gehört nicht zu customer_id")
            if str(row["room"]) != room:
                raise HTTPException(status_code=400, detail="location_id room mismatch")

            cage_no = row["cage_no"]

        else:
            # create/lookup location
            if payload.has_cage:
                cage_no = (payload.cage_name or "").strip() or None
                if not cage_no:
                    raise HTTPException(status_code=400, detail="cage_name fehlt (has_cage=true)")
            else:
                cage_no = None

            loc = db.execute(text("""
                SELECT id
                FROM customer_locations
                WHERE room = :room AND customer_id = :cid AND
                      ( (cage_no IS NULL AND :cage_no IS NULL) OR cage_no = :cage_no )
                LIMIT 1
            """), {"room": room, "cid": customer_id, "cage_no": cage_no}).mappings().first()

            if loc:
                location_id = int(loc["id"])
            else:
                newloc = db.execute(text("""
                    INSERT INTO customer_locations (room, customer_id, cage_no)
                    VALUES (:room, :cid, :cage_no)
                    RETURNING id
                """), {"room": room, "cid": customer_id, "cage_no": cage_no}).mappings().first()
                db.commit()
                location_id = int(newloc["id"])

        # 2) RACK bestimmen (existing oder new)
        rack_id = payload.rack_id
        rack_label = None

        if rack_id:
            r = db.execute(text("""
                SELECT id, location_id, rack_label
                FROM customer_racks
                WHERE id = :id
                LIMIT 1
            """), {"id": rack_id}).mappings().first()
            if not r:
                raise HTTPException(status_code=404, detail="rack_id not found")
            if int(r["location_id"]) != int(location_id):
                raise HTTPException(status_code=400, detail="rack_id gehört nicht zu location_id")
            rack_label = r["rack_label"]

        else:
            rack_label = (payload.rack_label or "").strip()
            if not rack_label:
                raise HTTPException(status_code=400, detail="rack_label fehlt (für neues Rack)")

            r2 = db.execute(text("""
                SELECT id
                FROM customer_racks
                WHERE location_id = :lid AND rack_label = :rl
                LIMIT 1
            """), {"lid": location_id, "rl": rack_label}).mappings().first()

            if r2:
                rack_id = int(r2["id"])
            else:
                nr = db.execute(text("""
                    INSERT INTO customer_racks (location_id, rack_label)
                    VALUES (:lid, :rl)
                    RETURNING id
                """), {"lid": location_id, "rl": rack_label}).mappings().first()
                db.commit()
                rack_id = int(nr["id"])

        # 3) PATCHPANEL anlegen (über existing crud)
        pp_label = (payload.pp_label or "").strip()
        if not pp_label:
            raise HTTPException(status_code=400, detail="pp_label fehlt")

        instance_id = _build_instance_id(str(rack_label), pp_label)

        enabled_cassettes: List[str] = []
        for s in (payload.slots or []):
            if s.has_cassette and s.slot_code:
                enabled_cassettes.append(s.slot_code)

        pp_number = instance_id.split(":")[-1]

        res = crud.create_zside_patchpanel(
            db,
            instance_id=instance_id,
            room=room,
            rack_unit=int(payload.rack_unit),
            rack_label=str(rack_label),
            customer_id=customer_id,
            cage_no=cage_no,
            panel_type="customer",
            port_layout=int(payload.port_count),
            enabled_cassettes=enabled_cassettes,
            pp_number=pp_number,
        )


        # 4) customer_rack_id setzen
        db.execute(text("""
            UPDATE patchpanel_instances
            SET customer_rack_id = :rid
            WHERE id = :ppid
        """), {"rid": rack_id, "ppid": int(res["patchpanel_id"])})
        db.commit()

        return {"message": "Z-Side existing customer onboarded", **res}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# =========================
# ✅ FIX: Enable Cassettes (NO enabled_cassettes column needed)
# =========================

@router.post("/patchpanels/enable-cassettes")
def enable_customer_cassettes(payload: EnableCassettesIn, db: Session = Depends(get_db)):
    """
    Freigabe zusätzlicher Kassetten für ein EXISTIERENDES Customer-PP.

    ✅ WICHTIG:
    - Deine DB hat KEINE Spalte 'enabled_cassettes' in patchpanel_instances.
    - Daher: wir updaten NUR patchpanel_ports.status auf 'free'
      für die gewünschten slot_codes (z.B. 1C -> 1C1..1C6)
    """
    try:
        pid = int(payload.patchpanel_id)
        slots = sorted({(s or "").strip().upper() for s in (payload.slot_codes or []) if (s or "").strip()})

        if not slots:
            raise HTTPException(status_code=400, detail="slot_codes fehlt")

        # check patchpanel exists
        row = db.execute(
            text("SELECT id FROM patchpanel_instances WHERE id = :pid LIMIT 1"),
            {"pid": pid},
        ).mappings().first()

        if not row:
            raise HTTPException(status_code=404, detail="patchpanel_id not found")

        # robust slot match:
        # port_label like "1C1" or "12A6" => slot is regex '^[0-9]+[A-D]'
        result = db.execute(text("""
            UPDATE patchpanel_ports
            SET status = 'free'
            WHERE patchpanel_id = :pid
              AND substring(port_label from '^[0-9]+[A-D]') = ANY(:slots)
              AND (status IS NULL OR lower(status) IN ('', 'unavailable'));
        """), {"pid": pid, "slots": slots})

        db.commit()

        return {
            "ok": True,
            "patchpanel_id": pid,
            "enabled_now": slots,
            "ports_updated": int(result.rowcount or 0),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# =========================
# Linking (Peer <-> Customer)
# =========================

@router.post("/link-peer-customer")
def link_peer_customer(payload: LinkPeerCustomerIn, db: Session = Depends(get_db)):
    try:
        return crud.link_peer_to_customer_port(
            db,
            peer_instance_id=payload.peer_instance_id,
            peer_port_label=payload.peer_port_label,
            customer_patchpanel_id=payload.customer_patchpanel_id,
            customer_port_label=payload.customer_port_label,
        )
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=str(e))
        if "not free" in msg or "already linked" in msg or "unique" in msg or "linked" in msg:
            raise HTTPException(status_code=409, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))


class LinkManualIn(BaseModel):
    peer_port: str = Field(..., min_length=3)
    customer_port: str = Field(..., min_length=3)


def _parse_port_ref(value: str) -> Tuple[str, str]:
    v = (value or "").strip()
    if ":" not in v:
        raise ValueError("Port format muss '<instance_id>:<port_label>' sein")
    instance_id, port_label = v.rsplit(":", 1)
    instance_id = instance_id.strip()
    port_label = port_label.strip()
    if not instance_id or not port_label:
        raise ValueError("Port format muss '<instance_id>:<port_label>' sein")
    return instance_id, port_label


@router.post("/link-manual")
def link_manual(payload: LinkManualIn, db: Session = Depends(get_db)):
    try:
        peer_instance_id, peer_port_label = _parse_port_ref(payload.peer_port)
        customer_instance_id, customer_port_label = _parse_port_ref(payload.customer_port)

        row = db.execute(
            text("""
                SELECT id
                FROM patchpanel_instances
                WHERE instance_id = :iid
                LIMIT 1
            """),
            {"iid": customer_instance_id},
        ).mappings().first()

        if not row:
            raise HTTPException(status_code=404, detail="customer patchpanel instance_id not found")

        customer_patchpanel_id = int(row["id"])

        return crud.link_peer_to_customer_port(
            db,
            peer_instance_id=peer_instance_id,
            peer_port_label=peer_port_label,
            customer_patchpanel_id=customer_patchpanel_id,
            customer_port_label=customer_port_label,
        )

    except HTTPException:
        raise
    except Exception as e:
        msg = str(e).lower()
        if "not found" in msg:
            raise HTTPException(status_code=404, detail=str(e))
        if "not free" in msg or "already linked" in msg or "unique" in msg or "linked" in msg:
            raise HTTPException(status_code=409, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))


# =========================
# Lookups (Rooms / Customers / Locations / Racks)
# =========================

@router.get("/rooms")
def zside_rooms(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT DISTINCT room
        FROM customer_locations
        ORDER BY room;
    """)).all()
    return [r[0] for r in rows]


@router.get("/customers", response_model=List[CustomerOut])
def zside_customers(room: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT DISTINCT c.id, c.name
        FROM customer_locations cl
        JOIN customers c ON c.id = cl.customer_id
        WHERE cl.room = :room
        ORDER BY c.name;
    """), {"room": room}).mappings().all()

    return [{"id": int(r["id"]), "name": r["name"]} for r in rows]


@router.get("/locations", response_model=List[LocationOut])
def zside_locations(room: str, customer_id: int, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT id, cage_no
        FROM customer_locations
        WHERE room = :room AND customer_id = :customer_id
        ORDER BY cage_no NULLS FIRST, id;
    """), {"room": room, "customer_id": customer_id}).mappings().all()
    return [dict(r) for r in rows]


@router.get("/racks", response_model=List[RackOut])
def zside_racks(location_id: int, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT MIN(id) AS id, rack_label
        FROM customer_racks
        WHERE location_id = :location_id
        GROUP BY rack_label
        ORDER BY rack_label;
    """), {"location_id": location_id}).mappings().all()
    return [dict(r) for r in rows]
