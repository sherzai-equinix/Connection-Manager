-- 013_historical_lines.sql
-- Separate archive table for imported CSV data (historical / deinstalled lines).
-- Read-only reference – no relation to active cross-connects.

CREATE TABLE IF NOT EXISTS public.historical_lines (
    id                  BIGSERIAL PRIMARY KEY,
    import_batch_id     TEXT        NOT NULL,
    source_filename     TEXT,
    imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    imported_by         TEXT,

    -- original CSV fields (1:1 from source)
    trunk_no            TEXT,
    location_a          TEXT,
    logical_name        TEXT,
    customer_name       TEXT,
    system_name         TEXT,
    rfra_ports          TEXT,
    pp_a                TEXT,
    port_a              TEXT,
    eqx_port_a          TEXT,
    pp_1                TEXT,
    port_1              TEXT,
    eqx_port_1          TEXT,
    pp_2                TEXT,
    port_2              TEXT,
    eqx_port_2          TEXT,
    pp_z                TEXT,
    port_z              TEXT,
    eqx_port_z          TEXT,
    serial              TEXT,
    sales_order         TEXT,
    product_id          TEXT,
    looptest_successful TEXT,

    -- full original row as JSON for lossless preservation
    raw_row_json        JSONB
);

-- search indexes
CREATE INDEX IF NOT EXISTS ix_hl_serial         ON public.historical_lines (serial);
CREATE INDEX IF NOT EXISTS ix_hl_product_id     ON public.historical_lines (product_id);
CREATE INDEX IF NOT EXISTS ix_hl_customer_name  ON public.historical_lines (customer_name);
CREATE INDEX IF NOT EXISTS ix_hl_logical_name   ON public.historical_lines (logical_name);
CREATE INDEX IF NOT EXISTS ix_hl_pp_a           ON public.historical_lines (pp_a);
CREATE INDEX IF NOT EXISTS ix_hl_pp_1           ON public.historical_lines (pp_1);
CREATE INDEX IF NOT EXISTS ix_hl_pp_2           ON public.historical_lines (pp_2);
CREATE INDEX IF NOT EXISTS ix_hl_pp_z           ON public.historical_lines (pp_z);
CREATE INDEX IF NOT EXISTS ix_hl_rfra_ports     ON public.historical_lines (rfra_ports);
CREATE INDEX IF NOT EXISTS ix_hl_sales_order    ON public.historical_lines (sales_order);
CREATE INDEX IF NOT EXISTS ix_hl_batch          ON public.historical_lines (import_batch_id);
CREATE INDEX IF NOT EXISTS ix_hl_imported_at    ON public.historical_lines (imported_at);
