-- Migration 038: Patch column gaps for existing installs (safe no-ops on clean installs)

-- ── triangle_type enum: ensure exists ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='triangle_type' AND typnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')) THEN
    CREATE TYPE public.triangle_type AS ENUM ('PREMIUM','CLAIMS_PAID','CLAIMS_OS','INCURRED');
  END IF;
END $$;

-- ── contract_triangle_cells: convert type TEXT -> enum if needed ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_triangle_cells' AND column_name='type' AND data_type='text') THEN
    ALTER TABLE public.contract_triangle_cells ALTER COLUMN type TYPE public.triangle_type USING type::public.triangle_type;
  END IF;
END $$;

-- ── contract_class_of_business: rename class_id -> class_of_business_id ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_class_of_business' AND column_name='class_id')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_class_of_business' AND column_name='class_of_business_id') THEN
    ALTER TABLE public.contract_class_of_business RENAME COLUMN class_id TO class_of_business_id;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_class_of_business' AND column_name='class_id')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_class_of_business' AND column_name='class_of_business_id') THEN
    ALTER TABLE public.quote_class_of_business RENAME COLUMN class_id TO class_of_business_id;
  END IF;
END $$;

-- ── contract_epi_split: rename cob_id -> class_of_business_id ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_epi_split' AND column_name='cob_id')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_epi_split' AND column_name='class_of_business_id') THEN
    ALTER TABLE public.contract_epi_split RENAME COLUMN cob_id TO class_of_business_id;
  END IF;
END $$;
ALTER TABLE public.contract_epi_split ADD COLUMN IF NOT EXISTS premium NUMERIC;
ALTER TABLE public.contract_epi_split ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.contract_epi_split ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_epi_split' AND column_name='cob_id')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_epi_split' AND column_name='class_of_business_id') THEN
    ALTER TABLE public.quote_epi_split RENAME COLUMN cob_id TO class_of_business_id;
  END IF;
END $$;
ALTER TABLE public.quote_epi_split ADD COLUMN IF NOT EXISTS premium NUMERIC;
ALTER TABLE public.quote_epi_split ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.quote_epi_split ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ── contract_underwriting_limit: add missing columns ──
ALTER TABLE public.contract_underwriting_limit ADD COLUMN IF NOT EXISTS class_of_business_id UUID;
ALTER TABLE public.contract_underwriting_limit ADD COLUMN IF NOT EXISTS limit_amount NUMERIC;
ALTER TABLE public.contract_underwriting_limit ADD COLUMN IF NOT EXISTS basis TEXT;
ALTER TABLE public.contract_underwriting_limit ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE public.quote_underwriting_limit ADD COLUMN IF NOT EXISTS class_of_business_id UUID;
ALTER TABLE public.quote_underwriting_limit ADD COLUMN IF NOT EXISTS limit_amount NUMERIC;
ALTER TABLE public.quote_underwriting_limit ADD COLUMN IF NOT EXISTS basis TEXT;
ALTER TABLE public.quote_underwriting_limit ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- ── contract_document: rename columns ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_document' AND column_name='filename')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_document' AND column_name='file_name') THEN
    ALTER TABLE public.contract_document RENAME COLUMN filename TO file_name;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_document' AND column_name='mimetype')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_document' AND column_name='mime_type') THEN
    ALTER TABLE public.contract_document RENAME COLUMN mimetype TO mime_type;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_document' AND column_name='filesize')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_document' AND column_name='size_bytes') THEN
    ALTER TABLE public.contract_document RENAME COLUMN filesize TO size_bytes;
  END IF;
END $$;
ALTER TABLE public.contract_document ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE public.contract_document ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ DEFAULT now();

-- ── contract_loss_participation: add missing columns + unique constraint ──
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS lp_id UUID DEFAULT gen_random_uuid();
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT false;
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS min_loss_ratio_pct NUMERIC(5,2);
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS max_loss_ratio_pct NUMERIC(5,2);
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS reinsurer_share_pct NUMERIC(5,2);
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contract_loss_participation_contract_id_key') THEN
    ALTER TABLE public.contract_loss_participation ADD CONSTRAINT contract_loss_participation_contract_id_key UNIQUE (contract_id);
  END IF;
END $$;

ALTER TABLE public.quote_loss_participation ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT false;
ALTER TABLE public.quote_loss_participation ADD COLUMN IF NOT EXISTS min_loss_ratio_pct NUMERIC(5,2);
ALTER TABLE public.quote_loss_participation ADD COLUMN IF NOT EXISTS max_loss_ratio_pct NUMERIC(5,2);
ALTER TABLE public.quote_loss_participation ADD COLUMN IF NOT EXISTS reinsurer_share_pct NUMERIC(5,2);
ALTER TABLE public.quote_loss_participation ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quote_loss_participation_quote_id_key') THEN
    ALTER TABLE public.quote_loss_participation ADD CONSTRAINT quote_loss_participation_quote_id_key UNIQUE (quote_id);
  END IF;
END $$;