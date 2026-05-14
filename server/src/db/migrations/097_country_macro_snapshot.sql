-- 097_country_macro_snapshot.sql
-- Cache table for IMF + World Bank macro indicators (population, GDP,
-- GDP per capita, inflation, etc.) — backs the Macro Snapshot section
-- of the market intelligence modal.
--
-- One row per (country, source). `payload` is the normalised snapshot
-- the API returns; `expires_at` drives the 30-day TTL. Any missed
-- cache forces a fresh fetch via the upstream provider.

CREATE TABLE IF NOT EXISTS public.country_macro_snapshot (
  snapshot_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id   uuid NOT NULL REFERENCES public.country(country_id) ON DELETE CASCADE,
  source       text NOT NULL,             -- 'WORLD_BANK' | 'IMF'
  payload      jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT country_macro_snapshot_source_chk
    CHECK (source IN ('WORLD_BANK','IMF'))
);

-- Lookup is always (country, source); plus we want the freshest row
-- when there's a soft history left around.
CREATE INDEX IF NOT EXISTS idx_country_macro_snapshot_lookup
  ON public.country_macro_snapshot (country_id, source, fetched_at DESC);
