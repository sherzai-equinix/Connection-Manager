from __future__ import annotations

from sqlalchemy.orm import Session
from sqlalchemy import text, func
from sqlalchemy.exc import IntegrityError

from models import (
    Device, Connection, DeviceCreate, ConnectionCreate,
    PreCabledLink, SwitchInfo, RoomOverview
)

# ========================
# Devices
# ========================

def create_device(db: Session, payload: DeviceCreate) -> Device:
    device = Device(**payload.dict())
    db.add(device)
    db.commit()
    db.refresh(device)
    return device

def get_device(db: Session, device_id: int) -> Device | None:
    return db.query(Device).filter(Device.id == device_id).first()

def get_device_by_name(db: Session, name: str) -> Device | None:
    return db.query(Device).filter(Device.name == name).first()

def list_devices(db: Session, room: str | None = None, type_: str | None = None) -> list[Device]:
    q = db.query(Device)
    if room:
        q = q.filter(Device.room == room)
    if type_:
        q = q.filter(Device.type == type_)
    return q.order_by(Device.name).all()

def delete_device(db: Session, device_id: int) -> bool:
    d = get_device(db, device_id)
    if not d:
        return False
    db.delete(d)
    db.commit()
    return True


# ========================
# Connections (Device↔Device)
# ========================

def create_connection(db: Session, payload: ConnectionCreate) -> Connection:
    conn = Connection(**payload.dict())
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return conn

def list_connections(db: Session, device_id: int | None = None) -> list[Connection]:
    q = db.query(Connection)
    if device_id:
        q = q.filter((Connection.source_id == device_id) | (Connection.target_id == device_id))
    return q.all()

def delete_connection(db: Session, connection_id: int) -> bool:
    c = db.query(Connection).filter(Connection.id == connection_id).first()
    if not c:
        return False
    db.delete(c)
    db.commit()
    return True


# ========================
# RACK VIEW CRUD FUNCTIONS
# ========================

def get_all_rooms(db: Session) -> list[str]:
    rooms = db.query(PreCabledLink.room).distinct().order_by(PreCabledLink.room).all()
    return [room[0] for room in rooms]

def get_room_overview(db: Session, room_name: str) -> RoomOverview:
    switches_query = db.query(
        PreCabledLink.switch_name,
        func.count().label("used_ports"),
        func.max(PreCabledLink.patchpanel_id).label("patch_panel")
    ).filter(
        PreCabledLink.room == room_name
    ).group_by(
        PreCabledLink.switch_name
    ).order_by(
        PreCabledLink.switch_name
    ).all()

    switch_info_list: list[SwitchInfo] = []
    for switch in switches_query:
        total_ports = 48
        used_ports = switch.used_ports
        utilization = round((used_ports / total_ports) * 100, 1)

        main_patch_panel = db.query(PreCabledLink.patchpanel_id).filter(
            PreCabledLink.room == room_name,
            PreCabledLink.switch_name == switch.switch_name
        ).first()

        patch_panel = main_patch_panel.patchpanel_id if main_patch_panel else "Unknown"

        switch_info_list.append(SwitchInfo(
            name=switch.switch_name,
            total_ports=total_ports,
            used_ports=used_ports,
            patch_panel=patch_panel,
            room=room_name,
            utilization_percent=utilization
        ))

    total_connections = sum(s.used_ports for s in switch_info_list)
    total_switches = len(switch_info_list)
    total_utilization = round((total_connections / (total_switches * 48)) * 100, 1) if total_switches > 0 else 0

    return RoomOverview(
        room=room_name,
        total_switches=total_switches,
        total_connections=total_connections,
        total_utilization=total_utilization,
        switches=switch_info_list
    )

def get_switch_details(db: Session, switch_name: str) -> list[PreCabledLink]:
    return db.query(PreCabledLink).filter(
        PreCabledLink.switch_name == switch_name
    ).order_by(
        PreCabledLink.switch_port
    ).all()

