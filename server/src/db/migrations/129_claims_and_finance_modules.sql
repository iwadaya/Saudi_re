-- 129_claims_and_finance_modules.sql
-- Claims module + Finance module foundation.
--
-- CLAIMS: cedant-advised treaty claims tracked against SIGNED/BOUND contracts.
--   • claim           — one row per claim (header + lifecycle status).
--   • claim_movement  — immutable movement ledger. Each movement restates the
--     CUMULATIVE position at 100% (gross_paid_100 / gross_os_100), the standard
--     reinsurance bordereau convention — the latest movement IS the current
--     position; incurred = paid + OS. Our share is derived from the share_pct
--     snapshotted on each movement (defaults to contract.signed_line_pct at
--     the time the movement is booked, so a later line restatement never
--     silently rewrites booked history).
--   • claim_note      — free-text working notes (adjuster / underwriter log).
--   • claim_ref_seq   — global sequence behind human-readable CLM-000123 refs.
--
-- FINANCE: ledger of signed treaties handed over to Finance for booking.
--   • finance_treaty_entry — exactly one row per contract (UNIQUE contract_id;
--     push is an idempotent UPSERT). Written in the SAME transaction as the
--     SIGN / BIND status change (services/financePush.js), so "signed ⟹ in
--     finance" holds atomically. EPI and signed line are snapshotted at push
--     time; Finance acknowledges the entry (PENDING_SETUP → ACTIVE) once
--     booked in the GL.
--   • Backfill at the bottom seeds entries for contracts that were already
--     SIGNED/BOUND before this migration shipped (source='BACKFILL').
--
-- Audit: claim + finance events write to the generic public.audit_log
-- (entity_type 'CLAIM' / 'FINANCE_ENTRY') via services/audit.logAudit — no
-- new audit tables needed.

-- ── Claims ───────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.claim_ref_seq START 1;

CREATE TABLE IF NOT EXISTS public.claim (
  claim_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_ref             text NOT NULL UNIQUE,
  contract_id           uuid NOT NULL REFERENCES public.contract(contract_id),
  class_of_business_id  uuid REFERENCES public.class_of_business(class_of_business_id),
  currency_id           uuid REFERENCES public.currency(currency_id),
  cedant_claim_ref      text,
  insured_name          text,
  loss_date             date NOT NULL,
  reported_date         date DEFAULT CURRENT_DATE,
  cause_of_loss         text,
  description           text,
  loss_type             text NOT NULL DEFAULT 'ATTRITIONAL'
                        CHECK (loss_type IN ('ATTRITIONAL','LARGE','CAT')),
  cat_event_ref         text,
  status                text NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN','REOPENED','CLOSED','DECLINED')),
  closed_at             timestamptz,
  closed_reason         text,
  created_by_user_id    uuid REFERENCES public.uw_user(user_id),
  assigned_to_user_id   uuid REFERENCES public.uw_user(user_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_contract  ON public.claim(contract_id);
CREATE INDEX IF NOT EXISTS idx_claim_status    ON public.claim(status);
CREATE INDEX IF NOT EXISTS idx_claim_loss_date ON public.claim(loss_date);

CREATE TABLE IF NOT EXISTS public.claim_movement (
  movement_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        uuid NOT NULL REFERENCES public.claim(claim_id) ON DELETE CASCADE,
  movement_no     integer NOT NULL,
  movement_date   date NOT NULL DEFAULT CURRENT_DATE,
  movement_type   text NOT NULL
                  CHECK (movement_type IN
                    ('ADVICE','RESERVE_CHANGE','PAYMENT','RECOVERY','CLOSURE','REOPEN')),
  -- Cumulative position at 100% as at this movement (bordereau restatement).
  gross_paid_100  numeric(20,2) NOT NULL DEFAULT 0 CHECK (gross_paid_100 >= 0),
  gross_os_100    numeric(20,2) NOT NULL DEFAULT 0 CHECK (gross_os_100 >= 0),
  -- Our share % snapshotted when the movement is booked (contract signed line).
  share_pct       numeric(9,6),
  comment         text,
  created_by_user_id uuid REFERENCES public.uw_user(user_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, movement_no)
);

CREATE INDEX IF NOT EXISTS idx_claim_movement_claim ON public.claim_movement(claim_id);

CREATE TABLE IF NOT EXISTS public.claim_note (
  note_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id           uuid NOT NULL REFERENCES public.claim(claim_id) ON DELETE CASCADE,
  note               text NOT NULL,
  created_by_user_id uuid REFERENCES public.uw_user(user_id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_note_claim ON public.claim_note(claim_id);

-- ── Finance ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.finance_treaty_entry (
  entry_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id             uuid NOT NULL UNIQUE REFERENCES public.contract(contract_id),
  source                  text NOT NULL DEFAULT 'SIGN'
                          CHECK (source IN ('SIGN','BIND','BACKFILL')),
  status                  text NOT NULL DEFAULT 'PENDING_SETUP'
                          CHECK (status IN ('PENDING_SETUP','ACTIVE','SUSPENDED','CLOSED')),
  signed_line_pct         numeric(9,6),
  epi_100                 numeric(20,2),
  epi_our_share           numeric(20,2),
  currency_code           text,
  notes                   text,
  pushed_at               timestamptz NOT NULL DEFAULT now(),
  acknowledged_by_user_id uuid REFERENCES public.uw_user(user_id),
  acknowledged_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_entry_status ON public.finance_treaty_entry(status);

-- ── updated_at triggers (mutable tables only; the movement ledger is immutable)

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['claim','finance_treaty_entry'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_' || tbl || '_updated') THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
        tbl, tbl
      );
    END IF;
  END LOOP;
END $$;

-- ── Backfill: contracts already SIGNED/BOUND before this migration ──────────
-- EPI snapshot from contract_pricing_outputs where available.

INSERT INTO public.finance_treaty_entry
  (contract_id, source, signed_line_pct, epi_100, epi_our_share, currency_code)
SELECT
  c.contract_id,
  'BACKFILL',
  c.signed_line_pct,
  po.epi,
  CASE WHEN po.epi IS NOT NULL AND c.signed_line_pct IS NOT NULL
       THEN ROUND(po.epi * c.signed_line_pct / 100.0, 2) END,
  cur.currency_code
FROM public.contract c
LEFT JOIN public.contract_pricing_outputs po ON po.contract_id = c.contract_id
LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
WHERE c.status IN ('SIGNED','BOUND')
ON CONFLICT (contract_id) DO NOTHING;
