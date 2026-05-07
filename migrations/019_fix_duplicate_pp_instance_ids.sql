-- Migration 019: Fix duplicate PP instance_ids
-- e.g. "PP:0102:PP:0102:1406994" → "PP:0102:1406994"
-- Keeps first PP:rack: segment and removes any duplicated PP:rack: segments after it

-- Fix patchpanel_instances.instance_id
UPDATE patchpanel_instances
SET instance_id = regexp_replace(instance_id, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\1', 'i')
WHERE instance_id ~* '^PP:[^:]+:PP:';

-- Fix patchpanel_instances.pp_number (strip all PP:xxxx: prefixes → bare number)
UPDATE patchpanel_instances
SET pp_number = regexp_replace(pp_number, '^(PP[:.][^:]*:)+', '', 'i')
WHERE pp_number ~* '^PP[.:]';
UPDATE patchpanel_instances
SET pp_number = regexp_replace(pp_number, '^PP[:.] *', '', 'i')
WHERE pp_number ~* '^PP[.:]';

-- Fix historical_lines if they reference patchpanel names
UPDATE historical_lines
SET z_side = regexp_replace(z_side, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\1', 'i')
WHERE z_side ~* '^PP:[^:]+:PP:';

-- Fix kw_changes payload_json (customer_patchpanel_instance_id is inside JSONB)
UPDATE kw_changes
SET payload_json = jsonb_set(
    payload_json,
    '{customer_patchpanel_instance_id}',
    to_jsonb(regexp_replace(
        payload_json->>'customer_patchpanel_instance_id',
        '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\1', 'i'
    ))
)
WHERE payload_json->>'customer_patchpanel_instance_id' ~* '^PP:[^:]+:PP:';
WHERE z_side ~* '^PP:[^:]+:PP:';
WHERE z_side ~* '^PP:[^:]+:PP[.:]';
