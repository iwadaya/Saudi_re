-- 138_fac_drift_observations.sql
-- Facultative Phase 5: the evidence behind FAC_PRICING_STRICT.
--
-- The drift verifier has recomputed every pricing save on the server since
-- Phase 1 and logged the disagreements. Logging is the right place for an
-- incident; it is the wrong place for a decision. The design says the strict
-- flag flips "once the drift rate has been observed at zero for a full pricing
-- cycle — never before, or a stale browser tab starts failing saves", and a
-- log line cannot answer "what is the drift rate".
--
-- So every verification is recorded, not only the failures. A drift RATE needs
-- a denominator, and a table of only the disagreements has none: it cannot
-- distinguish a quiet week from a broken verifier.

CREATE TABLE IF NOT EXISTS public.fac_pricing_drift (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id    uuid NOT NULL
                   REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  observed_at    timestamptz NOT NULL DEFAULT now(),
  family_code    text,
  -- 0 is the interesting value most of the time: it is what "the client and
  -- the server agree" looks like, and it is what the rate is measured against.
  drift_count    integer NOT NULL DEFAULT 0,
  max_abs_diff   numeric(18,8),
  fields         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The whole comparison, so a disagreement can be diagnosed months later
  -- without re-pricing against reference data that has since moved.
  detail         jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_id     text,
  strict_mode    boolean NOT NULL DEFAULT false,
  rate_table_version text
);

CREATE INDEX IF NOT EXISTS idx_fac_pricing_drift_observed
  ON public.fac_pricing_drift (observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_fac_pricing_drift_family
  ON public.fac_pricing_drift (family_code, observed_at DESC);

-- Only the disagreements, for the common "what is currently broken" query.
CREATE INDEX IF NOT EXISTS idx_fac_pricing_drift_nonzero
  ON public.fac_pricing_drift (observed_at DESC) WHERE drift_count > 0;

COMMENT ON TABLE public.fac_pricing_drift IS
  'Every server-side pricing verification, agreeing or not. The denominator for '
  'the drift rate that FAC_PRICING_STRICT should be flipped on.';
