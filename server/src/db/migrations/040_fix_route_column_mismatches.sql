-- Migration 040: Add columns required by routes but missing from dump schema

-- ── quote_pricing_outputs: add missing output columns ──
ALTER TABLE public.quote_pricing_outputs ADD COLUMN IF NOT EXISTS combined_ratio    NUMERIC;
ALTER TABLE public.quote_pricing_outputs ADD COLUMN IF NOT EXISTS loss_ratio        NUMERIC;
ALTER TABLE public.quote_pricing_outputs ADD COLUMN IF NOT EXISTS expense_ratio     NUMERIC;
ALTER TABLE public.quote_pricing_outputs ADD COLUMN IF NOT EXISTS technical_price   NUMERIC;
ALTER TABLE public.quote_pricing_outputs ADD COLUMN IF NOT EXISTS uw_price          NUMERIC;
ALTER TABLE public.quote_pricing_outputs ADD COLUMN IF NOT EXISTS margin            NUMERIC;

-- ── quote_pricing_yearly: add columns used by routes ──
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS premium          NUMERIC;
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS paid_claims       NUMERIC;
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS os_claims         NUMERIC;
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS incurred_claims   NUMERIC;
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS commission        NUMERIC;
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS brokerage         NUMERIC;
ALTER TABLE public.quote_pricing_yearly ADD COLUMN IF NOT EXISTS net_result        NUMERIC;

-- ── contract_pricing_outputs: add missing margin columns ──
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS actuarial_margin NUMERIC;
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS actual_margin    NUMERIC;

-- ── quote_offer: add signed_line_pct ──
ALTER TABLE public.quote_offer ADD COLUMN IF NOT EXISTS signed_line_pct NUMERIC(10,6);

-- ── quote_risk_profile: add curve columns ──
ALTER TABLE public.quote_risk_profile ADD COLUMN IF NOT EXISTS selected_curve TEXT;
ALTER TABLE public.quote_risk_profile ADD COLUMN IF NOT EXISTS custom_b       NUMERIC;
ALTER TABLE public.quote_risk_profile ADD COLUMN IF NOT EXISTS custom_g       NUMERIC;

-- ── quote_claims_profile: same ──
ALTER TABLE public.quote_claims_profile ADD COLUMN IF NOT EXISTS selected_curve TEXT;
ALTER TABLE public.quote_claims_profile ADD COLUMN IF NOT EXISTS custom_b       NUMERIC;
ALTER TABLE public.quote_claims_profile ADD COLUMN IF NOT EXISTS custom_g       NUMERIC;

-- ── contract_event_loss_tables: add 'data' alias for elt_data ──
ALTER TABLE public.contract_event_loss_tables ADD COLUMN IF NOT EXISTS data JSONB;
UPDATE public.contract_event_loss_tables SET data = elt_data WHERE data IS NULL AND elt_data IS NOT NULL;

-- ── contract_loss_selection_snapshot (quotes.js old format): add legacy columns ──
ALTER TABLE public.contract_loss_selection_snapshot ADD COLUMN IF NOT EXISTS snapshot_date TIMESTAMPTZ DEFAULT now();
ALTER TABLE public.contract_loss_selection_snapshot ADD COLUMN IF NOT EXISTS xm            NUMERIC;
ALTER TABLE public.contract_loss_selection_snapshot ADD COLUMN IF NOT EXISTS limit_amt     NUMERIC;
ALTER TABLE public.contract_loss_selection_snapshot ADD COLUMN IF NOT EXISTS distribution  TEXT;
ALTER TABLE public.contract_loss_selection_snapshot ADD COLUMN IF NOT EXISTS years_override INT;

-- ── contract_loss_selection_snapshot_item (quotes.js old format) ──
ALTER TABLE public.contract_loss_selection_snapshot_item ADD COLUMN IF NOT EXISTS loss_id       UUID;
ALTER TABLE public.contract_loss_selection_snapshot_item ADD COLUMN IF NOT EXISTS original_loss  NUMERIC;
ALTER TABLE public.contract_loss_selection_snapshot_item ADD COLUMN IF NOT EXISTS inflated_loss  NUMERIC;
ALTER TABLE public.contract_loss_selection_snapshot_item ADD COLUMN IF NOT EXISTS is_selected    BOOLEAN DEFAULT true;
ALTER TABLE public.contract_loss_selection_snapshot_item ADD COLUMN IF NOT EXISTS note           TEXT;

