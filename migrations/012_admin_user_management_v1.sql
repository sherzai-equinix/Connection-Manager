-- V1 Admin / User Management enhancements
-- Adds full_name, email, force_password_change, last_login to users table.

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS full_name TEXT;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

-- Ensure is_active column exists with proper default
ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Index on username for fast lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users (username);
CREATE INDEX IF NOT EXISTS idx_users_is_active ON public.users (is_active);
