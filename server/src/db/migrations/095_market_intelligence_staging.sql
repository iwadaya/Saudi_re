-- 095_market_intelligence_staging.sql
-- Wire the market-intelligence recommendation table into the existing
-- cedant_portfolio_staging flow (prompt 8.4).
--
-- Two changes:
--
-- 1. market_intelligence_recommendation.compliance_warnings — mirrors
--    the field on cedant_ai_recommendation. Populated when generating
--    per-treaty LINE_SIZE recs; consumed by the staging endpoint to
--    enforce the warning-acknowledgement gate.
--
-- 2. cedant_portfolio_staging gains a separate source_market_rec_id
--    column FK'd to market_intelligence_recommendation, plus a new
--    enum value 'AI_MARKET_RECOMMENDATION' on the source check. We
--    keep source_rec_id reserved for the cedant-portfolio AI recs
--    (its existing FK) instead of dropping integrity to overload
--    one column with two unrelated FKs.

ALTER TABLE public.market_intelligence_recommendation
  ADD COLUMN IF NOT EXISTS compliance_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;


ALTER TABLE public.cedant_portfolio_staging
  ADD COLUMN IF NOT EXISTS source_market_rec_id uuid
    REFERENCES public.market_intelligence_recommendation(rec_id);

CREATE INDEX IF NOT EXISTS idx_cedant_portfolio_staging_source_market_rec
  ON public.cedant_portfolio_staging (source_market_rec_id)
  WHERE source_market_rec_id IS NOT NULL;

ALTER TABLE public.cedant_portfolio_staging
  DROP CONSTRAINT IF EXISTS cedant_portfolio_staging_source_chk;

ALTER TABLE public.cedant_portfolio_staging
  ADD CONSTRAINT cedant_portfolio_staging_source_chk
    CHECK (source IN ('AI_RECOMMENDATION','MANUAL_OVERRIDE','AI_MARKET_RECOMMENDATION'));