def get_precabling_stats(db: Session) -> dict:
    stats = db.query(
        func.count().label("total_connections"),
        func.count(func.distinct(PreCabledLink.room)).label("total_rooms"),
        func.count(func.distinct(PreCabledLink.switch_name)).label("total_switches"),
        func.count(func.distinct(PreCabledLink.patchpanel_id)).label("total_patchpanels")
    ).first()

    return {
        "total_connections": stats.total_connections,
        "total_rooms": stats.total_rooms,
        "total_switches": stats.total_switches,
        "total_patchpanels": stats.total_patchpanels
    }

def get_switches_in_room(db: Session, room_name: str) -> list[str]:
    switches = db.query(
        func.distinct(PreCabledLink.switch_name)
    ).filter(
        PreCabledLink.room == room_name
    ).order_by(
        PreCabledLink.switch_name
    ).all()
    return [switch[0] for switch in switches]


# ========================
# Z-SIDE: Helpers
# ========================

def _norm_str(v: str | None) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s != "" else None

def _infer_rack_label_from_instance_id(instance_id: str) -> str | None:
    """
    Erwartet customer PP Format: PP:<rack>:<ppno>
    Beispiel: PP:401:67 => rack_label = "401"
    """
    iid = (instance_id or "").strip()
    if iid.startswith("PP:") and iid.count(":") >= 2:
        parts = iid.split(":")
        rack = parts[1].strip() if len(parts) > 1 else ""
        return rack or None
    return None


# ========================
# Z-SIDE: Patchpanel + Ports
# ========================

def generate_ports(layout: int, enabled_cassettes: list[str] | None = None) -> list[dict]:
    """
    layout: 48 / 72 / 96
    - 48 => blocks 1..2
    - 72 => blocks 1..3
    - 96 => blocks 1..4

    Jede Kassette = "<block><letter>" z.B. 1A, 1B, 2D
    Jeder Kassette hat 6 Ports => 1A1..1A6

    enabled_cassettes:
      - wenn leer -> alles free (backwards compatible)
      - sonst: nur diese = free, rest = unavailable
    """
    if layout not in (48, 72, 96):
        raise ValueError("layout must be 48, 72, or 96")

    blocks = layout // 24
    letters = ["A", "B", "C", "D"]

    enabled_set = {str(x).strip().upper() for x in (enabled_cassettes or []) if str(x).strip()}

    # wenn nix gesetzt -> alles frei (wie früher)
    if not enabled_set:
        enabled_set = {f"{n}{L}" for n in range(1, blocks + 1) for L in letters}

    ports: list[dict] = []
    for block_no in range(1, blocks + 1):
        for row_letter in letters:
            cassette_id = f"{block_no}{row_letter}"
            st = "free" if cassette_id in enabled_set else "unavailable"

            for pos in range(1, 7):
                ports.append({
                    "row_number": block_no,
                    "row_letter": row_letter,
                    "position": pos,
                    "port_label": f"{block_no}{row_letter}{pos}",
                    "status": st,
                })
    return ports


def _ensure_location_and_rack(
    db: Session,
    *,
    room: str,
    customer_id: int,
    cage_no: str | None,
    rack_label: str,
) -> tuple[int, int]:
    """
    Sorgt dafür, dass customer_locations + customer_racks existieren.
    Gibt (location_id, rack_id) zurück.
    """
    cage_no = _norm_str(cage_no)

    loc = db.execute(text("""
        SELECT id
        FROM customer_locations
        WHERE room = :room
          AND customer_id = :customer_id
          AND (
                (:cage_no IS NULL AND NULLIF(cage_no,'') IS NULL)
             OR NULLIF(cage_no,'') = :cage_no
          )
        ORDER BY id
        LIMIT 1
    """), {"room": room, "customer_id": customer_id, "cage_no": cage_no}).mappings().first()

    if not loc:
        loc = db.execute(text("""
            INSERT INTO customer_locations (room, customer_id, cage_no)
            VALUES (:room, :customer_id, :cage_no)
            RETURNING id
        """), {"room": room, "customer_id": customer_id, "cage_no": cage_no}).mappings().first()

    location_id = int(loc["id"])

    rack = db.execute(text("""
        SELECT id
        FROM customer_racks
        WHERE location_id = :location_id
          AND rack_label = :rack_label
        ORDER BY id
        LIMIT 1
    """), {"location_id": location_id, "rack_label": str(rack_label)}).mappings().first()

    if not rack:
        rack = db.execute(text("""
            INSERT INTO customer_racks (location_id, rack_label)
            VALUES (:location_id, :rack_label)
            RETURNING id
        """), {"location_id": location_id, "rack_label": str(rack_label)}).mappings().first()

    rack_id = int(rack["id"])
    return location_id, rack_id


