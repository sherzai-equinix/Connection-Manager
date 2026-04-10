-- 007_add_kw_planning.sql
-- Manual planning entities for weekly workflows.

CREATE TABLE IF NOT EXISTS public.kw_plans (
    id BIGSERIAL PRIMARY KEY,
    year INTEGER NOT NULL,
    kw INTEGER NOT NULL,
    created_by BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_kw_plans_year_kw UNIQUE (year, kw)
);

CREATE TABLE IF NOT EXISTS public.kw_tasks (
    id BIGSERIAL PRIMARY KEY,
    plan_id BIGINT NOT NULL REFERENCES public.kw_plans(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    line_id BIGINT NULL,
    line1_id BIGINT NULL,
    line2_id BIGINT NULL,
    payload JSONB NULL,
    created_by BIGINT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS ix_kw_tasks_plan_id ON public.kw_tasks(plan_id);
CREATE INDEX IF NOT EXISTS ix_kw_tasks_type_status ON public.kw_tasks(type, status);
CREATE INDEX IF NOT EXISTS ix_kw_tasks_line_id ON public.kw_tasks(line_id);
