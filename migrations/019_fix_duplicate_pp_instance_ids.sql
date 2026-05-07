-- Migration 019: Fix duplicate PP instance_ids like "PP:0102:PP.0102" → "PP:0102:0102"
-- Removes the redundant PP: or PP. prefix from the third segment

-- Fix patchpanel_instances.instance_id
UPDATE patchpanel_instances
SET instance_id = regexp_replace(instance_id, '^(PP:[^:]+):PP[.:]\s*', '\1:', 'i')
WHERE instance_id ~* '^PP:[^:]+:PP[.:]';

-- Fix patchpanel_instances.pp_number (strip leading PP: or PP.)
UPDATE patchpanel_instances
SET pp_number = regexp_replace(pp_number, '^PP[.:]\s*', '', 'i')
WHERE pp_number ~* '^PP[.:]';

-- Fix cross_connects that reference patchpanel names
UPDATE cross_connects
SET customer_pp = regexp_replace(customer_pp, '^(PP:[^:]+):PP[.:]\s*', '\1:', 'i')
WHERE customer_pp ~* '^PP:[^:]+:PP[.:]';

-- Fix kw_changes that reference patchpanel names
UPDATE kw_changes
SET customer_pp = regexp_replace(customer_pp, '^(PP:[^:]+):PP[.:]\s*', '\1:', 'i')
WHERE customer_pp ~* '^PP:[^:]+:PP[.:]';

-- Fix historical_lines if they reference patchpanel names
UPDATE historical_lines
SET z_side = regexp_replace(z_side, '^(PP:[^:]+):PP[.:]\s*', '\1:', 'i')
WHERE z_side ~* '^PP:[^:]+:PP[.:]';
