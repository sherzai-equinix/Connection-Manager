-- 009_add_kw_changes.sql
-- Adds kw_changes and aligns kw_plans lifecycle to open|locked|completed.

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS status TEXT;

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS created_by BIGINT NULL;

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;

ALTER TABLE public.kw_plans
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

UPDATE public.kw_plans
SET status = CASE
    WHEN LOWER(COALESCE(status, '')) IN ('open', 'locked', 'completed') THEN LOWER(status)
    WHEN LOWER(COALESCE(status, '')) IN ('active', 'draft') THEN 'open'
    WHEN LOWER(COALESCE(status, '')) IN ('archived', 'done') THEN 'completed'
    ELSE 'open'
END;

ALTER TABLE public.kw_plans
    ALTER COLUMN status SET DEFAULT 'open';

DO $$
BEGIN
    BEGIN
        ALTER TABLE public.kw_plans
            ALTER COLUMN status SET NOT NULL;
    EXCEPTION WHEN others THEN
        NULL;
    END;
END $$;

CREATE INDEX IF NOT EXISTS ix_kw_plans_status_year_kw
    ON public.kw_plans(status, year, kw);

CREATE TABLE IF NOT EXISTS public.kw_changes (
    id BIGSERIAL PRIMARY KEY,
    kw_plan_id BIGINT NOT NULL REFERENCES public.kw_plans(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    target_cross_connect_id BIGINT NULL,
    payload_json JSONB NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,
    created_by BIGINT NULL,
    completed_by BIGINT NULL
);

UPDATE public.kw_changes
SET status = CASE
    WHEN LOWER(COALESCE(status, '')) IN ('planned', 'in_progress', 'done', 'canceled') THEN LOWER(status)
    WHEN LOWER(COALESCE(status, '')) = 'cancelled' THEN 'canceled'
    ELSE 'planned'
END;

CREATE INDEX IF NOT EXISTS ix_kw_changes_plan
    ON public.kw_changes(kw_plan_id);

CREATE INDEX IF NOT EXISTS ix_kw_changes_type_status
    ON public.kw_changes(type, status);

CREATE INDEX IF NOT EXISTS ix_kw_changes_target
    ON public.kw_changes(target_cross_connect_id);
