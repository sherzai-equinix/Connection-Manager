"""Quick check: existing Z-side data vs what needs importing."""
from database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

queries = [
    ("Existing customers", "SELECT count(*) FROM customers"),
    ("Z-side PPs", "SELECT count(*) FROM patchpanel_instances WHERE side = 'Z'"),
    ("Total PPs", "SELECT count(*) FROM patchpanel_instances"),
    ("Customer locations", "SELECT count(*) FROM customer_locations"),
    ("Customer racks", "SELECT count(*) FROM customer_racks"),
    ("Distinct system_names in audit", "SELECT count(DISTINCT system_name) FROM migration_audit_lines WHERE system_name IS NOT NULL AND system_name != ''"),
    ("Distinct z_pp_numbers in audit", "SELECT count(DISTINCT z_pp_number) FROM migration_audit_lines WHERE z_pp_number IS NOT NULL AND z_pp_number != ''"),
    ("Distinct rack_codes in audit", "SELECT count(DISTINCT rack_code) FROM migration_audit_lines WHERE rack_code IS NOT NULL AND rack_code != ''"),
    ("Audit lines total", "SELECT count(*) FROM migration_audit_lines"),
    ("Audit lines imported", "SELECT count(*) FROM migration_audit_lines WHERE audit_status = 'imported'"),
    ("Audit lines audited", "SELECT count(*) FROM migration_audit_lines WHERE audit_status = 'audited'"),
]

for label, q in queries:
    val = db.execute(text(q)).scalar()
    print(f"{label}: {val}")

# Show distinct system_name samples
print("\n--- Distinct system_name samples (first 30) ---")
rows = db.execute(text("""
    SELECT DISTINCT system_name
    FROM migration_audit_lines
    WHERE system_name IS NOT NULL AND system_name != ''
    ORDER BY system_name
    LIMIT 30
""")).all()
for r in rows:
    print(r[0])

# Show distinct z_pp_numbers already in patchpanel_instances
print("\n--- Z-PP numbers already in patchpanel_instances ---")
rows2 = db.execute(text("""
    SELECT pp_number, instance_id, room, customer_id, side
    FROM patchpanel_instances
    WHERE side = 'Z'
    LIMIT 20
""")).mappings().all()
for r in rows2:
    print(dict(r))

# Z-PP numbers in audit NOT in patchpanel_instances
print("\n--- Z-PP in audit but NOT in patchpanel_instances ---")
missing = db.execute(text("""
    SELECT DISTINCT mal.z_pp_number
    FROM migration_audit_lines mal
    LEFT JOIN patchpanel_instances pi ON (pi.pp_number = mal.z_pp_number OR pi.instance_id = mal.z_pp_number)
    WHERE mal.z_pp_number IS NOT NULL AND mal.z_pp_number != ''
      AND pi.id IS NULL
    ORDER BY mal.z_pp_number
""")).all()
print(f"Count: {len(missing)}")
for r in missing[:20]:
    print(r[0])

db.close()
