-- 014_historical_lines_extra_cols.sql
-- Add missing columns for full CSV coverage.

ALTER TABLE public.historical_lines ADD COLUMN IF NOT EXISTS created_by          TEXT;
ALTER TABLE public.historical_lines ADD COLUMN IF NOT EXISTS installation_date   TEXT;
ALTER TABLE public.historical_lines ADD COLUMN IF NOT EXISTS active_line         TEXT;
ALTER TABLE public.historical_lines ADD COLUMN IF NOT EXISTS internal_infos_ops  TEXT;
