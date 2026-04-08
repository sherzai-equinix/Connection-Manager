-- import_jobs.sql
-- Optional: Du kannst dieses SQL ausführen. Die App versucht es aber auch automatisch zu erstellen.

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id bigserial PRIMARY KEY,
  kw integer NOT NULL,
  mode text NOT NULL,
  file_name text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.cross_connects
  ADD COLUMN IF NOT EXISTS job_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_cross_connects_job') THEN
    ALTER TABLE public.cross_connects
      ADD CONSTRAINT fk_cross_connects_job
      FOREIGN KEY (job_id) REFERENCES public.import_jobs(id)
      ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_import_jobs_kw_mode ON public.import_jobs (kw, mode, created_at);
CREATE INDEX IF NOT EXISTS idx_cross_connects_job_id ON public.cross_connects (job_id);
