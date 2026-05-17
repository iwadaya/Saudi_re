-- 100_import_jobs_snapshots_treaty_side.sql
--
-- Extend renewal-pack import infrastructure to support contract-owned
-- entities, not just quotes. Three table changes:
--
--   1. import_jobs:        gain a nullable contract_id; quote_id becomes
--                          nullable; exactly one of the two must be set.
--   2. import_snapshots:   same shape change.
--   3. contract:           gain an import_metadata jsonb column matching
--                          quote.import_metadata (added in migration 098).
--
-- The exclusive-ownership pattern (CHECK num_nonnulls = 1) mirrors how
-- contract_document and the *_loss_report tables are structured — a
-- single row belongs to either a treaty or a quote, never both.
--
-- All existing rows have quote_id set, so the constraint is trivially
-- satisfied for them; we add it NOT VALID to skip the legacy scan and
-- validate it lazily.

ALTER TABLE public.import_jobs
  ALTER COLUMN quote_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES public.contract(contract_id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_import_jobs_single_owner'
      AND conrelid = 'public.import_jobs'::regclass
  ) THEN
    ALTER TABLE public.import_jobs
      ADD CONSTRAINT chk_import_jobs_single_owner
      CHECK (num_nonnulls(quote_id, contract_id) = 1) NOT VALID;
  END IF;
END $$;

-- Re-key the "one in-flight import per entity" guarantee. The old
-- partial index was per-quote; we need a parallel one per-contract.
DROP INDEX IF EXISTS public.uq_import_jobs_one_processing_per_quote;
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_jobs_one_processing_per_quote
  ON public.import_jobs (quote_id)
  WHERE status = 'processing' AND quote_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_jobs_one_processing_per_contract
  ON public.import_jobs (contract_id)
  WHERE status = 'processing' AND contract_id IS NOT NULL;

-- Lookup pattern symmetric to the quote-side index.
CREATE INDEX IF NOT EXISTS idx_import_jobs_contract_started
  ON public.import_jobs (contract_id, started_at DESC)
  WHERE contract_id IS NOT NULL;

ALTER TABLE public.import_snapshots
  ALTER COLUMN quote_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS contract_id uuid REFERENCES public.contract(contract_id) ON DELETE CASCADE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_import_snapshots_single_owner'
      AND conrelid = 'public.import_snapshots'::regclass
  ) THEN
    ALTER TABLE public.import_snapshots
      ADD CONSTRAINT chk_import_snapshots_single_owner
      CHECK (num_nonnulls(quote_id, contract_id) = 1) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_import_snapshots_contract_captured
  ON public.import_snapshots (contract_id, captured_at DESC)
  WHERE contract_id IS NOT NULL;

-- contract.import_metadata mirrors quote.import_metadata from migration
-- 098 so the same provenance fields (source filename, low-confidence
-- field map, warnings, etc.) are queryable on either entity.
ALTER TABLE public.contract
  ADD COLUMN IF NOT EXISTS import_metadata JSONB DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_import_metadata_source
  ON public.contract ((import_metadata->>'source'))
  WHERE import_metadata IS NOT NULL;
