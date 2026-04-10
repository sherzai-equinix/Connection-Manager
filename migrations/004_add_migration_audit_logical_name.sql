-- 004_add_migration_audit_logical_name.sql
-- Store Excel "LOGICAL NAME" separately from the real switch name.

ALTER TABLE public.migration_audit_lines
  ADD COLUMN IF NOT EXISTS logical_name TEXT;

CREATE INDEX IF NOT EXISTS ix_mal_logical_name
  ON public.migration_audit_lines(logical_name);
