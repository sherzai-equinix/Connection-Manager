-- Optional migration (run as table owner) to separate Product ID and Serial Number
ALTER TABLE public.cross_connects
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS serial_number text;

-- Backfill product_id from legacy field (serial) if needed
UPDATE public.cross_connects
SET product_id = COALESCE(product_id, serial)
WHERE product_id IS NULL AND serial IS NOT NULL;
