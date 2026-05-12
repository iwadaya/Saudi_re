-- Migration 042: Production scale indexes for 1,000 treaties / 10 concurrent UWs
-- All use IF NOT EXISTS — fully idempotent, safe to run multiple times

-- ── contract: core lookup patterns ────────────────────────────────────────

-- Home screen: WHERE uw_status != 'DRAFT' ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_contract_cedant_id
  ON public.contract (cedant_id)
  WHERE cedant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_assigned_status
  ON public.contract (assigned_to_user_id, uw_status, updated_at DESC)
  WHERE assigned_to_user_id IS NOT NULL;

-- Approvals screen: WHERE uw_status = 'WAITING_APPROVAL'
CREATE INDEX IF NOT EXISTS idx_contract_status_waiting
  ON public.contract (uw_status)
  WHERE uw_status = 'WAITING_APPROVAL';

-- Country + renewal date for upcoming renewals panel
CREATE INDEX IF NOT EXISTS idx_contract_renewal_date
  ON public.contract (renewal_date)
  WHERE renewal_date IS NOT NULL;

-- Renewal chain: parent_contract_id lookup
CREATE INDEX IF NOT EXISTS idx_contract_parent
  ON public.contract (parent_contract_id)
  WHERE parent_contract_id IS NOT NULL;

-- ── treaty_type: joined on almost every contract query ────────────────────
CREATE INDEX IF NOT EXISTS idx_treaty_type_id
  ON public.treaty_type (treaty_type_id);

-- ── contract_class_of_business: used in cedant limits + COB checks ────────
CREATE INDEX IF NOT EXISTS idx_ccob_contract
  ON public.contract_class_of_business (contract_id);

CREATE INDEX IF NOT EXISTS idx_ccob_cob
  ON public.contract_class_of_business (class_of_business_id);

-- ── contract_np_layers: queried per contract for structure/limits ──────────
CREATE INDEX IF NOT EXISTS idx_np_layers_contract
  ON public.contract_np_layers (contract_id, layer_number);

-- ── contract_np_details: queried by has_np_details subquery ──────────────
CREATE INDEX IF NOT EXISTS idx_np_details_contract
  ON public.contract_np_details (contract_id);

-- ── contract_prop_details ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_prop_details_contract
  ON public.contract_prop_details (contract_id);

-- ── contract_cresta_data: country aggregate queries ───────────────────────
CREATE INDEX IF NOT EXISTS idx_cresta_contract
  ON public.contract_cresta_data (contract_id);

CREATE INDEX IF NOT EXISTS idx_cresta_country
  ON public.contract_cresta_data (country_id);

-- ── contract_np_terms / contract_np_pricing_* ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_np_terms_contract
  ON public.contract_np_terms (contract_id);

-- ── contract_audit_event: approval trail queries ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_contract_type
  ON public.contract_audit_event (contract_id, event_type, created_at DESC)
  WHERE contract_id IS NOT NULL;

-- ── contract_document: doc listing per contract ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_document_contract
  ON public.contract_document (contract_id, uploaded_at DESC);

-- ── contract_offer: latest offer per contract ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_offer_contract_status
  ON public.contract_offer (contract_id, status);

-- ── contract_straight_experience / uw_stats ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_straight_exp_contract
  ON public.contract_straight_experience (contract_id);

-- Defensive: contract_id was added to the loss tables out-of-band in prod
-- and never written into a migration. Fresh DBs lack the column, so the
-- two indexes below would fail. Add it idempotently before indexing.
ALTER TABLE public.contract_large_losses ADD COLUMN IF NOT EXISTS contract_id uuid;
ALTER TABLE public.contract_cat_losses   ADD COLUMN IF NOT EXISTS contract_id uuid;


-- ── large/cat losses ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_large_loss_contract
  ON public.contract_large_losses (contract_id);

CREATE INDEX IF NOT EXISTS idx_cat_loss_contract
  ON public.contract_cat_losses (contract_id)
  WHERE contract_id IS NOT NULL;

-- ── companies (cedant lookup in home/approvals joins) ─────────────────────
CREATE INDEX IF NOT EXISTS idx_companies_id
  ON public.companies (company_id);

-- ── country ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_country_id
  ON public.country (country_id);