def create_zside_patchpanel(
    db: Session,
    *,
    instance_id: str,
    room: str,
    rack_unit: int | None,
    rack_label: str | None,
    customer_id: int,
    cage_no: str | None,
    panel_type: str,
    port_layout: int,
    enabled_cassettes: list[str] | None = None,
    pp_number: str | None = None,  # ✅ NEU
) -> dict:
    """
    Wichtigster Fix:
    - rack_label wird IMMER gesetzt (notfalls aus instance_id oder aus falsch gemapptem rack_unit)
    - rack_unit default = 1 (wenn Onboarding kein RU hat)
    - location/rack werden auto angelegt
    - customer_rack_id wird gesetzt
    """
    instance_id = (instance_id or "").strip()
    room = (room or "").strip()

    if not instance_id or not room:
        raise ValueError("instance_id and room are required")

    # Normalize rack_unit
    ru = int(rack_unit) if (rack_unit is not None and int(rack_unit) >= 1) else 1

    # Normalize rack_label
    rl = _norm_str(rack_label)

    # Typischer Bug bei dir: rack_label NULL und rack_unit enthält Rack (z.B. 401)
    # => dann nehmen wir rack_unit als rack_label und ru = 1
    if rl is None and rack_unit is not None:
        try:
            tmp = int(rack_unit)
            if tmp >= 100:  # Rack-Nummern sind bei dir oft 3-stellig
                rl = str(tmp)
                ru = 1
        except Exception:
            pass

    # Wenn immer noch kein rack_label -> aus instance_id (PP:<rack>:...)
    if rl is None:
        rl = _infer_rack_label_from_instance_id(instance_id)

    if rl is None:
        raise ValueError("rack_label missing (could not infer from instance_id)")

    # cage_no normalisieren
    pp_number = _norm_str(pp_number)
    # falls pp_number nicht geschickt wurde: aus instance_id ziehen (PP:<rack>:<pp>)
    if pp_number is None and ":" in instance_id:
        cand = instance_id.split(":")[-1].strip()
        if cand.isdigit() and len(cand) >= 6:
            pp_number = cand

    cage_no = _norm_str(cage_no)

    ports = generate_ports(port_layout, enabled_cassettes=enabled_cassettes)

    try:
        # location + rack sicherstellen
        _location_id, rack_id = _ensure_location_and_rack(
            db,
            room=room,
            customer_id=int(customer_id),
            cage_no=cage_no,
            rack_label=str(rl),
        )

        row = db.execute(text("""
            INSERT INTO patchpanel_instances(
            instance_id, room, rack_unit, panel_type, total_ports,
            customer_id, cage_no, rack_label, customer_rack_id,
            pp_number
            )
            VALUES (
            :instance_id, :room, :rack_unit, :panel_type, :total_ports,
            :customer_id, :cage_no, :rack_label, :customer_rack_id,
            :pp_number
            )
            RETURNING id, instance_id;
        """), {
            "instance_id": instance_id,
            "room": room,
            "rack_unit": ru,
            "panel_type": panel_type or "customer",
            "total_ports": int(port_layout),
            "customer_id": int(customer_id),
            "cage_no": cage_no,
            "rack_label": str(rl),
            "customer_rack_id": int(rack_id),
            "pp_number": pp_number,
        }).mappings().first()


        if not row:
            raise RuntimeError("patchpanel_instances insert failed")

        patchpanel_id = int(row["id"])

        db.execute(text("""
            INSERT INTO patchpanel_ports(
              patchpanel_id, row_number, row_letter, position, port_label, status
            )
            VALUES (
              :patchpanel_id, :row_number, :row_letter, :position, :port_label, :status
            )
        """), [
            {
                "patchpanel_id": patchpanel_id,
                "row_number": p["row_number"],
                "row_letter": p["row_letter"],
                "position": p["position"],
                "port_label": p["port_label"],
                "status": p["status"],
            }
            for p in ports
        ])

        db.commit()

        return {
            "patchpanel_id": patchpanel_id,
            "instance_id": row["instance_id"],
            "total_ports": int(port_layout),
        }

    except Exception:
        db.rollback()
        raise


