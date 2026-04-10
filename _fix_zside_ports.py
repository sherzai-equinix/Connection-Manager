"""One-time fix: set Z-side panels to 48 ports, mark rows 3+4 as unavailable."""
from sqlalchemy import create_engine, text

DB_URL = "postgresql+psycopg2://deviceapp:SuperSecretPW@localhost:5432/devicedb"
engine = create_engine(DB_URL)

with engine.connect() as c:
    # 1. Update total_ports from 96 to 48 for Z-side panels
    r1 = c.execute(text("UPDATE patchpanel_instances SET total_ports = 48 WHERE side = 'Z' AND total_ports = 96"))
    print(f"Updated total_ports: {r1.rowcount} panels")

    # 2. Mark rows 3+4 ports as unavailable for Z-side panels (keep occupied ones)
    r2 = c.execute(text("""
        UPDATE patchpanel_ports SET status = 'unavailable'
        WHERE patchpanel_id IN (SELECT id FROM patchpanel_instances WHERE side = 'Z')
          AND row_number > 2
          AND status != 'occupied'
    """))
    print(f"Marked unavailable: {r2.rowcount} ports")

    c.commit()

    # Verify
    v = c.execute(text("SELECT total_ports, count(1) FROM patchpanel_instances WHERE side = 'Z' GROUP BY total_ports")).fetchall()
    print(f"After fix - Z-side total_ports: {v}")

    pid = c.execute(text("SELECT id FROM patchpanel_instances WHERE side = 'Z' LIMIT 1")).scalar()
    ps = c.execute(text("SELECT status, count(1) FROM patchpanel_ports WHERE patchpanel_id = :pid GROUP BY status").bindparams(pid=pid)).fetchall()
    print(f"Port statuses for panel {pid}: {ps}")
