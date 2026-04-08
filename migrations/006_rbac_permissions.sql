-- RBAC + Permission Grants + Audit Log extensions

-- Users: ensure role exists and is not null
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS role text;

UPDATE public.users
SET role = 'viewer'
WHERE role IS NULL OR role = '';

ALTER TABLE public.users
ALTER COLUMN role SET DEFAULT 'viewer';

ALTER TABLE public.users
ALTER COLUMN role SET NOT NULL;

-- Permission grants with validity window
CREATE TABLE IF NOT EXISTS public.user_permission_grants (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    valid_from TIMESTAMPTZ DEFAULT NOW(),
    valid_until TIMESTAMPTZ NULL,
    granted_by_user_id INTEGER NOT NULL REFERENCES public.users(id),
    revoked_at TIMESTAMPTZ NULL,
    revoked_by_user_id INTEGER NULL REFERENCES public.users(id),
    revoke_reason TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_permission_grants_user_id
    ON public.user_permission_grants (user_id);
CREATE INDEX IF NOT EXISTS idx_user_permission_grants_permission
    ON public.user_permission_grants (permission);
CREATE INDEX IF NOT EXISTS idx_user_permission_grants_valid_until
    ON public.user_permission_grants (valid_until);
CREATE INDEX IF NOT EXISTS idx_user_permission_grants_revoked_at
    ON public.user_permission_grants (revoked_at);

-- Audit log extensions (append-only)
ALTER TABLE public.audit_log
ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE public.audit_log
ADD COLUMN IF NOT EXISTS actor_user_id INTEGER;
ALTER TABLE public.audit_log
ADD COLUMN IF NOT EXISTS target_user_id INTEGER;
ALTER TABLE public.audit_log
ADD COLUMN IF NOT EXISTS details_json JSONB;
ALTER TABLE public.audit_log
ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE public.audit_log
ADD COLUMN IF NOT EXISTS ip TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON public.audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_target
    ON public.audit_log (target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON public.audit_log (action);

-- Backfill actor_user_id + ts for existing rows
UPDATE public.audit_log
SET actor_user_id = user_id
WHERE actor_user_id IS NULL AND user_id IS NOT NULL;

UPDATE public.audit_log
SET ts = created_at
WHERE ts IS NULL AND created_at IS NOT NULL;
