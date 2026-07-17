-- 133_claim_pla.sql
-- PLA (Preliminary Loss Advice) section of the Claims module.
--
-- A PLA is the cedant's early notification of a loss event against a
-- SIGNED/BOUND treaty, logged before enough is known to book a formal claim.
-- It carries a single estimated gross loss at 100% (no ledger) and a light
-- lifecycle:
--   • PENDING   — live advice, editable, awaiting development.
--   • CONVERTED — promoted into a real claim (converted_claim_id links it);
--                 the claim's opening ADVICE movement takes over the position.
--   • CLOSED    — advice withdrawn / no claim expected (closed_reason says why).
-- CLOSED can be reopened to PENDING; CONVERTED is terminal — the claim is the
-- record from then on.
--
-- Audit: PLA events write to the generic public.audit_log with entity_type
-- 'CLAIM_PLA' via services/audit.logAudit — no new audit tables.

CREATE SEQUENCE IF NOT EXISTS public.pla_ref_seq START 1;

CREATE TABLE IF NOT EXISTS public.preliminary_loss_advice (
  pla_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pla_ref                   text NOT NULL UNIQUE,
  contract_id               uuid NOT NULL REFERENCES public.contract(contract_id),
  class_of_business_id      uuid REFERENCES public.class_of_business(class_of_business_id),
  currency_id               uuid REFERENCES public.currency(currency_id),
  cedant_claim_ref          text,
  insured_name              text,
  loss_date                 date NOT NULL,
  advice_date               date NOT NULL DEFAULT CURRENT_DATE,
  cause_of_loss             text,
  description               text,
  loss_type                 text NOT NULL DEFAULT 'ATTRITIONAL'
                            CHECK (loss_type IN ('ATTRITIONAL','LARGE','CAT')),
  cat_event_ref             text,
  -- Cedant's estimated gross loss at 100% — a single figure, not a ledger.
  estimated_gross_loss_100  numeric(20,2) NOT NULL DEFAULT 0
                            CHECK (estimated_gross_loss_100 >= 0),
  status                    text NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','CONVERTED','CLOSED')),
  converted_claim_id        uuid REFERENCES public.claim(claim_id),
  converted_at              timestamptz,
  closed_at                 timestamptz,
  closed_reason             text,
  created_by_user_id        uuid REFERENCES public.uw_user(user_id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- CONVERTED rows must point at their claim; nothing else may.
  CHECK ((status = 'CONVERTED') = (converted_claim_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_pla_contract  ON public.preliminary_loss_advice(contract_id);
CREATE INDEX IF NOT EXISTS idx_pla_status    ON public.preliminary_loss_advice(status);
CREATE INDEX IF NOT EXISTS idx_pla_loss_date ON public.preliminary_loss_advice(loss_date);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_preliminary_loss_advice_updated') THEN
    CREATE TRIGGER trg_preliminary_loss_advice_updated
      BEFORE UPDATE ON public.preliminary_loss_advice
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;