-- ── triangle_type enum: fix OS_CLAIMS -> CLAIMS_OS and add INCURRED ──
DO $$ BEGIN
  -- Add CLAIMS_OS if missing
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='CLAIMS_OS' AND enumtypid=(SELECT oid FROM pg_type WHERE typname='triangle_type')) THEN
    ALTER TYPE public.triangle_type ADD VALUE IF NOT EXISTS 'CLAIMS_OS';
  END IF;
  -- Add INCURRED if missing
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel='INCURRED' AND enumtypid=(SELECT oid FROM pg_type WHERE typname='triangle_type')) THEN
    ALTER TYPE public.triangle_type ADD VALUE IF NOT EXISTS 'INCURRED';
  END IF;
END $$;

-- ── contract_class_of_business: add missing primary key ──
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='contract_class_of_business'
    AND constraint_type='PRIMARY KEY'
  ) THEN
    ALTER TABLE public.contract_class_of_business
      ADD CONSTRAINT contract_class_of_business_pkey
      PRIMARY KEY (contract_id, class_of_business_id);
  END IF;
END $$;

-- ── contract_offer: add missing approval workflow columns ──
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS quote_id            uuid;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS breach_type         text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS approval_step       integer DEFAULT 1;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS submitted_by_id     uuid;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS submitted_at        timestamptz DEFAULT now();
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS epi_usd             numeric(18,2);
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS next_approver_id    uuid;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS next_approver_role  text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer1_user_id       uuid;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer1_decision      text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer1_comment       text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer1_at            timestamptz;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer2_user_id       uuid;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer2_decision      text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer2_comment       text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS peer2_at            timestamptz;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS updated_at          timestamptz DEFAULT now();
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS offer_line          text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS offer_comment       text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS offer_approver      text;

-- ── contract: add alt_contract_id for external system reference ──
ALTER TABLE public.contract ADD COLUMN IF NOT EXISTS alt_contract_id text;

-- ── contract_loss_participation: add slides JSONB for stepped corridors ──
ALTER TABLE public.contract_loss_participation ADD COLUMN IF NOT EXISTS slides jsonb DEFAULT '[]'::jsonb;

-- ── contract_commissions: add LCF columns ──
ALTER TABLE public.contract_commissions ADD COLUMN IF NOT EXISTS lcf_years      integer;
ALTER TABLE public.contract_commissions ADD COLUMN IF NOT EXISTS lcf_extinction boolean DEFAULT false;

-- ── contract_offer: add missing arbiter + approver_options columns ──
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS arbiter_required  boolean DEFAULT false;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS arbiter_user_id   uuid;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS arbiter_decision  text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS arbiter_comment   text;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS arbiter_at        timestamptz;
ALTER TABLE public.contract_offer ADD COLUMN IF NOT EXISTS approver_options  jsonb;

-- ── Recreate v_offer_approval view with all required columns ──
CREATE OR REPLACE VIEW public.v_offer_approval AS
SELECT
  o.offer_id, o.contract_id, o.quote_id, o.status, o.breach_type, o.approval_step,
  COALESCE(o.arbiter_required, false) AS arbiter_required,
  o.written_line_pct, o.submitted_by_id, o.submitted_at,
  o.peer1_user_id, u1.display_name AS peer1_name, u1r.role_code AS peer1_role_code,
  o.peer1_decision, o.peer1_comment, o.peer1_at,
  o.peer2_user_id, u2.display_name AS peer2_name, u2r.role_code AS peer2_role_code,
  o.peer2_decision, o.peer2_comment, o.peer2_at,
  o.arbiter_user_id, ua.display_name AS arbiter_name, uar.role_code AS arbiter_role_code,
  o.arbiter_decision, o.arbiter_comment, o.arbiter_at,
  us.display_name AS submitted_by_name, usr.role_code AS submitted_by_role,
  o.next_approver_id, o.next_approver_role, un.display_name AS next_approver_name,
  CASE
    WHEN COALESCE(o.arbiter_required,false) AND o.arbiter_decision IS NULL THEN 'DISPUTE_PENDING'
    WHEN o.arbiter_decision = 'APPROVED'  THEN 'FINAL_APPROVED'
    WHEN o.arbiter_decision = 'DECLINED'  THEN 'FINAL_DECLINED'
    WHEN o.peer1_decision IS NULL         THEN 'AWAITING_PEER1'
    WHEN o.peer2_decision IS NULL         THEN 'AWAITING_PEER2'
    WHEN o.peer1_decision = 'APPROVED' AND o.peer2_decision = 'APPROVED' THEN 'FULLY_APPROVED'
    WHEN o.peer1_decision = 'DECLINED' AND o.peer2_decision = 'DECLINED' THEN 'FULLY_DECLINED'
    ELSE 'SPLIT_DECISION'
  END AS approval_stage,
  o.approver_options, o.updated_at
