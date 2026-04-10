# routers/historical_lines.py
"""
Historische Leitungen – CSV-Archiv (read-only + Import).

Separates Archiv für alte/deinstallierte Leitungen aus CSV-Dateien.
Kein Einfluss auf aktive Cross-Connects, Migration Audit oder KW Jobs.

CSV-Import: Position-basierte Zuordnung, da Header (Port, EQX Port)
in der Quelldatei mehrfach vorkommen.
"""

import csv
import io
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy import text, func as sqfunc
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from security import get_current_user

router = APIRouter(
    prefix=f"{settings.api_prefix}/historical-lines",
    tags=["historical-lines"],
)

# ── Position-based column mapping ─────────────────────────────────────
# The CSV has duplicate headers (Port, EQX Port) that belong to different
# patchpanel groups.  We map by *index position* instead of header text.
#
# Expected layout (0-based):
#   0  Trunk
#   1  Loc A: Room
#   2  LOGICAL NAME
#   3  Customer Name
#   4  System Name
#   5  RFRAPorts
#   6  PP A        7  Port (→ pp_a_port)   8  EQX Port (→ eqx_port_a)
#   9  PP 1       10  Port (→ pp_1_port)  11  EQX Port (→ eqx_port_1)
#  12  PP 2       13  Port (→ pp_2_port)  14  EQX Port (→ eqx_port_2)
#  15  PP Z       16  Port (→ pp_z_port)  17  EQX Port (→ eqx_port_z)
#  18  Serial
#  19  SalesOrder
#  20  Product ID
#  21  Looptest successful
#  22  Ersteller
#  23  Installationsdatum
#  24  Active Line ?
#  25  Interne Infos FR2 OPS

_POS_MAP: list[tuple[int, str]] = [
    (0,  "trunk_no"),
    (1,  "location_a"),
    (2,  "logical_name"),
    (3,  "customer_name"),
    (4,  "system_name"),
    (5,  "rfra_ports"),
    (6,  "pp_a"),
    (7,  "port_a"),
    (8,  "eqx_port_a"),
    (9,  "pp_1"),
    (10, "port_1"),
    (11, "eqx_port_1"),
    (12, "pp_2"),
    (13, "port_2"),
    (14, "eqx_port_2"),
    (15, "pp_z"),
    (16, "port_z"),
    (17, "eqx_port_z"),
    (18, "serial"),
    (19, "sales_order"),
    (20, "product_id"),
    (21, "looptest_successful"),
    (22, "created_by"),
    (23, "installation_date"),
    (24, "active_line"),
    (25, "internal_infos_ops"),
]

_MAX_KNOWN_COL = max(idx for idx, _ in _POS_MAP)  # 25

_ALL_DB_FIELDS = [col for _, col in _POS_MAP]

_INSERT_COLS = [
    "import_batch_id", "source_filename", "imported_at", "imported_by",
    *_ALL_DB_FIELDS,
    "raw_row_json",
]
_INSERT_PLACEHOLDERS = ", ".join(f":{c}" for c in _INSERT_COLS)
_INSERT_SQL = f"INSERT INTO historical_lines ({', '.join(_INSERT_COLS)}) VALUES ({_INSERT_PLACEHOLDERS})"


