-- 067_cresta_contract_dedup_fix.sql
-- Repair migration for 064_cresta_slice_uniqueness.sql.
--
-- 064's contract_cresta_data dedup statement referenced "a.id < b.id",
-- but on every install where 000_core_schema.sql ran first the table's
-- primary key is "cresta_id" (uuid) — there is no "id" column. The
-- migration runner swallows non-fatal errors per statement, so the
-- dedup silently failed and was recorded as applied. If pre-existing
-- duplicates were present, the follow-up CREATE UNIQUE INDEX in 064
-- also failed (and was swallowed), leaving the slice unprotected.
--
-- This migration:
--   1. Re-runs the dedup with the correct PK column (cresta_id).
--   2. Re-creates the unique index (IF NOT EXISTS — no-op when 064
--      succeeded). On installs where 064's CREATE UNIQUE INDEX failed,
--      this is the second chance, now that the dedup is real.
--   3. Re-creates the lookup index for the DELETE+SELECT path (also
--      idempotent).
--
-- quote_cresta_data was unaffected (064 used cresta_id correctly there)
-- so no quote-side repair is needed.

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
