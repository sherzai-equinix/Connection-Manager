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

-- Fix cross_connects that reference patchpanel names
UPDATE cross_connects
SET customer_pp = regexp_replace(customer_pp, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\1', 'i')
WHERE customer_pp ~* '^PP:[^:]+:PP:';

-- Fix kw_changes that reference patchpanel names
UPDATE kw_changes
SET customer_pp = regexp_replace(customer_pp, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\1', 'i')
WHERE customer_pp ~* '^PP:[^:]+:PP:';

-- Fix historical_lines if they reference patchpanel names
UPDATE historical_lines
SET z_side = regexp_replace(z_side, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\1', 'i')
WHERE z_side ~* '^PP:[^:]+:PP:';
WHERE z_side ~* '^PP:[^:]+:PP[.:]';