def _detect_positions(headers: list[str]) -> dict[int, str]:
    """Try to match header row to known positions.

    Strategy:
    1. First try exact position match (fast path, covers 99 % of files).
    2. If that fails (columns shifted), fall back to pattern matching
       using the PP-A / PP-1 / PP-2 / PP-Z anchors.
    """
    # Quick check: does the expected position mapping work?
    # We verify at least a few anchor headers are in the right spots.
    norm = [h.strip().lower().replace("_", " ") for h in headers]

    anchors_ok = 0
    spot_checks = {
        0: ["trunk", "trunk no"],
        3: ["customer name", "customer"],
        6: ["pp a", "ppa"],
        9: ["pp 1", "pp1"],
        12: ["pp 2", "pp2"],
        15: ["pp z", "ppz"],
        18: ["serial"],
    }
    for idx, patterns in spot_checks.items():
        if idx < len(norm) and any(p in norm[idx] for p in patterns):
            anchors_ok += 1

    if anchors_ok >= 3:
        # Position layout matches – use direct mapping
        return {idx: col for idx, col in _POS_MAP if idx < len(headers)}

    # Fallback: scan for PP anchors and derive Port / EQX Port from neighbors
    mapping: dict[int, str] = {}
    pp_anchors = {"pp a": "a", "ppa": "a", "pp 1": "1", "pp1": "1",
                  "pp 2": "2", "pp2": "2", "pp z": "z", "ppz": "z"}

    for i, h in enumerate(norm):
        if h in ("trunk", "trunk no", "trunk no."):
            mapping[i] = "trunk_no"
        elif h in ("loc a: room", "loc a room", "location a", "location_a"):
            mapping[i] = "location_a"
        elif h in ("logical name", "logicalname"):
            mapping[i] = "logical_name"
        elif h in ("customer name", "customername", "customer"):
            mapping[i] = "customer_name"
        elif h in ("system name", "systemname"):
            mapping[i] = "system_name"
        elif h in ("rfraports", "rfra ports", "rfra port"):
            mapping[i] = "rfra_ports"
        elif h in pp_anchors:
            suffix = pp_anchors[h]
            mapping[i] = f"pp_{suffix}"
            # Next two should be Port and EQX Port for this group
            if i + 1 < len(norm) and norm[i + 1] in ("port", "port nr", "port number"):
                mapping[i + 1] = f"port_{suffix}"
            if i + 2 < len(norm) and norm[i + 2] in ("eqx port", "eqxport", "eqx port nr"):
                mapping[i + 2] = f"eqx_port_{suffix}"
        elif h == "serial":
            mapping[i] = "serial"
        elif h in ("salesorder", "sales order"):
            mapping[i] = "sales_order"
        elif h in ("product id", "productid"):
            mapping[i] = "product_id"
        elif h in ("looptest successful", "looptest"):
            mapping[i] = "looptest_successful"
        elif h in ("ersteller", "created by"):
            mapping[i] = "created_by"
        elif h in ("installationsdatum", "installation date"):
            mapping[i] = "installation_date"
        elif h in ("active line ?", "active line", "active"):
            mapping[i] = "active_line"
        elif h in ("interne infos fr2 ops", "interne infos", "internal infos"):
            mapping[i] = "internal_infos_ops"

    return mapping


# ── CSV Import ────────────────────────────────────────────────────────

