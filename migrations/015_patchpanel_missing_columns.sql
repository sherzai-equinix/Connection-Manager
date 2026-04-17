-- Migration 015: Add missing columns to patchpanel_instances
-- These columns are expected by the application code but may not exist
-- in databases that were created from an older schema.

ALTER TABLE public.patchpanel_instances
  ADD COLUMN IF NOT EXISTS rack_label   TEXT,
  ADD COLUMN IF NOT EXISTS cage_no      TEXT,
  ADD COLUMN IF NOT EXISTS room_code    TEXT,
  ADD COLUMN IF NOT EXISTS customer_id  BIGINT,
  ADD COLUMN IF NOT EXISTS side         TEXT;

-- Also ensure the customers / customer_locations / customer_racks tables exist
CREATE TABLE IF NOT EXISTS public.customers (
    id   BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS public.customer_locations (
    id          BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    room        TEXT,
    cage_no     TEXT
);
CREATE INDEX IF NOT EXISTS ix_cl_customer ON public.customer_locations(customer_id);

CREATE TABLE IF NOT EXISTS public.customer_racks (
    id          BIGSERIAL PRIMARY KEY,
    location_id BIGINT NOT NULL REFERENCES public.customer_locations(id) ON DELETE CASCADE,
    rack_label  TEXT
);
CREATE INDEX IF NOT EXISTS ix_cr_location ON public.customer_racks(location_id);
