-- 018: Add inception_date to public.quote table
-- Required for NP quote workflow to persist treaty inception date
-- (Column already exists in live DB from dump; this is a safe no-op guard)

DO $$ BEGIN
  ALTER TABLE public.quote ADD COLUMN IF NOT EXISTS inception_date DATE;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