def list_patchpanel_ports(db: Session, patchpanel_id: int) -> list[dict]:
    rows = db.execute(text("""
        SELECT id, patchpanel_id, row_number, row_letter, position, port_label,
               peer_instance_id, peer_port_label, connected_to, status
        FROM patchpanel_ports
        WHERE patchpanel_id = :patchpanel_id
        ORDER BY row_number, row_letter, position;
    """), {"patchpanel_id": patchpanel_id}).mappings().all()
    return [dict(r) for r in rows]


def list_zside_patchpanels(
    db: Session,
    *,
    room: str,
    customer_id: int,
    rack_label: str,
    cage_no: str | None,
) -> list[dict]:
    """
    Ultra-robust Listing:
    - rack_label: nutzt COALESCE(rack_label, split_part(instance_id,':',2))
    - customer_id: erlaubt ALT rows (customer_id IS NULL) wenn instance_id wie PP:<rack>:... aussieht
    - cage: nutzt COALESCE(pp.cage_no, location.cage_no)
    """
    cage_no = _norm_str(cage_no)
    rack_label = str(rack_label).strip()

    sql = """
      SELECT
        p.id, p.instance_id, p.room,
        COALESCE(NULLIF(p.rack_label,''), split_part(p.instance_id,':',2)) AS rack_label,
        p.rack_unit, p.total_ports,
        COALESCE(NULLIF(p.cage_no,''), NULLIF(cl.cage_no,'')) AS cage_no
      FROM patchpanel_instances p
      LEFT JOIN customer_racks cr ON cr.id = p.customer_rack_id
      LEFT JOIN customer_locations cl ON cl.id = cr.location_id
      WHERE p.room = :room
        AND COALESCE(NULLIF(p.rack_label,''), split_part(p.instance_id,':',2)) = :rack_label
        AND (
              p.customer_id = :customer_id
           OR (p.customer_id IS NULL AND p.instance_id LIKE 'PP:%:%')
        )
        AND (
              (:cage_no IS NULL AND NULLIF(COALESCE(p.cage_no, cl.cage_no), '') IS NULL)
           OR NULLIF(COALESCE(p.cage_no, cl.cage_no), '') = :cage_no
        )
      ORDER BY p.rack_unit NULLS LAST, p.instance_id;
    """

    rows = db.execute(text(sql), {
        "room": room,
        "customer_id": int(customer_id),
        "rack_label": rack_label,
        "cage_no": cage_no,
    }).mappings().all()

    return [dict(r) for r in rows]


def list_zside_patchpanels_by_rack_id(db: Session, *, rack_id: int, customer_id: int) -> list[dict]:
    rows = db.execute(text("""
        SELECT
          p.id, p.instance_id, p.room,
          COALESCE(NULLIF(p.rack_label,''), split_part(p.instance_id,':',2)) AS rack_label,
          p.rack_unit, p.total_ports,
          COALESCE(NULLIF(p.cage_no,''), NULLIF(cl.cage_no,'')) AS cage_no
        FROM patchpanel_instances p
        LEFT JOIN customer_racks cr ON cr.id = p.customer_rack_id
        LEFT JOIN customer_locations cl ON cl.id = cr.location_id
        WHERE p.customer_rack_id = :rack_id
          AND (
                p.customer_id = :customer_id
             OR (p.customer_id IS NULL AND p.instance_id LIKE 'PP:%:%')
          )
        ORDER BY p.rack_unit NULLS LAST, p.instance_id;
    """), {"rack_id": int(rack_id), "customer_id": int(customer_id)}).mappings().all()

    return [dict(r) for r in rows]


# ========================
# Step4: Link Peer -> Customer
# ========================