@router.post("/import")
async def import_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Import a CSV file into the historical_lines table.

    Uses position-based column detection to handle duplicate headers
    (Port, EQX Port appear 4× each in the source CSV).
    Trailing empty columns are silently ignored.
    Completely empty rows are skipped without DB insert.
    """
    if not file.filename:
        raise HTTPException(400, "Kein Dateiname")

    raw_bytes = await file.read()

    # Try common encodings
    content = None
    for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
        try:
            content = raw_bytes.decode(enc)
            break
        except (UnicodeDecodeError, ValueError):
            continue
    if content is None:
        raise HTTPException(400, "Datei konnte nicht dekodiert werden (UTF-8 / Latin-1 / CP1252)")

    # Detect delimiter
    first_line = content.split("\n", 1)[0]
    delimiter = ";" if first_line.count(";") > first_line.count(",") else ","

    reader = csv.reader(io.StringIO(content), delimiter=delimiter)

    # Read header row
    try:
        raw_headers = next(reader)
    except StopIteration:
        raise HTTPException(400, "CSV-Datei ist leer")

    if not raw_headers or not any(h.strip() for h in raw_headers):
        raise HTTPException(400, "CSV-Datei hat keine Header-Zeile")

    # Strip trailing empty headers
    while raw_headers and not raw_headers[-1].strip():
        raw_headers.pop()

    # Detect column positions
    pos_map = _detect_positions(raw_headers)
    if not pos_map:
        raise HTTPException(
            400,
            f"Keine erkannten Spalten. Header: {[h.strip() for h in raw_headers[:30]]}",
        )

    # Count trailing empty columns that were stripped
    orig_header_count = len(first_line.split(delimiter))
    stripped_empty = max(0, orig_header_count - len(raw_headers))

    batch_id = str(uuid.uuid4())
    username = getattr(current_user, "username", None) or str(current_user)
    now = datetime.now(timezone.utc)

    imported = 0
    skipped_empty = 0
    warnings: list[str] = []
    errors: list[str] = []

    for row_idx, cells in enumerate(reader, start=2):  # row 1 = header
        try:
            # Map positional cells → db columns
            mapped: dict[str, str | None] = {}
            for col_idx, db_col in pos_map.items():
                val = cells[col_idx].strip() if col_idx < len(cells) else ""
                mapped[db_col] = val if val else None

            # Skip completely empty rows (no data in any known field)
            if not any(mapped.values()):
                skipped_empty += 1
                continue

            # Skip junk rows where all key identifying fields are empty
            # (rows with only placeholder text like "Bitte RFRA" / "DONT TOUCH")
            _key_fields = ("serial", "product_id", "customer_name",
                           "logical_name", "rfra_ports", "trunk_no")
            if not any(mapped.get(k) for k in _key_fields):
                skipped_empty += 1
                continue

            # Build raw JSON from all non-empty header positions
            raw_json: dict[str, str | None] = {}
            for i, h in enumerate(raw_headers):
                h_name = h.strip()
                if not h_name:
                    continue
                val = cells[i].strip() if i < len(cells) else ""
                # Disambiguate duplicate headers by appending position context
                if h_name in raw_json:
                    db_col = pos_map.get(i, "")
                    h_name = f"{h_name} [{db_col}]" if db_col else f"{h_name} [col{i}]"
                raw_json[h_name] = val if val else None

            # Ensure all DB fields exist in params (fill missing with None)
            params: dict[str, object] = {
                "import_batch_id": batch_id,
                "source_filename": file.filename,
                "imported_at": now,
                "imported_by": username,
                "raw_row_json": json.dumps(raw_json, ensure_ascii=False),
            }
            for col in _ALL_DB_FIELDS:
                params[col] = mapped.get(col)

            db.execute(text(_INSERT_SQL), params)
            imported += 1

        except Exception as exc:
            errors.append(f"Zeile {row_idx}: {str(exc)[:120]}")
            if len(errors) > 200:
                errors.append("... weitere Fehler abgeschnitten")
                break

    db.commit()

    # Compact warning for trailing empty columns
    if stripped_empty > 0:
        warnings.append(f"{stripped_empty} leere Zusatzspalten am Dateiende ignoriert")
    if skipped_empty > 0:
        warnings.append(f"{skipped_empty} komplett leere Zeilen uebersprungen")

    return {
        "success": True,
        "batch_id": batch_id,
        "filename": file.filename,
        "imported": imported,
        "warnings_count": len(warnings),
        "errors_count": len(errors),
        "warnings": warnings[:50],
        "errors": errors[:50],
        "mapped_columns": len(pos_map),
    }


# ── List / Search ─────────────────────────────────────────────────────

@router.get("/list")
def list_historical(
    q: str = Query("", description="Freitext-Suche"),
    serial_filter: str = Query("", description="all / with_serial / without_serial"),
    customer: str = Query("", description="Kundenname-Filter"),
    pp: str = Query("", description="Patchpanel-Filter (sucht in pp_a, pp_1, pp_2, pp_z)"),
    batch_id: str = Query("", description="Import-Batch-ID"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List historical lines with search, filters, and pagination."""
    conditions: list[str] = []
    params: dict[str, str] = {}

    if q.strip():
        conditions.append("""(
            serial ILIKE :q OR product_id ILIKE :q OR customer_name ILIKE :q
            OR logical_name ILIKE :q OR rfra_ports ILIKE :q OR sales_order ILIKE :q
            OR pp_a ILIKE :q OR pp_1 ILIKE :q OR pp_2 ILIKE :q OR pp_z ILIKE :q
            OR eqx_port_a ILIKE :q OR eqx_port_1 ILIKE :q OR eqx_port_2 ILIKE :q OR eqx_port_z ILIKE :q
            OR port_a ILIKE :q OR port_1 ILIKE :q OR port_2 ILIKE :q OR port_z ILIKE :q
            OR system_name ILIKE :q OR trunk_no ILIKE :q OR location_a ILIKE :q
        )""")
        params["q"] = f"%{q.strip()}%"

    if serial_filter == "with_serial":
        conditions.append("serial IS NOT NULL AND serial != ''")
    elif serial_filter == "without_serial":
        conditions.append("(serial IS NULL OR serial = '')")

    if customer.strip():
        conditions.append("customer_name ILIKE :customer")
        params["customer"] = f"%{customer.strip()}%"

    if pp.strip():
        conditions.append("(pp_a ILIKE :pp OR pp_1 ILIKE :pp OR pp_2 ILIKE :pp OR pp_z ILIKE :pp)")
        params["pp"] = f"%{pp.strip()}%"

    if batch_id.strip():
        conditions.append("import_batch_id = :batch_id")
        params["batch_id"] = batch_id.strip()

    where = " AND ".join(conditions) if conditions else "TRUE"

    # Count
    count_sql = f"SELECT COUNT(*) FROM historical_lines WHERE {where}"
    total = db.execute(text(count_sql), params).scalar() or 0

    # Fetch page
    offset = (page - 1) * page_size
    data_sql = f"""
        SELECT * FROM historical_lines
        WHERE {where}
        ORDER BY id DESC
        LIMIT :lim OFFSET :off
    """
    params["lim"] = str(page_size)
    params["off"] = str(offset)
    rows = db.execute(text(data_sql), params).mappings().all()

    items = [dict(r) for r in rows]
    # Convert datetime objects to string for JSON serialization
    for item in items:
        for k, v in item.items():
            if isinstance(v, datetime):
                item[k] = v.isoformat()

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


