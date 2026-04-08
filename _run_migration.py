from sqlalchemy import create_engine, text

# Connect as postgres superuser
engine = create_engine("postgresql+psycopg2://postgres:SuperSecretPW@localhost:5432/devicedb")
with engine.connect() as conn:
    conn.execute(text("ALTER TABLE public.migration_audit_lines ADD COLUMN IF NOT EXISTS group_key TEXT"))
    conn.execute(text("ALTER TABLE public.migration_audit_lines ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE"))
    conn.execute(text("ALTER TABLE public.migration_audit_lines ADD COLUMN IF NOT EXISTS event_type TEXT"))
    conn.execute(text("ALTER TABLE public.migration_audit_lines ADD COLUMN IF NOT EXISTS superseded_by INTEGER"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_mal_group_key ON public.migration_audit_lines(group_key)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_mal_is_current ON public.migration_audit_lines(is_current)"))
    # Grant permissions to deviceapp
    conn.execute(text("GRANT ALL ON public.migration_audit_lines TO deviceapp"))
    conn.commit()
    print("Migration OK")

    cols = conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'migration_audit_lines' "
        "AND column_name IN ('group_key','is_current','event_type','superseded_by')"
    )).fetchall()
    print(f"Columns: {[c[0] for c in cols]}")
