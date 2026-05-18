-- 103_consolidate_awaiting_approval.sql
--
-- Consolidate the two spellings of the "awaiting approval" state into
-- one. Pre-103 the codebase carried both:
--   - contract_status enum:        AWAITING_APPROVAL
--   - uw_workflow_status enum:     WAITING_APPROVAL (with AWAITING_APPROVAL
--                                  added later by migration 040)
-- which forced every layer to map between the two and produced subtle
-- bugs (e.g. the uwStatusMap fallback in approvals.js). Going forward
-- AWAITING_APPROVAL is the single canonical value on both enums.
--
-- Backfill any rows still on the old spelling. Indexes and code paths
-- that referenced WAITING_APPROVAL get rebuilt against AWAITING_APPROVAL.
-- The WAITING_APPROVAL enum value is left in uw_workflow_status because
-- Postgres can't drop an enum value without recreating the type — and
-- nothing writes it anymore, so it's harmless.

UPDATE public.contract
   SET uw_status = 'AWAITING_APPROVAL'::public.uw_workflow_status,
       updated_at = now()
 WHERE uw_status::text = 'WAITING_APPROVAL';

UPDATE public.quote
   SET uw_status = 'AWAITING_APPROVAL',
       updated_at = now()
 WHERE uw_status = 'WAITING_APPROVAL';

-- Replace migration 042's partial index. The old predicate keyed on the
-- now-unused WAITING_APPROVAL spelling, so it would no longer match any
-- rows after the backfill above.
DROP INDEX IF EXISTS public.idx_contract_status_waiting;

CREATE INDEX IF NOT EXISTS idx_contract_status_awaiting_approval
  ON public.contract (uw_status)
  WHERE uw_status = 'AWAITING_APPROVAL';
