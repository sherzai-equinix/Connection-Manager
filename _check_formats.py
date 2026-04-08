"""Check non-standard z_pp_number formats."""
from database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# z_pp_numbers that don't match the clean PP:NNNN:NNNNNNN format
rows = db.execute(text("""
    SELECT DISTINCT z_pp_number
    FROM migration_audit_lines
    WHERE z_pp_number IS NOT NULL
      AND z_pp_number != ''
      AND z_pp_number !~ '^PP:\\d{4}:\\d{6,8}$'
    ORDER BY z_pp_number
""")).all()
print(f"Non-standard z_pp_number formats ({len(rows)}):")
for r in rows:
    print(repr(r[0]))

print()

# Check system_name patterns
rows2 = db.execute(text("""
    SELECT DISTINCT system_name
    FROM migration_audit_lines
    WHERE system_name IS NOT NULL AND system_name != ''
    ORDER BY system_name
""")).all()
print(f"\nAll distinct system_names ({len(rows2)}):")
for r in rows2:
    print(r[0])

db.close()
