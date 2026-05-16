-- 098_quote_import_metadata.sql
--
-- Add a JSONB column on public.quote for renewal-pack import metadata:
--   • source            — e.g. "renewal_pack_import"
--   • source_filename   — original .xlsx filename
--   • imported_by       — user id (string) from x-user-id
--   • imported_at       — ISO timestamp string
--   • field_confidence  — { "<dotted.path>": 0..1 } per-field confidence
--   • warnings          — string[] surfaced from parser/extractor/mapper
--   • unmatched_cresta  — string[] of zone names that didn't resolve
--
-- Defaulting to NULL keeps existing quote rows unchanged (no rewrites).
-- Wizards / list views can ignore the column; the renewal-pack reviewer
-- UI reads it to render provenance + low-confidence highlights.

ALTER TABLE public.quote
  ADD COLUMN IF NOT EXISTS import_metadata JSONB DEFAULT NULL;

-- Partial index — only the rows actually populated by an import incur
-- index cost. Lets the renewal-pack reviewer list ("show me imports
-- needing review") stay fast as the quote table grows.
CREATE INDEX IF NOT EXISTS idx_quote_import_metadata_source
  ON public.quote ((import_metadata->>'source'))
  WHERE import_metadata IS NOT NULL;
