-- 128_fac_document_meta.sql
-- Treaty-style document management for facultative risks.
--
-- The treaty Documents screen (DocumentsScreen.jsx → contract_document)
-- captures a human Title + Description on upload and lets the user
-- View / Download the stored file. The fac Documents tab only stored the
-- AI document_kind. Bring the fac_document table to parity by adding the
-- same two metadata columns so the fac uploader can persist them
-- alongside the existing AI ingestion fields.

ALTER TABLE public.fac_document
  ADD COLUMN IF NOT EXISTS title       text,
  ADD COLUMN IF NOT EXISTS description text;
