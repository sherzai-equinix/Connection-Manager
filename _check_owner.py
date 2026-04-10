from database import get_db
from sqlalchemy import text

db = next(get_db())
r = db.execute(text("SELECT tableowner FROM pg_tables WHERE tablename = 'migration_audit_lines'")).fetchone()
print('Owner:', r)
r2 = db.execute(text("SELECT current_user")).fetchone()
print('Current user:', r2)
