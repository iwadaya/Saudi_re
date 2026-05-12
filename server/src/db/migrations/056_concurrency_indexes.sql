-- 056_concurrency_indexes.sql
-- Indexes to support pagination + filter patterns exposed by the
-- updated list endpoints (GET /api/quotes, /api/treaties), and the
-- optimistic-lock updated_at lookup added in the same series of changes.
-- All are CREATE INDEX IF NOT EXISTS so re-running is safe.

-- ── quote: updated_at for ORDER BY DESC on /quotes list ──────────────
CREATE INDEX IF NOT EXISTS idx_quote_updated_at
  ON public.quote (updated_at DESC);

-- ── quote: filter combos from /quotes query params ───────────────────
CREATE INDEX IF NOT EXISTS idx_quote_status
  ON public.quote (status);

CREATE INDEX IF NOT EXISTS idx_quote_cedant_id
  ON public.quote (cedant_id)
  WHERE cedant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quote_uw_year
  ON public.quote (uw_year);

-- Common combo — status + year filter on dashboards
CREATE INDEX IF NOT EXISTS idx_quote_status_uw_year
  ON public.quote (status, uw_year);

-- ── quote + contract: user-assigned filters on home screen ───────────
CREATE INDEX IF NOT EXISTS idx_quote_assigned_to_user_id
  ON public.quote (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quote_created_by_user_id
  ON public.quote (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_assigned_to_user_id
  ON public.contract (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_created_by_user_id
  ON public.contract (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

-- ── contract: filter by cedant + country used in /treaties list ──────
CREATE INDEX IF NOT EXISTS idx_contract_cedant_id
  ON public.contract (cedant_id)
  WHERE cedant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_country_id
  ON public.contract (country_id)
  WHERE country_id IS NOT NULL;

-- ── audit trail reads on contract detail ─────────────────────────────
-- These pages query contract_audit_event by contract_id ORDER BY created_at DESC
-- on every load. A covering index closes that loop.
CREATE INDEX IF NOT EXISTS idx_contract_audit_event_contract_created
  ON public.contract_audit_event (contract_id, created_at DESC);

-- audit_log (non-contract entities) — same pattern
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_created
  ON public.audit_log (entity_type, entity_id, created_at DESC);

-- ── approvals queue: eligible-approvers + trail reads ─────────────────
-- Only create if the table exists (migrations may have created it conditionally)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='contract_offer') THEN
    CREATE INDEX IF NOT EXISTS idx_contract_offer_status
      ON public.contract_offer (status)
      WHERE status IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_contract_offer_next_approver
      ON public.contract_offer (next_approver)
      WHERE next_approver IS NOT NULL;
  END IF;
END $$;
