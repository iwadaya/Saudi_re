-- 099_import_jobs_and_snapshots.sql
--
-- Tables for the simplified renewal-pack import (the variant that
-- treats the document type + treaty type as already known and just
-- fills the remaining wizard pages — see services/renewalPack and
-- routes/renewalPackImport.js).
--
--   public.import_jobs
--     One row per import POST. Status moves processing → done|failed
--     in the background; the polling GET reads from here.
--
--   public.import_snapshots
--     Captured BEFORE each import writes, so an underwriter can undo
--     an accidental overwrite of half-completed work. Restorable for
--     30 days; single-use (restored_at flips once and stays set).
--
-- The two are coupled only by import_jobs.snapshot_id (set after the
-- snapshot row is inserted by the worker). No FK there because the
-- snapshot can be deleted by the 30-day cleanup independently of the
-- job's audit value.

CREATE TABLE IF NOT EXISTS public.import_jobs (
  job_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id      uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  document_id   uuid NOT NULL,
  filename      text,
  status        text NOT NULL CHECK (status IN ('processing','done','failed')),
  result        jsonb,
  error_message text,
  snapshot_id   uuid,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- One import in flight per quote at a time. Two concurrent POSTs on
-- the same quote cannot both insert a 'processing' row — the second
-- gets a unique violation, which the route translates to 409
-- IMPORT_IN_PROGRESS.
CREATE UNIQUE INDEX IF NOT EXISTS uq_import_jobs_one_processing_per_quote
  ON public.import_jobs (quote_id) WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_import_jobs_quote_started
  ON public.import_jobs (quote_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.import_snapshots (
  snapshot_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id     uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  job_id       uuid REFERENCES public.import_jobs(job_id) ON DELETE SET NULL,
  filename     text,
  filled_pages text[] NOT NULL DEFAULT ARRAY[]::text[],
  captured_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL,
  restored_at  timestamptz
);

-- Lookup pattern: list snapshots for a quote, newest first (used by
-- GET /api/quotes/:id/import-snapshots and by the cleanup script's
-- per-quote retention sweep).
CREATE INDEX IF NOT EXISTS idx_import_snapshots_quote_captured
  ON public.import_snapshots (quote_id, captured_at DESC);
