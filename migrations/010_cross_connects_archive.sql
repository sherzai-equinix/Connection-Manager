-- 010: cross_connects_archive table
-- Stores deinstalled cross-connects for documentation purposes.
-- All path information (PP, Port, BB) is preserved as-was at time of deinstall.
-- These records do NOT block any ports.

CREATE TABLE IF NOT EXISTS public.cross_connects_archive (
    id                          BIGSERIAL PRIMARY KEY,
    original_id                 BIGINT NOT NULL,            -- id from cross_connects
    serial                      TEXT,
    serial_number               TEXT,
    product_id                  TEXT,
    switch_name                 TEXT,
    switch_port                 TEXT,
    a_patchpanel_id             TEXT,
    a_port_label                TEXT,
    backbone_out_instance_id    TEXT,
    backbone_out_port_label     TEXT,
    backbone_in_instance_id     TEXT,
    backbone_in_port_label      TEXT,
    customer_patchpanel_id      BIGINT,
    customer_port_label         TEXT,
    z_pp_number                 TEXT,
    rack_code                   TEXT,
    system_name                 TEXT,
    customer_id                 BIGINT,
    customer_rack_id            BIGINT,
    customer_location_id        INTEGER,
    job_id                      BIGINT,
    source_audit_line_id        BIGINT,
    status                      TEXT NOT NULL DEFAULT 'deinstalled',
    original_created_at         TIMESTAMPTZ,                -- when the CC was originally created
    deinstalled_at              TIMESTAMPTZ DEFAULT NOW(),  -- when it was deinstalled
    deinstalled_by              TEXT,                       -- who deinstalled it
    reason                      TEXT                        -- optional reason
);

CREATE INDEX IF NOT EXISTS ix_cc_archive_serial   ON public.cross_connects_archive(serial);
CREATE INDEX IF NOT EXISTS ix_cc_archive_orig_id  ON public.cross_connects_archive(original_id);
CREATE INDEX IF NOT EXISTS ix_cc_archive_system   ON public.cross_connects_archive(system_name);
