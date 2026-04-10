"""One-time script to fix PP room data and list customer hierarchy."""
import sys
sys.path.insert(0, ".")
from database import SessionLocal
from sqlalchemy import text

db = SessionLocal()

# Fix room data
db.execute(text("UPDATE patchpanel_instances SET room = '1A2' WHERE id = 65"))
db.execute(text("UPDATE patchpanel_instances SET room = '5.12S1' WHERE id = 66"))
db.commit()

# Verify
rows = db.execute(text(
    "SELECT id, instance_id, room, customer_id, rack_label, pp_number "
    "FROM patchpanel_instances WHERE id IN (65,66) ORDER BY id"
)).mappings().all()
print("=== FIXED PPs ===")
for r in rows:
    print(f"  id={r['id']} inst={r['instance_id']!s:25} room={r['room']!s:10} cust={r['customer_id']} rack={r['rack_label']} pp={r['pp_number']}")

# List customers
print("\n=== ALL CUSTOMERS ===")
rows2 = db.execute(text("SELECT id, name FROM customers ORDER BY name")).mappings().all()
for r in rows2:
    print(f"  id={r['id']} name={r['name']}")

# Customer > Location > Rack hierarchy
print("\n=== CUSTOMER > LOCATION > RACK MAP ===")
rows3 = db.execute(text("""
    SELECT c.id as cid, c.name, cl.id as loc_id, cl.room, cl.cage_no,
           cr.id as rack_id, cr.rack_label
    FROM customers c
    JOIN customer_locations cl ON cl.customer_id = c.id
    JOIN customer_racks cr ON cr.location_id = cl.id
    ORDER BY c.name, cl.room, cr.rack_label
""")).mappings().all()
for r in rows3:
    print(f"  {r['name']} | loc={r['loc_id']} room={r['room']!s:10} cage={r['cage_no']} | rack_id={r['rack_id']} rack={r['rack_label']}")

db.close()
print("\nDone.")
