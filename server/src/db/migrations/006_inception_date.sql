-- 006: Add inception_date to contract and contract_prop_details

DO $$ BEGIN
  ALTER TABLE public.contract ADD COLUMN IF NOT EXISTS inception_date DATE;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.contract_prop_details ADD COLUMN IF NOT EXISTS inception_date DATE;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
