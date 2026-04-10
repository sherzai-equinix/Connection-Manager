-- 002_add_migration_audit_lines.sql
-- Migration Audit staging table.

CREATE TABLE IF NOT EXISTS public.migration_audit_lines (
  id                      SERIAL PRIMARY KEY,
  source_file             TEXT,
  source_row              INTEGER,

  customer_name           TEXT,
  system_name             TEXT,
  room                    TEXT,
  rack_code               TEXT,

  switch_name             TEXT,
  switch_port             TEXT,

  a_pp_number             TEXT,
  a_port_label            TEXT,
  z_pp_number             TEXT,
  z_port_label            TEXT,

  product_id              TEXT,
  serial_number           TEXT,

  backbone_in_instance_id TEXT,
  backbone_in_port_label  TEXT,
  backbone_out_instance_id TEXT,
  backbone_out_port_label  TEXT,

  tech_comment            TEXT,

  audit_status            TEXT NOT NULL DEFAULT 'imported',
  audited_by              TEXT,
  audited_at              TIMESTAMPTZ,
  linked_cc_id            INTEGER
);

CREATE INDEX IF NOT EXISTS ix_mal_status ON public.migration_audit_lines(audit_status);
CREATE INDEX IF NOT EXISTS ix_mal_room ON public.migration_audit_lines(room);
CREATE INDEX IF NOT EXISTS ix_mal_switch ON public.migration_audit_lines(switch_name, switch_port);
