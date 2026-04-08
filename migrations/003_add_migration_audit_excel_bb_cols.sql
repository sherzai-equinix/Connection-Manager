-- 003_add_migration_audit_excel_bb_cols.sql
-- Extra columns needed to keep full PP strings and Excel-provided BB IN/OUT (PP1/PP2) + EQX ports.

ALTER TABLE public.migration_audit_lines
  ADD COLUMN IF NOT EXISTS a_pp_raw text,
  ADD COLUMN IF NOT EXISTS z_pp_raw text,
  ADD COLUMN IF NOT EXISTS a_eqx_port text,
  ADD COLUMN IF NOT EXISTS z_eqx_port text,

  ADD COLUMN IF NOT EXISTS pp1_raw text,
  ADD COLUMN IF NOT EXISTS pp1_number text,
  ADD COLUMN IF NOT EXISTS pp1_port_label text,
  ADD COLUMN IF NOT EXISTS pp1_eqx_port text,

  ADD COLUMN IF NOT EXISTS pp2_raw text,
  ADD COLUMN IF NOT EXISTS pp2_number text,
  ADD COLUMN IF NOT EXISTS pp2_port_label text,
  ADD COLUMN IF NOT EXISTS pp2_eqx_port text;
