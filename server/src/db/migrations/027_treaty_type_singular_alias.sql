-- 027: Create treaty_type (singular) as the canonical table,
--      migrate data from treaty_types (plural) if needed,
--      and fix the FK on contract and quote tables.

-- Step 1: Create the singular table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.treaty_type (
  treaty_type_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  treaty_type     TEXT NOT NULL,
  category        TEXT DEFAULT 'PROPORTIONAL',
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.treaty_type
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Step 2: Unique constraint
DO $$ BEGIN
  ALTER TABLE public.treaty_type ADD CONSTRAINT treaty_type_unique UNIQUE (treaty_type);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Step 3: Seed from treaty_types (plural) if it exists and has data
DO $$ BEGIN
  INSERT INTO public.treaty_type (treaty_type_id, treaty_type, category, is_active, created_at)
  SELECT treaty_type_id, treaty_type, category, is_active, created_at
  FROM public.treaty_types
  WHERE NOT EXISTS (
    SELECT 1 FROM public.treaty_type t2 WHERE t2.treaty_type = treaty_types.treaty_type
  );
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Step 4: Seed canonical types directly (idempotent)
INSERT INTO public.treaty_type (treaty_type, category)
SELECT * FROM (VALUES
  ('Quota Share',            'PROPORTIONAL'),
  ('Quota Share & Surplus',  'PROPORTIONAL'),
  ('First Surplus',          'PROPORTIONAL'),
  ('Second Surplus',         'PROPORTIONAL'),
  ('Third Surplus',          'PROPORTIONAL'),
  ('Fac Oblig',              'PROPORTIONAL'),
  ('Cat XL',                 'NON_PROPORTIONAL'),
  ('Per Risk XL',            'NON_PROPORTIONAL'),
  ('Agg XL',                 'NON_PROPORTIONAL'),
  ('Fac XL',                 'NON_PROPORTIONAL'),
  ('Stop Loss',              'NON_PROPORTIONAL'),
  ('Industry Loss Warranty', 'NON_PROPORTIONAL')
) AS v(tt, cat)
WHERE NOT EXISTS (SELECT 1 FROM public.treaty_type WHERE treaty_type = v.tt);

-- Step 5: Add treaty_type_id column to contract if missing (nullable first)
DO $$ BEGIN
  ALTER TABLE public.contract ADD COLUMN IF NOT EXISTS treaty_type_id UUID;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Step 6: If contract.treaty_type_id references the old plural table via FK,
--         drop that FK and re-add it pointing to the singular table.
DO $$ BEGIN
  ALTER TABLE public.contract DROP CONSTRAINT IF EXISTS contract_treaty_type_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.contract
    ADD CONSTRAINT contract_treaty_type_id_fkey
    FOREIGN KEY (treaty_type_id) REFERENCES public.treaty_type(treaty_type_id)
    ON DELETE SET NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Step 7: Same for quote table
DO $$ BEGIN
  ALTER TABLE public.quote ADD COLUMN IF NOT EXISTS treaty_type_id UUID;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.quote DROP CONSTRAINT IF EXISTS quote_treaty_type_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.quote
    ADD CONSTRAINT quote_treaty_type_id_fkey
    FOREIGN KEY (treaty_type_id) REFERENCES public.treaty_type(treaty_type_id)
    ON DELETE SET NULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