# ── Single item ───────────────────────────────────────────────────────

@router.get("/item/{item_id}")
def get_historical_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Get a single historical line by ID."""
    row = db.execute(
        text("SELECT * FROM historical_lines WHERE id = :id"),
        {"id": item_id},
    ).mappings().first()

    if not row:
        raise HTTPException(404, "Datensatz nicht gefunden")

    item = dict(row)
    for k, v in item.items():
        if isinstance(v, datetime):
            item[k] = v.isoformat()
    return item


# ── Import batches (history) ──────────────────────────────────────────

@router.get("/batches")
def list_batches(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List all import batches with metadata."""
    rows = db.execute(text("""
        SELECT import_batch_id,
               source_filename,
               imported_by,
               MIN(imported_at) AS imported_at,
               COUNT(*) AS row_count
        FROM historical_lines
        GROUP BY import_batch_id, source_filename, imported_by
        ORDER BY MIN(imported_at) DESC
    """)).mappings().all()

    batches = []
    for r in rows:
        d = dict(r)
        for k, v in d.items():
            if isinstance(v, datetime):
                d[k] = v.isoformat()
        batches.append(d)
    return batches


# ── Delete batch ──────────────────────────────────────────────────────

@router.delete("/batch/{batch_id}")
def delete_batch(
    batch_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Delete all records of an import batch."""
    result = db.execute(
        text("DELETE FROM historical_lines WHERE import_batch_id = :bid"),
        {"bid": batch_id},
    )
    db.commit()
    deleted = result.rowcount
    if deleted == 0:
        raise HTTPException(404, "Batch nicht gefunden")
    return {"success": True, "deleted": deleted, "batch_id": batch_id}


# ── CSV Export (search results) ───────────────────────────────────────

@router.get("/export")
def export_csv(
    q: str = Query("", description="Freitext-Suche"),
    serial_filter: str = Query(""),
    customer: str = Query(""),
    pp: str = Query(""),
    batch_id: str = Query(""),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Export filtered historical lines as CSV."""
    from fastapi.responses import StreamingResponse

    conditions: list[str] = []
    params: dict[str, str] = {}

    if q.strip():
        conditions.append("""(
            serial ILIKE :q OR product_id ILIKE :q OR customer_name ILIKE :q
            OR logical_name ILIKE :q OR rfra_ports ILIKE :q OR sales_order ILIKE :q
            OR pp_a ILIKE :q OR pp_1 ILIKE :q OR pp_2 ILIKE :q OR pp_z ILIKE :q
        )""")
        params["q"] = f"%{q.strip()}%"

    if serial_filter == "with_serial":
        conditions.append("serial IS NOT NULL AND serial != ''")
    elif serial_filter == "without_serial":
        conditions.append("(serial IS NULL OR serial = '')")

    if customer.strip():
        conditions.append("customer_name ILIKE :customer")
        params["customer"] = f"%{customer.strip()}%"

    if pp.strip():
        conditions.append("(pp_a ILIKE :pp OR pp_1 ILIKE :pp OR pp_2 ILIKE :pp OR pp_z ILIKE :pp)")
        params["pp"] = f"%{pp.strip()}%"

    if batch_id.strip():
        conditions.append("import_batch_id = :batch_id")
        params["batch_id"] = batch_id.strip()

    where = " AND ".join(conditions) if conditions else "TRUE"
    rows = db.execute(
        text(f"SELECT * FROM historical_lines WHERE {where} ORDER BY id"),
        params,
    ).mappings().all()

    export_cols = [
        "serial", "product_id", "customer_name", "logical_name", "system_name",
        "trunk_no", "location_a", "rfra_ports",
        "pp_a", "port_a", "eqx_port_a",
        "pp_1", "port_1", "eqx_port_1",
        "pp_2", "port_2", "eqx_port_2",
        "pp_z", "port_z", "eqx_port_z",
        "sales_order", "looptest_successful",
        "created_by", "installation_date", "active_line", "internal_infos_ops",
        "source_filename", "imported_at",
    ]

    def generate():
        output = io.StringIO()
        writer = csv.writer(output, delimiter=";")
        writer.writerow(export_cols)
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)

        for r in rows:
            d = dict(r)
            writer.writerow([str(d.get(c) or "") for c in export_cols])
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=historical_lines_export.csv"},
    )