def link_peer_to_customer_port(
    db: Session,
    *,
    peer_instance_id: str,
    peer_port_label: str,
    customer_patchpanel_id: int,
    customer_port_label: str,
) -> dict:
    """
    Step4:
    - schreibt Verbindung in pp_connections (audit/history)
    - setzt patchpanel_ports.status='occupied' + connected_to auf beiden Seiten
    - überschreibt NICHT peer_instance_id/peer_port_label backbone mapping
    """
    try:
        customer = db.execute(text("""
            SELECT id, instance_id
            FROM patchpanel_instances
            WHERE id = :pid
        """), {"pid": int(customer_patchpanel_id)}).mappings().first()

        if not customer:
            raise ValueError("customer_patchpanel_id not found")

        customer_instance_id = customer["instance_id"]

        peer_pp = db.execute(text("""
            SELECT id, instance_id
            FROM patchpanel_instances
            WHERE instance_id = :iid
        """), {"iid": peer_instance_id}).mappings().first()

        if not peer_pp:
            raise ValueError("peer_instance_id not found")

        peer_patchpanel_id = int(peer_pp["id"])

        peer_port = db.execute(text("""
            SELECT id, status, connected_to
            FROM patchpanel_ports
            WHERE patchpanel_id = :ppid AND port_label = :plabel
            FOR UPDATE
        """), {"ppid": peer_patchpanel_id, "plabel": peer_port_label}).mappings().first()

        if not peer_port:
            raise ValueError("peer port not found")

        cust_port = db.execute(text("""
            SELECT id, status, connected_to
            FROM patchpanel_ports
            WHERE patchpanel_id = :ppid AND port_label = :plabel
            FOR UPDATE
        """), {"ppid": int(customer_patchpanel_id), "plabel": customer_port_label}).mappings().first()

        if not cust_port:
            raise ValueError("customer port not found")

        # Frei nur wenn status == free (unavailable darf NICHT)
        def is_free(p: dict) -> bool:
            st = (p.get("status") or "").lower()
            return (st == "free") and (p.get("connected_to") is None)

        if not is_free(peer_port):
            raise ValueError("peer port is not free")

        if not is_free(cust_port):
            raise ValueError("customer port is not free")

        peer_connected_to = f"{customer_instance_id}:{customer_port_label}"
        cust_connected_to = f"{peer_instance_id}:{peer_port_label}"

        # 1) Audit in pp_connections (Unique schützt doppelt)
        try:
            row = db.execute(text("""
                INSERT INTO pp_connections (peer_instance_id, peer_port_label, customer_patchpanel_id, customer_port_label)
                VALUES (:piid, :ppl, :cpid, :cpl)
                RETURNING id
            """), {
                "piid": peer_instance_id,
                "ppl": peer_port_label,
                "cpid": int(customer_patchpanel_id),
                "cpl": customer_port_label,
            }).mappings().first()

            pp_conn_id = int(row["id"]) if row and "id" in row else None

        except IntegrityError:
            db.rollback()
            raise ValueError("port already linked (pp_connections unique constraint)")

        db.execute(text("""
            UPDATE patchpanel_ports
            SET connected_to = :connected_to,
                status = 'occupied',
                updated_at = now()
            WHERE id = :id
        """), {"id": int(peer_port["id"]), "connected_to": peer_connected_to})

        db.execute(text("""
            UPDATE patchpanel_ports
            SET connected_to = :connected_to,
                status = 'occupied',
                updated_at = now()
            WHERE id = :id
        """), {"id": int(cust_port["id"]), "connected_to": cust_connected_to})

        db.commit()

        return {
            "ok": True,
            "pp_connection_id": pp_conn_id,
            "peer": {
                "instance_id": peer_instance_id,
                "port_label": peer_port_label,
                "connected_to": peer_connected_to
            },
            "customer": {
                "patchpanel_id": int(customer_patchpanel_id),
                "instance_id": customer_instance_id,
                "port_label": customer_port_label,
                "connected_to": cust_connected_to
            }
        }

    except Exception:
        db.rollback()
        raise

def _norm_cage(v: str | None) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s if s else None

