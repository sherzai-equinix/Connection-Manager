-- 011_add_audit_dedup_columns.sql
-- Adds columns for current-state deduplication in migration audit.
-- group_key: identifier to group multiple historical states of the same circuit
-- is_current: TRUE for the latest/effective state per group
-- event_type: Install, Line Move, Path Move, A-Update, Z-Update, Deinstall
-- superseded_by: ID of the newer line that replaced this one

ALTER TABLE public.migration_audit_lines
  ADD COLUMN IF NOT EXISTS group_key       TEXT,
  ADD COLUMN IF NOT EXISTS is_current      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS event_type      TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by   INTEGER REFERENCES public.migration_audit_lines(id);

CREATE INDEX IF NOT EXISTS ix_mal_group_key  ON public.migration_audit_lines(group_key);
CREATE INDEX IF NOT EXISTS ix_mal_is_current ON public.migration_audit_lines(is_current);
