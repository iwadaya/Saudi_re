-- 092_cedant_ai_recommendations.sql
-- Tables backing the AI portfolio-recommendation feature (prompt 7.5.a).
--
-- A "rec set" is one round-trip to Claude for a given cedant + risk
-- appetite + caps. Each set carries an arbitrary number of
-- recommendations, one per contract. Recommendations are proposals
-- only — they do not apply to contracts directly. Acceptance routes
-- through the staging table added in migration 093.
--
-- NOTE: the users table in this codebase is uw_user (not public."user").
-- The prompt referenced public."user" — keeping consistency with
-- migrations 090 and 091, which made the same swap.

CREATE TABLE IF NOT EXISTS public.cedant_ai_recommendation_set (
  rec_set_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cedant_id                 uuid NOT NULL,
  target_year               int  NOT NULL,
  risk_appetite             text NOT NULL,
  max_line_size_pct         numeric(5,4),
  max_cob_concentration_pct numeric(5,4),
  summary                   text,
  portfolio_metrics         jsonb,
  raw_response              jsonb,
  created_at                timestamptz DEFAULT now(),
  created_by_user_id        uuid REFERENCES public.uw_user(user_id),
  CONSTRAINT cedant_ai_rec_set_risk_appetite_chk
    CHECK (risk_appetite IN ('CONSERVATIVE','BALANCED','OPPORTUNISTIC'))
);

CREATE INDEX IF NOT EXISTS idx_cedant_ai_rec_set_cedant_created
  ON public.cedant_ai_recommendation_set (cedant_id, created_at DESC);


CREATE TABLE IF NOT EXISTS public.cedant_ai_recommendation (
  rec_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rec_set_id           uuid NOT NULL REFERENCES public.cedant_ai_recommendation_set(rec_set_id)
                              ON DELETE CASCADE,
  cedant_id            uuid NOT NULL,
  contract_id          uuid NOT NULL,
  current_line_pct     numeric(7,4),
  recommended_line_pct numeric(7,4) NOT NULL,
  rationale            text,
  confidence           numeric(4,3),
  impact_on_return     numeric(18,2),
  compliance_warnings  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- PENDING / STAGED / COMMITTED / REJECTED / SUPERSEDED
  -- STAGED + COMMITTED come from migration 093 (prompt 7.5.b).
  status               text NOT NULL DEFAULT 'PENDING',
  acted_at             timestamptz,
  acted_by_user_id     uuid REFERENCES public.uw_user(user_id),
  CONSTRAINT cedant_ai_rec_status_chk
    CHECK (status IN ('PENDING','STAGED','COMMITTED','REJECTED','SUPERSEDED'))
);

CREATE INDEX IF NOT EXISTS idx_cedant_ai_rec_cedant_status
  ON public.cedant_ai_recommendation (cedant_id, status);

CREATE INDEX IF NOT EXISTS idx_cedant_ai_rec_set
  ON public.cedant_ai_recommendation (rec_set_id);