def onboard_zside_customer(db: Session, payload: dict) -> dict:
    """
    Creates:
    - customers
    - customer_locations (room + cage_no)
    - customer_racks (location_id + rack_label)
    - patchpanel_instances + patchpanel_ports
    """
    customer_name = (payload.get("customer_name") or "").strip()
    customer_code = payload.get("customer_code")
    comment = payload.get("comment")

    room = (payload.get("room") or "").strip()
    has_cage = bool(payload.get("has_cage"))
    cage_name = _norm_cage(payload.get("cage_name")) if has_cage else None

    rack_label = (payload.get("rack_label") or "").strip()
    rack_unit = int(payload.get("rack_unit") or 0)
    pp_label = (payload.get("pp_label") or "").strip()
    port_count = int(payload.get("port_count") or 0)

    if not customer_name:
        raise ValueError("customer_name missing")
    if not room:
        raise ValueError("room missing")
    if has_cage and not cage_name:
        raise ValueError("cage_name missing")
    if not rack_label:
        raise ValueError("rack_label missing")
    if rack_unit < 1:
        raise ValueError("rack_unit must be >= 1")
    if not pp_label:
        raise ValueError("pp_label missing")
    if port_count not in (48, 72, 96):
        raise ValueError("port_count must be 48/72/96")

    # enabled cassettes from slots
    enabled_cassettes = []
    for s in (payload.get("slots") or []):
        try:
            slot_code = str(s.get("slot_code") or "").strip().upper()
            has_cassette = bool(s.get("has_cassette"))
            if slot_code and has_cassette:
                enabled_cassettes.append(slot_code)
        except Exception:
            continue

    # 1) customer create
    # try insert with optional columns; fallback if columns don't exist
    try:
        row = db.execute(text("""
            INSERT INTO customers (name, code, comment)
            VALUES (:name, :code, :comment)
            RETURNING id;
        """), {"name": customer_name, "code": customer_code, "comment": comment}).mappings().first()
    except Exception:
        db.rollback()
        row = db.execute(text("""
            INSERT INTO customers (name)
            VALUES (:name)
            RETURNING id;
        """), {"name": customer_name}).mappings().first()

    customer_id = int(row["id"])

    # 2) location upsert (room + cage)
    loc = db.execute(text("""
        SELECT id
        FROM customer_locations
        WHERE customer_id = :cid
          AND room = :room
          AND (
            (:cage IS NULL AND NULLIF(cage_no,'') IS NULL)
            OR NULLIF(cage_no,'') = :cage
          )
        ORDER BY id
        LIMIT 1;
    """), {"cid": customer_id, "room": room, "cage": cage_name}).mappings().first()

    if loc:
        location_id = int(loc["id"])
    else:
        loc2 = db.execute(text("""
            INSERT INTO customer_locations (customer_id, room, cage_no)
            VALUES (:cid, :room, :cage)
            RETURNING id;
        """), {"cid": customer_id, "room": room, "cage": cage_name}).mappings().first()
        location_id = int(loc2["id"])

    # 3) rack upsert
    rk = db.execute(text("""
        SELECT id
        FROM customer_racks
        WHERE location_id = :lid AND rack_label = :rack
        ORDER BY id
        LIMIT 1;
    """), {"lid": location_id, "rack": rack_label}).mappings().first()

    if rk:
        rack_id = int(rk["id"])
    else:
        rk2 = db.execute(text("""
            INSERT INTO customer_racks (location_id, rack_label)
            VALUES (:lid, :rack)
            RETURNING id;
        """), {"lid": location_id, "rack": rack_label}).mappings().first()
        rack_id = int(rk2["id"])

    # 4) patchpanel instance_id
    instance_id = f"PP:{rack_label}:{pp_label}"

    # 5) create patchpanel + ports (uses your existing function)
    res = create_zside_patchpanel(
        db,
        instance_id=instance_id,
        room=room,
        rack_unit=rack_unit,
        rack_label=rack_label,
        customer_id=customer_id,
        cage_no=cage_name,
        panel_type="customer",
        port_layout=port_count,
        enabled_cassettes=enabled_cassettes
    )

    # 6) ensure customer_rack_id is set
    try:
        db.execute(text("""
            UPDATE patchpanel_instances
            SET customer_rack_id = :rid
            WHERE id = :ppid
              AND (customer_rack_id IS NULL);
        """), {"rid": rack_id, "ppid": int(res["patchpanel_id"])})
        db.commit()
    except Exception:
        db.rollback()
        # not fatal

    return {
        "customer_id": customer_id,
        "location_id": location_id,
        "rack_id": rack_id,
        "patchpanel_id": int(res["patchpanel_id"]),
        "instance_id": res["instance_id"],
    }
