-- 131_claim_documents.sql
-- Claim attachments. Mirrors contract_document but claim-owned: cedant advice
-- emails, loss adjuster reports, bordereaux extracts, settlement proofs.
-- Storage strategy is the shared lib/uploadStorage.js sink (Cloudinary when
-- configured, local disk otherwise); this table only records the pointer.

CREATE TABLE IF NOT EXISTS public.claim_document (
  document_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            uuid NOT NULL REFERENCES public.claim(claim_id) ON DELETE CASCADE,
  file_name           text NOT NULL,
  mime_type           text,
  size_bytes          bigint,
  storage_path        text NOT NULL,
  title               text,
  description         text,
  uploaded_by_user_id uuid REFERENCES public.uw_user(user_id),
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_document_claim ON public.claim_document(claim_id);
