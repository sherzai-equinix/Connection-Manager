from database import SessionLocal
from sqlalchemy import text

db = SessionLocal()
rows = db.execute(text(
    "SELECT column_name, data_type FROM information_schema.columns "
    "WHERE table_name = 'cross_connects' AND table_schema = 'public' "
    "ORDER BY ordinal_position"
)).fetchall()
for r in rows:
    print(f"{r[0]:40s} {r[1]}")
db.close()
