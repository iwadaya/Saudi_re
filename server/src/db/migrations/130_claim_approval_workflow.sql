-- 130_claim_approval_workflow.sql
-- Claims approval workflow + dashboard.
--
-- Every claim now carries an approval_status alongside its lifecycle status:
--   DRAFT             — being worked up by the handler (default on create).
--   WAITING_APPROVAL  — submitted for review; the claim is frozen (no edits,
--                       movements, or lifecycle changes) until reviewed.
--   REJECTED          — reviewer rejected it; handler revises and resubmits.
--   FINALISED         — reviewer approved it.
-- The lifecycle status (OPEN/REOPENED/CLOSED/DECLINED) keeps tracking the
-- real-world claim; approval_status tracks the internal review workflow.
--
-- Backfill maps the pre-workflow book: CLOSED → FINALISED, DECLINED →
-- REJECTED, everything else starts back at DRAFT.

ALTER TABLE public.claim
  ADD COLUMN IF NOT EXISTS approval_status      text NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS submitted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS reviewed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id  uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS review_comment       text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'claim'
      AND con.conname = 'claim_approval_status_check'
  ) THEN
    ALTER TABLE public.claim
      ADD CONSTRAINT claim_approval_status_check
      CHECK (approval_status IN ('DRAFT','WAITING_APPROVAL','REJECTED','FINALISED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_claim_approval_status ON public.claim(approval_status);

-- Backfill claims that predate the workflow.
UPDATE public.claim
   SET approval_status = CASE status
                           WHEN 'CLOSED'   THEN 'FINALISED'
                           WHEN 'DECLINED' THEN 'REJECTED'
                           ELSE 'DRAFT'
                         END
 WHERE approval_status = 'DRAFT'
   AND status IN ('CLOSED','DECLINED');
