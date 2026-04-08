-- 008_kw_plans_lifecycle.sql
-- Adds lifecycle metadata for KW plans.

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

UPDATE public.kw_plans
SET status = 'active'
WHERE status IS NULL OR TRIM(status) = '';

ALTER TABLE public.kw_plans
    ALTER COLUMN status SET DEFAULT 'active';

DO $$
BEGIN
    BEGIN
        ALTER TABLE public.kw_plans
            ALTER COLUMN status SET NOT NULL;
    EXCEPTION WHEN others THEN
        -- Keep migration permissive in restricted environments.
        NULL;
    END;
END $$;

CREATE INDEX IF NOT EXISTS ix_kw_plans_status_year_kw
    ON public.kw_plans(status, year, kw);
