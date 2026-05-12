-- 069_cresta_contract_align_with_quote.sql
-- Align contract_cresta_data with quote_cresta_data so the two tables
-- have identical column shapes. The save helper (lib/crestaSave.js) and
-- the unique slice index (064/068) treat them symmetrically — the schema
-- divergence is a leftover from when the contract side was authored
-- against a stricter assumption that turned out not to hold.
--
-- 1. country_id: drop NOT NULL.
--    The validator (validation/cresta.js) declares country_id as
--    optionalUuid, the save helper (lib/crestaSave.js:72) inserts NULL
--    when no countryId is supplied, and the unique index uses
--    COALESCE(country_id::text, '') to make NULLs collide. quote_cresta_data
--    has been nullable since 000_core_schema — contract_cresta_data was the
--    outlier. Any contract row inserted without a country_id would have
--    failed — matching the quote side prevents the surprise.
--
-- 2. updated_at: add the column with the same default the quote side has.
--    Save logic is DELETE-then-INSERT so updated_at == created_at on
--    every row, but the column needs to exist for symmetric SELECT *
--    reads and to keep diff tooling happy.

ALTER TABLE public.contract_cresta_data
  ALTER COLUMN country_id DROP NOT NULL;

ALTER TABLE public.contract_cresta_data
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
