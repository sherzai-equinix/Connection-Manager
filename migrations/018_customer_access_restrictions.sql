-- 018_customer_access_restrictions.sql
-- Zugangsbeschränkungen pro Kunde + Access-Requests pro KW

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS access_restricted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS restriction_type TEXT NOT NULL DEFAULT 'access_approval';

CREATE TABLE IF NOT EXISTS public.kw_access_requests (
    id              BIGSERIAL PRIMARY KEY,
    kw_plan_id      BIGINT NOT NULL REFERENCES public.kw_plans(id) ON DELETE CASCADE,
    customer_id     BIGINT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requested_by    BIGINT NULL,
    CONSTRAINT uq_kw_access_customer UNIQUE (kw_plan_id, customer_id)
);

CREATE INDEX IF NOT EXISTS ix_kw_access_plan ON public.kw_access_requests(kw_plan_id);
CREATE INDEX IF NOT EXISTS ix_kw_access_customer ON public.kw_access_requests(customer_id);
