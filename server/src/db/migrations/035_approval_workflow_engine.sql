-- Migration 035: Full approval workflow engine
-- Adds peer review tracking, breach classification, dispute resolution, and
-- approval chain routing to contract_offer and approval_request tables.
-- Additive only — no drops, no destructive alters.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EXTEND contract_offer — full approval chain state
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='updated_at') THEN ALTER TABLE public.contract_offer ADD COLUMN updated_at timestamptz DEFAULT now(); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='quote_id') THEN ALTER TABLE public.contract_offer ADD COLUMN quote_id uuid; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='written_line_pct') THEN ALTER TABLE public.contract_offer ADD COLUMN written_line_pct numeric(10,6); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='ntu_at') THEN ALTER TABLE public.contract_offer ADD COLUMN ntu_at timestamptz; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='ntu_reason') THEN ALTER TABLE public.contract_offer ADD COLUMN ntu_reason text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='decline_reason') THEN ALTER TABLE public.contract_offer ADD COLUMN decline_reason text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='next_approver') THEN ALTER TABLE public.contract_offer ADD COLUMN next_approver text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='next_approver_id') THEN ALTER TABLE public.contract_offer ADD COLUMN next_approver_id uuid; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='next_approver_role') THEN ALTER TABLE public.contract_offer ADD COLUMN next_approver_role text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='breach_type') THEN ALTER TABLE public.contract_offer ADD COLUMN breach_type text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='approval_step') THEN ALTER TABLE public.contract_offer ADD COLUMN approval_step integer NOT NULL DEFAULT 0; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer1_user_id') THEN ALTER TABLE public.contract_offer ADD COLUMN peer1_user_id uuid; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer1_decision') THEN ALTER TABLE public.contract_offer ADD COLUMN peer1_decision text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer1_comment') THEN ALTER TABLE public.contract_offer ADD COLUMN peer1_comment text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer1_at') THEN ALTER TABLE public.contract_offer ADD COLUMN peer1_at timestamptz; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer2_user_id') THEN ALTER TABLE public.contract_offer ADD COLUMN peer2_user_id uuid; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer2_decision') THEN ALTER TABLE public.contract_offer ADD COLUMN peer2_decision text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer2_comment') THEN ALTER TABLE public.contract_offer ADD COLUMN peer2_comment text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='peer2_at') THEN ALTER TABLE public.contract_offer ADD COLUMN peer2_at timestamptz; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='arbiter_user_id') THEN ALTER TABLE public.contract_offer ADD COLUMN arbiter_user_id uuid; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='arbiter_decision') THEN ALTER TABLE public.contract_offer ADD COLUMN arbiter_decision text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='arbiter_comment') THEN ALTER TABLE public.contract_offer ADD COLUMN arbiter_comment text; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='arbiter_at') THEN ALTER TABLE public.contract_offer ADD COLUMN arbiter_at timestamptz; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='arbiter_required') THEN ALTER TABLE public.contract_offer ADD COLUMN arbiter_required boolean NOT NULL DEFAULT false; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='submitted_by_id') THEN ALTER TABLE public.contract_offer ADD COLUMN submitted_by_id uuid; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='submitted_at') THEN ALTER TABLE public.contract_offer ADD COLUMN submitted_at timestamptz; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='epi_usd') THEN ALTER TABLE public.contract_offer ADD COLUMN epi_usd numeric(18,2); END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract_offer' AND column_name='approver_options') THEN ALTER TABLE public.contract_offer ADD COLUMN approver_options jsonb; END IF; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. APPROVAL LOG TABLE — immutable event log per offer
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.offer_approval_event (
  event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid,                       -- contract or quote
  quote_id        uuid,
  event_type      text NOT NULL,              -- SUBMITTED|PEER1_APPROVED|PEER1_DECLINED|
                                              -- PEER2_APPROVED|PEER2_DECLINED|
                                              -- DISPUTE_RAISED|ARBITER_APPROVED|ARBITER_DECLINED|
                                              -- RETURNED|FINAL_APPROVED|FINAL_DECLINED|SIGNED|NTU
  actor_user_id   uuid,
  actor_name      text NOT NULL,
  actor_role      text,
  payload         jsonb,
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offer_event_contract ON public.offer_approval_event (contract_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offer_event_quote    ON public.offer_approval_event (quote_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. APPROVAL STATUS VIEW — current state of any offer
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_offer_approval AS
SELECT
  o.offer_id,
  o.contract_id,
  o.quote_id,
  o.status,
  o.breach_type,
  o.approval_step,
  o.arbiter_required,
  o.written_line_pct,
  o.submitted_by_id,
  o.submitted_at,
  -- Peer 1
  o.peer1_user_id,
  u1.display_name    AS peer1_name,
  u1r.role_code      AS peer1_role_code,
  o.peer1_decision,
  o.peer1_comment,
  o.peer1_at,
  -- Peer 2
  o.peer2_user_id,
  u2.display_name    AS peer2_name,
  u2r.role_code      AS peer2_role_code,
  o.peer2_decision,
  o.peer2_comment,
  o.peer2_at,
  -- Arbiter
  o.arbiter_user_id,
  ua.display_name    AS arbiter_name,
  uar.role_code      AS arbiter_role_code,
  o.arbiter_decision,
  o.arbiter_comment,
  o.arbiter_at,
  -- Submitter
  us.display_name    AS submitted_by_name,
  usr.role_code      AS submitted_by_role,
  -- Next approver
  o.next_approver_id,
  o.next_approver_role,
  un.display_name    AS next_approver_name,
  -- Summary
  CASE
    WHEN o.arbiter_required AND o.arbiter_decision IS NULL THEN 'DISPUTE_PENDING'
    WHEN o.arbiter_decision = 'APPROVED'  THEN 'FINAL_APPROVED'
    WHEN o.arbiter_decision = 'DECLINED'  THEN 'FINAL_DECLINED'
    WHEN o.peer1_decision IS NULL         THEN 'AWAITING_PEER1'
    WHEN o.peer2_decision IS NULL         THEN 'AWAITING_PEER2'
    WHEN o.peer1_decision = 'APPROVED' AND o.peer2_decision = 'APPROVED' THEN 'FULLY_APPROVED'
    WHEN o.peer1_decision = 'DECLINED' AND o.peer2_decision = 'DECLINED' THEN 'FULLY_DECLINED'
    ELSE 'SPLIT_DECISION'
  END AS approval_stage,
  o.approver_options,
  o.updated_at
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
