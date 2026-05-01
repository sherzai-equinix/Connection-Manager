"""
═══════════════════════════════════════════════════════════════════
Import Z-Side Customer Structure from migration_audit_lines
═══════════════════════════════════════════════════════════════════

This script reads all Z-side information from migration_audit_lines
and ensures the complete customer hierarchy exists in the database:

    Customer → Location (Room/Cage) → Rack → Patchpanel (+ Ports)

It also updates migration_audit_lines.z_pp_number to the cleaned
format so downstream lookups work reliably.

Run:  .venv/Scripts/python.exe scripts/import_zside_structure.py
═══════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import re
import sys
import os
import json
from datetime import datetime
from collections import defaultdict
from typing import Optional

# Ensure project root is on sys.path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from database import SessionLocal
from sqlalchemy import text
from crud import generate_ports

# ═══════════════════════════════════════
# Config
# ═══════════════════════════════════════
PORT_LAYOUT = 48           # 48 ports per customer patchpanel (2 rows × 4 letters × 6 pos)
DEFAULT_PANEL_TYPE = "customer"
DRY_RUN = "--dry-run" in sys.argv

# ═══════════════════════════════════════
# Logging
# ═══════════════════════════════════════
LOG: list[dict] = []

def log_info(msg: str, **kw):
    entry = {"level": "INFO", "msg": msg, **kw}
    LOG.append(entry)
    print(f"  [INFO] {msg}")

def log_warn(msg: str, **kw):
    entry = {"level": "WARN", "msg": msg, **kw}
    LOG.append(entry)
    print(f"  [WARN] {msg}")

def log_error(msg: str, **kw):
    entry = {"level": "ERROR", "msg": msg, **kw}
    LOG.append(entry)
    print(f"  [ERROR] {msg}")

# ═══════════════════════════════════════
# PP Number Cleaning
# ═══════════════════════════════════════
PP_RE = re.compile(r"^PP\s*:\s*(\d{3,4})\s*:\s*(\d{6,8})", re.IGNORECASE)
PP_RE_NO_COLON = re.compile(r"^PP(\d{4})\s*:\s*(\d{6,8})", re.IGNORECASE)  # PP0107:1336422

def clean_pp_number(raw: str) -> tuple[Optional[str], Optional[str], Optional[int]]:
    """Clean a Z-side PP number.

    Returns (clean_pp, rack_code, rack_unit_from_suffix)

    Examples:
        "PP:0101:1071266"                 → ("PP:0101:1071266", "0101", None)
        "PP:0607:1370187 / RU 23"         → ("PP:0607:1370187", "0607", 23)
        "PP: 0102:1402309 / RU31"         → ("PP:0102:1402309", "0102", 31)
        "P:0506:1339599 RU 11"            → ("PP:0506:1339599", "0506", 11)
        "PP:1001:1402748/ HU 20"          → ("PP:1001:1402748", "1001", 20)
        "PP0107:1336422"                  → ("PP:0107:1336422", "0107", None)
    """
    s = (raw or "").strip()
    if not s:
        return None, None, None

    # Extract RU from suffix:  "/ RU 23", " / RU23", " RU 11", "/ HU 20"
    ru_match = re.search(r"[/\s]+(?:RU|HU)\s*(\d+)\s*$", s, re.IGNORECASE)
    rack_unit = int(ru_match.group(1)) if ru_match else None
    # Strip the RU suffix for PP parsing
    if ru_match:
        s = s[:ru_match.start()].strip()

    # Fix common typos: "P:" at start → "PP:"
    if re.match(r"^P:", s) and not re.match(r"^PP:", s, re.IGNORECASE):
        s = "P" + s  # P: → PP:

    # Try standard format
    m = PP_RE.match(s)
    if m:
        rack = m.group(1).zfill(4)
        pp_num = m.group(2).strip()
        return f"PP:{rack}:{pp_num}", rack, rack_unit

    # Try PP0107:1336422 format (missing first colon)
    m2 = PP_RE_NO_COLON.match(s)
    if m2:
        rack = m2.group(1).zfill(4)
        pp_num = m2.group(2).strip()
        return f"PP:{rack}:{pp_num}", rack, rack_unit

    return None, None, rack_unit


# ═══════════════════════════════════════
# System Name Parsing
# ═══════════════════════════════════════

def parse_system_name(system_name: str) -> dict:
    """Parse system_name to extract room, cage, mode.

    The FULL system_name string is the customer name — we do NOT split it.

    Examples:
        FR2:EG-M5.12:S1:SUSQUEHANNA           → room=5.12, cage=S1, mode=S
        FR2:OG-M1A2:OC:Allston Trading         → room=1A2, cage=None, mode=OC
        FR2:0G:051100:CAPITAL FUND MGMT         → room=5.11, cage=None, mode=None
        FR2:01:004500:CITADEL ENTERPRISE        → room=0.45, cage=None (compact)
        FR2:0G:054S05:EULINKS LTD.              → room=5.4, cage=S5, mode=S
        FR2:EG-M4.05S3:JUMP TRADING             → room=4.05, cage=S3
        FR2:0G:0512S7:CITADEL                   → room=5.12, cage=S7
        FR2:01:01A200:THEOMNE.NET, LLC           → room=1A2, cage=None, mode=OC
    """
    result = {"room": None, "cage": None, "mode": None, "room_display": None}
    if not system_name:
        return result

    parts = [p.strip() for p in str(system_name).split(":") if p.strip()]

    # Flatten "XX-<tok>" forms (e.g. "EG-M5.12" → "M5.12", "OG-M1A2" → "M1A2")
    flat = []
    for p in parts:
        if "-" in p:
            flat.append(p.split("-")[-1].strip())
        else:
            flat.append(p)

    room = None
    room_idx = None
    cage = None
    mode = None

    # Strategy 1: Look for M<room> tokens — "M5.12", "M1A2", "M4.5"
    for i, tok in enumerate(flat):
        if tok.startswith("M") and len(tok) > 1:
            cand = tok[1:]
            # Handle embedded cage: M4.05S3 → room=4.05, cage=S3
            cage_embedded = re.match(r"^(\d+\.\d+)S(\d+)$", cand)
            if cage_embedded:
                room = cage_embedded.group(1)
                cage = f"S{int(cage_embedded.group(2))}"
                mode = "S"
                room_idx = i
                break
            if re.fullmatch(r"\d+[A-Z]\d+", cand) or re.fullmatch(r"\d+(?:\.\d+)?", cand):
                room = cand
                room_idx = i
                break

    # Strategy 2: Look for compact digit codes — "051100" → room=5.11, "054S05" → room=5.4, cage=S5
    if room is None:
        for i, tok in enumerate(flat):
            # 054S05 / 0512S7 pattern
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
                cage = f"S{int(m.group(2))}"
                mode = "S"
                room_idx = i
                break

            # 6-digit code: 051100 → room 5.11
            m2 = re.fullmatch(r"(\d{6})", tok)
            if m2:
                code = m2.group(1)
                # First digit is floor block, next two are major.minor
                # 051100 → 05=floor area?, 11=room, 00=sub
                # Patterns seen: 004500, 050900, 051100, 051200, 005400
                # Convention: XY_ZZ_00 where XY.ZZ is the room
                a, b = int(code[0:2]), int(code[2:4])
                if a == 0 and b > 0:
                    # 004500 → 0.45? No — this is room code.
                    # Actually from the data: 051100 maps to M5.11, 051200 to M5.12
                    # 005400 maps to M5.4 (or M0.54?)
                    # Looking at system_names vs audit "room" column:
                    # FR2:0G:051100:* → room M5.13 S1 (A-side room, not customer room)
                    # We need customer room from system_name.
                    # Pattern: 05XXYY → major=X, minor=Y (first 0 is prefix)
                    #   051100 → 5.11
                    #   051200 → 5.12
                    #   050900 → 5.09
                    #   005400 → 0.54 or 5.4?
                    #   004500 → 0.45 or 4.5?
                    pass

                # Better approach: take the 6-digit code and try major.minor
                # From the data, the format seems to be: first 2 digits (area/floor),
                # next 2 (room major), next 2 (room sub)
                # But it's ambiguous. Let me use a simpler heuristic:
                # 0ABBCC → room A.BB (if A > 0) or fallback to AB.CC
                first_three = code[0:3]
                second_three = code[3:6]
                # Try: treat as 0XYYCC where X.YY is room
                d0, d1, d2, d3, d4, d5 = [int(c) for c in code]

                # Known mappings from system_name → actual customer rooms:
                # 051100 → 5.11, 051200 → 5.12, 050900 → 5.09
                # 005400 → 0.54 or 5.4  (M5.4 seems right from "OG-M4.5" pattern)
                # 004500 → 4.5 (based on M4.5)
                # 056S01 → 5.6 cage S1 (handled in S pattern above)
                # 051303 → 5.13 sub 03
                # 01A200 → 1A2 (alphanumeric room)

                # Handle alphanumeric: 01A200
                alpha_m = re.fullmatch(r"(\d{2})([A-Z])(\d)(\d{2})", tok)
                if alpha_m:
                    r_major = int(alpha_m.group(1))
                    r_letter = alpha_m.group(2)
                    r_minor = int(alpha_m.group(3))
                    room = f"{r_major}{r_letter}{r_minor}" if r_major > 0 else f"{r_letter}{r_minor}"
                    # Simplify: "01A200" → "1A2"
                    room = re.sub(r"^0+", "", room) or "0"
                    mode = "OC"
                    room_idx = i
                    break

                # General 6-digit numeric:
                # Pattern from data: 0XYYCC where X.YY is room
                x = int(code[1:2])  # single digit major
                yy = int(code[2:4])  # two-digit minor
                if x > 0 and yy > 0:
                    room = f"{x}.{yy:02d}"
                elif x == 0 and yy > 0:
                    # 004500 → yy=45 → maybe 4.5?
                    room = f"{yy // 10}.{yy % 10}" if yy >= 10 else str(yy)
                else:
                    room = code  # fallback: store raw
                room_idx = i
                break

    # Extract cage/mode from token after room (if not already found)
    if cage is None and room_idx is not None and room_idx + 1 < len(flat):
        nxt = flat[room_idx + 1]
        if re.fullmatch(r"OC", nxt, re.IGNORECASE):
            mode = "OC"
            cage = None
        elif re.fullmatch(r"S\d+", nxt, re.IGNORECASE):
            mode = "S"
            cage = "S" + str(int(re.sub(r"\D", "", nxt)))

    # Room display: prefix with M for numeric rooms
    if room:
        if re.fullmatch(r"\d+(?:\.\d+)?", room):
            result["room_display"] = f"M{room}"
        else:
            result["room_display"] = room

    result["room"] = room
    result["cage"] = cage
    result["mode"] = mode
    return result


# ═══════════════════════════════════════
# Main Import Logic
# ═══════════════════════════════════════

def run_import():
    """Read migration_audit_lines, extract Z-side structure, create hierarchy."""
    print("=" * 70)
    print("  Z-SIDE CUSTOMER STRUCTURE IMPORT")
    print(f"  Started: {datetime.now().isoformat()}")
    print(f"  Mode: {'DRY RUN' if DRY_RUN else 'LIVE'}")
    print("=" * 70)

    db = SessionLocal()

    try:
        # ── Step 1: Read all audit lines with Z-side data ──
        rows = db.execute(text("""
            SELECT id, system_name, customer_name, rack_code,
                   z_pp_number, z_pp_raw, z_port_label, room
            FROM migration_audit_lines
            WHERE z_pp_number IS NOT NULL AND z_pp_number != ''
            ORDER BY id
        """)).mappings().all()

        print(f"\n  Audit lines with Z-PP data: {len(rows)}")

        # ── Step 2: Build unique Z-side structures ──
        # Key: cleaned_pp_number → aggregated info
        pp_records: dict[str, dict] = {}
        # Track audit lines → clean PP mapping for updating
        audit_line_updates: list[tuple[int, str, int | None]] = []  # (audit_id, clean_pp, ru)

        skipped_no_pp = 0
        skipped_no_system = 0

        for r in rows:
            r = dict(r)
            raw_pp = (r["z_pp_number"] or "").strip()
            system_name = (r["system_name"] or "").strip()
            audit_id = r["id"]

            # Clean the PP number
            clean_pp, rack_code, ru_from_suffix = clean_pp_number(raw_pp)

            if not clean_pp:
                log_warn(f"Audit #{audit_id}: Cannot parse z_pp_number '{raw_pp}'", audit_id=audit_id)
                skipped_no_pp += 1
                continue

            # Track update for this audit line (only if format changed)
            if clean_pp != raw_pp:
                audit_line_updates.append((audit_id, clean_pp, ru_from_suffix))

            # Use full system_name as customer name (per requirement)
            # The FULL system_name string IS the customer identifier
            customer_name_full = system_name

            if not customer_name_full:
                log_warn(f"Audit #{audit_id}: system_name empty, using customer_name field", audit_id=audit_id)
                customer_name_full = (r["customer_name"] or "").strip()

            if not customer_name_full:
                log_warn(f"Audit #{audit_id}: No customer name available (system_name + customer_name both empty)", audit_id=audit_id)
                skipped_no_system += 1
                continue

            # Parse room/cage from system_name
            parsed = parse_system_name(system_name)
            customer_room = parsed["room_display"] or parsed["room"]
            customer_cage = parsed["cage"]

            # Rack code: prefer from PP number, fallback to audit column
            if not rack_code:
                rack_code = (r["rack_code"] or "").strip()

            # Build record (deduplicate by clean PP number)
            if clean_pp not in pp_records:
                pp_records[clean_pp] = {
                    "clean_pp": clean_pp,
                    "rack_code": rack_code,
                    "ru": ru_from_suffix,
                    "customer_name": customer_name_full,
                    "customer_room": customer_room,
                    "customer_cage": customer_cage,
                    "audit_ids": [],
                    "port_labels_used": set(),
                }
            rec = pp_records[clean_pp]
            rec["audit_ids"].append(audit_id)
            if r["z_port_label"]:
                rec["port_labels_used"].add(r["z_port_label"])

        print(f"  Unique Z-PPs found: {len(pp_records)}")
        print(f"  Skipped (unparsable PP): {skipped_no_pp}")
        print(f"  Skipped (no customer name): {skipped_no_system}")
        print(f"  Audit lines to update (PP format): {len(audit_line_updates)}")

        # ── Step 3: Check which PPs already exist ──
        existing_pps: dict[str, int] = {}  # clean_pp → patchpanel_instances.id

        for clean_pp, rec in pp_records.items():
            # Extract just the pp_number part (digits after last colon)
            pp_num_only = clean_pp.split(":")[-1] if ":" in clean_pp else clean_pp

            row = db.execute(text("""
                SELECT id FROM patchpanel_instances
                WHERE instance_id = :iid OR pp_number = :ppn OR pp_number = :iid
                LIMIT 1
            """), {"iid": clean_pp, "ppn": pp_num_only}).mappings().first()
            if row:
                existing_pps[clean_pp] = int(row["id"])

        print(f"  Already existing PPs: {len(existing_pps)}")
        print(f"  PPs to create: {len(pp_records) - len(existing_pps)}")

        if DRY_RUN:
            print("\n  ─── DRY RUN: No changes will be made ───")
            _print_summary(pp_records, existing_pps, audit_line_updates)
            _save_log()
            db.close()
            return

        # ── Step 4: Create missing structures ──
        stats = {
            "customers_created": 0,
            "customers_reused": 0,
            "locations_created": 0,
            "locations_reused": 0,
            "racks_created": 0,
            "racks_reused": 0,
            "pps_created": 0,
            "pps_existed": len(existing_pps),
            "audit_lines_updated": 0,
            "errors": 0,
        }

        # Customer name cache: full_system_name → customer_id
        customer_cache: dict[str, int] = {}

        db.rollback()  # clean slate

        for clean_pp, rec in pp_records.items():
            if clean_pp in existing_pps:
                # PP already exists — just ensure audit lines point to clean PP
                continue

            try:
                with db.begin():
                    # 4a) Ensure customer
                    cust_name = rec["customer_name"]
                    if cust_name in customer_cache:
                        customer_id = customer_cache[cust_name]
                        stats["customers_reused"] += 1
                    else:
                        cust = db.execute(text("""
                            SELECT id FROM customers
                            WHERE lower(name) = lower(:name)
                            ORDER BY id LIMIT 1
                        """), {"name": cust_name}).mappings().first()

                        if cust:
                            customer_id = int(cust["id"])
                            stats["customers_reused"] += 1
                        else:
                            cust = db.execute(text("""
                                INSERT INTO customers (name)
                                VALUES (:name)
                                RETURNING id
                            """), {"name": cust_name}).mappings().first()
                            customer_id = int(cust["id"])
                            stats["customers_created"] += 1
                            log_info(f"Created customer: '{cust_name}' → id={customer_id}")

                        customer_cache[cust_name] = customer_id

                    # 4b) Ensure customer_location
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
                        WHERE customer_id = :cid
                          AND room = :room
                          AND COALESCE(cage_no, '') = COALESCE(:cage_no, '')
                        ORDER BY id LIMIT 1
                    """), {"cid": customer_id, "room": c_room, "cage_no": cage_no}).mappings().first()

                    if loc:
                        location_id = int(loc["id"])
                        stats["locations_reused"] += 1
                    else:
                        loc = db.execute(text("""
                            INSERT INTO customer_locations (customer_id, room, cage, room_code, cage_no)
                            VALUES (:cid, :room, :cage, :room_code, :cage_no)
                            RETURNING id
                        """), {
                            "cid": customer_id,
                            "room": c_room,
                            "cage": c_cage,
                            "room_code": c_room,
                            "cage_no": cage_no,
                        }).mappings().first()
                        location_id = int(loc["id"])
                        stats["locations_created"] += 1
                        log_info(f"Created location: customer_id={customer_id}, room={c_room}, cage={c_cage}")

                    # 4c) Ensure customer_rack
                    # NOTE: customer_racks has unique constraint on (room, trim(rack_label))
                    # so we look up by room+rack_label first (not just location_id)
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
                            VALUES (:lid, :rl, :room)
                            RETURNING id
                        """), {"lid": location_id, "rl": rack_label, "room": c_room}).mappings().first()
                        rack_id = int(rack["id"])
                        stats["racks_created"] += 1
                        log_info(f"Created rack: location_id={location_id}, label={rack_label}")

                    # 4d) Create patchpanel_instance
                    ru = rec["ru"] or 1
                    pp_num_only = clean_pp.split(":")[-1] if ":" in clean_pp else clean_pp

                    pp_row = db.execute(text("""
                        INSERT INTO patchpanel_instances (
                            instance_id, room, rack_unit, panel_type, total_ports,
                            customer_id, cage_no, rack_label, customer_rack_id,
                            pp_number, side
                        ) VALUES (
                            :instance_id, :room, :rack_unit, :panel_type, :total_ports,
                            :customer_id, :cage_no, :rack_label, :customer_rack_id,
                            :pp_number, 'Z'
                        )
                        RETURNING id
                    """), {
                        "instance_id": clean_pp,
                        "room": c_room,
                        "rack_unit": ru,
                        "panel_type": DEFAULT_PANEL_TYPE,
                        "total_ports": PORT_LAYOUT,
                        "customer_id": customer_id,
                        "cage_no": cage_no,
                        "rack_label": rack_label,
                        "customer_rack_id": rack_id,
                        "pp_number": pp_num_only,
                    }).mappings().first()

                    pp_id = int(pp_row["id"])

                    # 4e) Create ports (96 = 4 cassettes × 4 letters × 6 positions)
                    ports = generate_ports(PORT_LAYOUT)
                    db.execute(text("""
                        INSERT INTO patchpanel_ports
                            (patchpanel_id, row_number, row_letter, position, port_label, status)
                        VALUES
                            (:patchpanel_id, :row_number, :row_letter, :position, :port_label, :status)
                    """), [
                        {
                            "patchpanel_id": pp_id,
                            "row_number": p["row_number"],
                            "row_letter": p["row_letter"],
                            "position": p["position"],
                            "port_label": p["port_label"],
                            "status": p["status"],
                        }
                        for p in ports
                    ])

                    stats["pps_created"] += 1
                    existing_pps[clean_pp] = pp_id
                    log_info(f"Created PP: {clean_pp} → id={pp_id}, room={c_room}, rack={rack_label}, customer='{cust_name}'")

            except Exception as e:
                stats["errors"] += 1
                log_error(f"Failed to create PP {clean_pp}: {e}", pp=clean_pp, error=str(e))
                try:
                    db.rollback()
                except Exception:
                    pass

        # ── Step 5: Update audit lines with cleaned PP numbers ──
        if audit_line_updates:
            print(f"\n  Updating {len(audit_line_updates)} audit lines with cleaned z_pp_number...")
            batch_size = 50
            for i in range(0, len(audit_line_updates), batch_size):
                batch = audit_line_updates[i:i + batch_size]
                try:
                    db.rollback()
                    with db.begin():
                        for audit_id, clean_pp, _ in batch:
                            db.execute(text("""
                                UPDATE migration_audit_lines
                                SET z_pp_number = :pp
                                WHERE id = :id AND z_pp_number != :pp
                            """), {"pp": clean_pp, "id": audit_id})
                            stats["audit_lines_updated"] += 1
                except Exception as e:
                    log_error(f"Failed to update audit line batch starting at {i}: {e}")
                    stats["errors"] += 1
                    try:
                        db.rollback()
                    except Exception:
                        pass

        # ── Step 6: Mark occupied ports ──
        # For each PP that now exists, mark ports that appear in audit lines as occupied
        print("\n  Marking used ports...")
        ports_marked = 0
        for clean_pp, rec in pp_records.items():
            pp_id = existing_pps.get(clean_pp)
            if not pp_id or not rec["port_labels_used"]:
                continue
            for port_label in rec["port_labels_used"]:
                try:
                    db.rollback()
                    with db.begin():
                        db.execute(text("""
                            UPDATE patchpanel_ports
                            SET status = 'occupied'
                            WHERE patchpanel_id = :ppid
                              AND port_label = :pl
                              AND status != 'occupied'
                        """), {"ppid": pp_id, "pl": port_label})
                        ports_marked += 1
                except Exception:
                    pass

        stats["ports_marked"] = ports_marked

        # ── Print summary ──
        _print_summary(pp_records, existing_pps, audit_line_updates, stats)
        _save_log()

    finally:
        db.close()


def _print_summary(pp_records, existing_pps, audit_line_updates, stats=None):
    print("\n" + "=" * 70)
    print("  IMPORT SUMMARY")
    print("=" * 70)
    if stats:
        for k, v in stats.items():
            print(f"    {k}: {v}")
    print(f"\n  Total unique Z-PPs: {len(pp_records)}")
    print(f"  Already existed: {len(existing_pps)}")
    print(f"  Audit lines format-updated: {len(audit_line_updates)}")

    # List warnings/errors
    warns = [e for e in LOG if e["level"] == "WARN"]
    errs = [e for e in LOG if e["level"] == "ERROR"]
    if warns:
        print(f"\n  Warnings ({len(warns)}):")
        for w in warns[:20]:
            print(f"    - {w['msg']}")
        if len(warns) > 20:
            print(f"    ... and {len(warns) - 20} more")
    if errs:
        print(f"\n  Errors ({len(errs)}):")
        for e in errs[:20]:
            print(f"    - {e['msg']}")
        if len(errs) > 20:
            print(f"    ... and {len(errs) - 20} more")

    print("\n" + "=" * 70)


def _save_log():
    """Save import log to JSON file."""
    log_path = os.path.join(PROJECT_ROOT, f"zside_import_log_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(LOG, f, ensure_ascii=False, indent=2, default=str)
    print(f"  Log saved to: {log_path}")


if __name__ == "__main__":
    run_import()
