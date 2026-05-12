-- 063_cresta_slice_uniqueness.sql
-- CRESTA aggregates: enforce slice uniqueness so concurrent saves can't
-- double-write rows.
--
-- The application persists CRESTA via DELETE-then-INSERT inside a single
-- transaction, predicated on (contract_id, treaty_type, cob_id, country_id).
-- Two simultaneous PUTs from different tabs both DELETE under MVCC, both
-- see no rows, then both INSERT — leaving the slice with double rows.
--
-- Defenses, in order:
--   1. Dedupe any rows that already collide, keeping the lexically larger
--      cresta_id (UUIDs sort consistently). This is rare in production
--      but a one-time backfill is harmless.
--   2. Add a UNIQUE INDEX on the slice tuple (cob_id and country_id may
--      be NULL, so use COALESCE-on-text expressions to make NULLs collide
--      the way the app expects).
--   3. Add a covering index for the DELETE+SELECT path.
--
-- The route handlers also take a per-slice pg_advisory_xact_lock to
-- serialize concurrent saves cleanly without relying on retry on
-- unique-violation.

-- ── contract_cresta_data ──
-- NOTE: original ship referenced "a.id < b.id" but the PK is cresta_id;
-- 068_cresta_contract_dedup_fix.sql repairs installs that ran the buggy
-- version. Corrected here so fresh installs are clean on first run.
DELETE FROM public.contract_cresta_data a
USING public.contract_cresta_data b
WHERE a.contract_id = b.contract_id
  AND COALESCE(a.treaty_type, '')      = COALESCE(b.treaty_type, '')
  AND COALESCE(a.cob_id::text, '')     = COALESCE(b.cob_id::text, '')
  AND COALESCE(a.country_id::text, '') = COALESCE(b.country_id::text, '')
  AND COALESCE(a.zone_id, '')          = COALESCE(b.zone_id, '')
  AND a.cresta_id < b.cresta_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_cresta_slice
  ON public.contract_cresta_data (
    contract_id,
    COALESCE(treaty_type, ''),
    COALESCE(cob_id::text, ''),
    COALESCE(country_id::text, ''),
    COALESCE(zone_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_cresta_slice_lookup
  ON public.contract_cresta_data (contract_id, treaty_type, cob_id, country_id);

-- ── quote_cresta_data ──
DELETE FROM public.quote_cresta_data a
USING public.quote_cresta_data b
WHERE a.quote_id = b.quote_id
  AND COALESCE(a.treaty_type, '')      = COALESCE(b.treaty_type, '')
  AND COALESCE(a.cob_id::text, '')     = COALESCE(b.cob_id::text, '')
  AND COALESCE(a.country_id::text, '') = COALESCE(b.country_id::text, '')
  AND COALESCE(a.zone_id, '')          = COALESCE(b.zone_id, '')
  AND a.cresta_id < b.cresta_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_cresta_slice
  ON public.quote_cresta_data (
    quote_id,
    COALESCE(treaty_type, ''),
    COALESCE(cob_id::text, ''),
    COALESCE(country_id::text, ''),
    COALESCE(zone_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_quote_cresta_slice_lookup
  ON public.quote_cresta_data (quote_id, treaty_type, cob_id, country_id);
