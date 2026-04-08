-- Ensure role column has default and is not null.
UPDATE public.users
SET role = 'viewer'
WHERE role IS NULL OR role = '';

ALTER TABLE public.users
ALTER COLUMN role SET DEFAULT 'viewer';

ALTER TABLE public.users
ALTER COLUMN role SET NOT NULL;