FROM public.contract_offer o
LEFT JOIN public.uw_user u1  ON u1.user_id  = o.peer1_user_id
LEFT JOIN public.uw_role u1r ON u1r.role_id = u1.role_id
LEFT JOIN public.uw_user u2  ON u2.user_id  = o.peer2_user_id
LEFT JOIN public.uw_role u2r ON u2r.role_id = u2.role_id
LEFT JOIN public.uw_user ua  ON ua.user_id  = o.arbiter_user_id
LEFT JOIN public.uw_role uar ON uar.role_id = ua.role_id
LEFT JOIN public.uw_user us  ON us.user_id  = o.submitted_by_id
LEFT JOIN public.uw_role usr ON usr.role_id = us.role_id
LEFT JOIN public.uw_user un  ON un.user_id  = o.next_approver_id;

-- ── uw_user: add missing columns ──
ALTER TABLE public.uw_user ADD COLUMN IF NOT EXISTS username        text;
ALTER TABLE public.uw_user ADD COLUMN IF NOT EXISTS password_hash   text;
ALTER TABLE public.uw_user ADD COLUMN IF NOT EXISTS failed_attempts integer DEFAULT 0;
ALTER TABLE public.uw_user ADD COLUMN IF NOT EXISTS locked_until    timestamptz;
ALTER TABLE public.uw_user ADD COLUMN IF NOT EXISTS office          text;

-- Set username from email where missing
UPDATE public.uw_user SET username = split_part(email,'@',1) WHERE username IS NULL;

-- ── Recreate v_user_mandate with safe fallbacks ──
CREATE OR REPLACE VIEW public.v_user_mandate AS
SELECT
  u.user_id,
  COALESCE(u.username, split_part(u.email,'@',1)) AS username,
  u.display_name,
  u.email,
  COALESCE(u.office, 'Riyadh') AS office,
  u.is_active,
  COALESCE(u.failed_attempts, 0) AS failed_attempts,
  u.locked_until,
  u.password_hash,
  r.role_id,
  r.role_name,
  r.role_code,
  r.hierarchy_level,
  r.can_override_below,
  r.display_order,
  COALESCE(m.treaty_limit_usd, r.authority_limit_usd) AS effective_limit_usd,
  m.single_risk_limit_usd,
  m.limit_currency,
  m.allowed_cob_ids,
  m.restricted_cob_ids,
  m.allowed_country_ids,
  COALESCE(m.treaty_type_scope, 'BOTH')   AS treaty_type_scope,
  COALESCE(m.approvals_required, 1)        AS approvals_required,
  m.effective_from,
  m.effective_to,
  (m.effective_to IS NULL OR m.effective_to >= current_date) AS mandate_active
FROM public.uw_user u
JOIN public.uw_role r ON r.role_id = u.role_id
LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
WHERE u.is_active = true;

-- ── offer_approval_event: create if missing ──
CREATE TABLE IF NOT EXISTS public.offer_approval_event (
  event_id       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id    uuid REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  quote_id       uuid,
  event_type     text NOT NULL,
  actor_user_id  uuid,
  actor_name     text,
  actor_role     text,
  payload        jsonb,
  comment        text,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offer_approval_event_contract ON public.offer_approval_event(contract_id);
CREATE INDEX IF NOT EXISTS idx_offer_approval_event_quote ON public.offer_approval_event(quote_id);

-- ── contract_offer: ensure UNIQUE constraint on contract_id ──
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='contract_offer'
    AND constraint_name='contract_offer_contract_id_key'
  ) THEN
    ALTER TABLE public.contract_offer ADD CONSTRAINT contract_offer_contract_id_key UNIQUE (contract_id);
  END IF;
END $$;

-- ── uw_workflow_status: add missing enum values ──
ALTER TYPE public.uw_workflow_status ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL';
ALTER TYPE public.uw_workflow_status ADD VALUE IF NOT EXISTS 'DISPUTE_PENDING';
ALTER TYPE public.uw_workflow_status ADD VALUE IF NOT EXISTS 'RETURNED';

-- ── contract_pricing_outputs: add uw_margin if missing ──
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS uw_margin numeric(10,6);
