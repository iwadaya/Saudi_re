-- 093_cedant_portfolio_staging.sql
-- Staging area for line-size changes (prompt 7.5.b).
--
-- Accepting an AI recommendation, or a manual override, writes a row
-- here with status='STAGED'. A single commit-all action applies every
-- STAGED row to the underlying contracts in one transaction. Discard
-- moves a row to DISCARDED without touching the contract.
--
-- Concurrency invariant: at most ONE STAGED row per (cedant, contract).
-- The API enforces this by DISCARDing the prior STAGED row before
-- inserting the new one. We enforce it at the DB level with a partial
-- unique index. A plain UNIQUE on (cedant_id, contract_id, status) was
-- in the original prompt, but that also rejects two historical
-- DISCARDED or two historical COMMITTED rows for the same contract,
-- which is normal — multiple staging attempts get DISCARDED over time.
-- The partial index captures the intent more precisely.

CREATE TABLE IF NOT EXISTS public.cedant_portfolio_staging (
  staging_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cedant_id                        uuid NOT NULL,
  contract_id                      uuid NOT NULL REFERENCES public.contract(contract_id)
                                          ON DELETE CASCADE,
  proposed_line_pct                numeric(7,4) NOT NULL,
  -- AI_RECOMMENDATION / MANUAL_OVERRIDE
  source                           text NOT NULL,
  source_rec_id                    uuid REFERENCES public.cedant_ai_recommendation(rec_id),
  rationale                        text,
  compliance_warnings              jsonb NOT NULL DEFAULT '[]'::jsonb,
  warning_acknowledged_by_user_id  uuid REFERENCES public.uw_user(user_id),
  warning_acknowledged_at          timestamptz,
  -- STAGED / COMMITTED / DISCARDED
  status                           text NOT NULL DEFAULT 'STAGED',
  created_at                       timestamptz DEFAULT now(),
  created_by_user_id               uuid REFERENCES public.uw_user(user_id),
  committed_at                     timestamptz,
  discarded_at                     timestamptz,
  CONSTRAINT cedant_portfolio_staging_source_chk
    CHECK (source IN ('AI_RECOMMENDATION','MANUAL_OVERRIDE')),
  CONSTRAINT cedant_portfolio_staging_status_chk
    CHECK (status IN ('STAGED','COMMITTED','DISCARDED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cedant_portfolio_staging_one_staged
  ON public.cedant_portfolio_staging (cedant_id, contract_id)
  WHERE status = 'STAGED';

CREATE INDEX IF NOT EXISTS idx_cedant_portfolio_staging_cedant_status
  ON public.cedant_portfolio_staging (cedant_id, status, created_at DESC);
