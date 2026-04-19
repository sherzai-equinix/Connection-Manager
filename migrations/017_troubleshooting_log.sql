-- 017_troubleshooting_log.sql
-- Tabelle für Troubleshooting-Protokollierung

CREATE TABLE IF NOT EXISTS public.troubleshooting_log (
    id              BIGSERIAL PRIMARY KEY,
    cross_connect_id BIGINT NOT NULL,
    serial_number   TEXT NOT NULL,
    troubleshoot_type TEXT NOT NULL CHECK (troubleshoot_type IN ('ticket', 'normal')),
    ticket_number   TEXT,
    note            TEXT,
    performed_by    TEXT NOT NULL,
    performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    old_bb_in_pp    TEXT,
    old_bb_in_port  TEXT,
    old_bb_out_pp   TEXT,
    old_bb_out_port TEXT,
    new_bb_in_pp    TEXT,
    new_bb_in_port  TEXT,
    new_bb_out_pp   TEXT,
    new_bb_out_port TEXT
);

CREATE INDEX IF NOT EXISTS ix_ts_log_serial ON public.troubleshooting_log(serial_number);
CREATE INDEX IF NOT EXISTS ix_ts_log_performed_at ON public.troubleshooting_log(performed_at DESC);
