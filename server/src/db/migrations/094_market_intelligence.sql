-- 094_market_intelligence.sql
-- Cached AI market intelligence reports (prompt 8.1).
--
-- A "report" is one round-trip to Claude (Messages API + web_search
-- tool) for a given country + class_of_business + target_year. Reports
-- are shared: one generation serves every treaty matching that triple,
-- and the API layer treats anything generated in the last 30 days as
-- a cache hit.
--
-- A "recommendation" is the contract-scoped slice of a report. Each
-- treaty's underwriter gets per-treaty recs that point back at the
-- shared report. When the report is regenerated, old recs stay so the
-- audit trail survives (status SUPERSEDED is reserved for that path).
--
-- NOTE: the users table in this codebase is uw_user (not public."user").
-- The prompt referenced public."user" — staying consistent with
-- migrations 090–093 which made the same swap.

CREATE TABLE IF NOT EXISTS public.market_intelligence_report (
  report_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id             uuid NOT NULL REFERENCES public.country(country_id),
  class_of_business_id   uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id),
  target_year            int  NOT NULL,
  -- Report content
  executive_summary      text  NOT NULL,
  market_landscape       jsonb NOT NULL,
    -- { regulator: string, regulator_recent_actions: string[],
    --   top_carriers: [{ name, market_share_pct?, am_best_rating? }],
    --   market_size_premium: { value, currency, year, source_idx },
    --   market_growth_pct: number,
    --   recent_context: string }
  market_benchmarks      jsonb NOT NULL,
    -- { loss_ratio_market_avg: number, loss_ratio_year: int,
    --   commission_market_norm_pct: number,
    --   retention_market_norm_pct: number,
    --   roe_market_avg_pct: number,
    --   notes: string }
  trends                 jsonb NOT NULL,
    -- [{ title, body, source_idx?, severity: 'INFO'|'WARNING'|'OPPORTUNITY' }]
  recommendations        jsonb NOT NULL,
    -- [{ title, body, action_type: 'LINE_SIZE'|'TERMS'|'EXIT'|'WATCH',
    --    confidence: number, source_idx?: number }]
  sources                jsonb NOT NULL,
    -- [{ idx: int, url: string, title: string, snippet: string,
    --    accessed_at: timestamp }]
  -- Metadata
  model                  text NOT NULL,
  raw_response           jsonb,
  generated_at           timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id   uuid REFERENCES public.uw_user(user_id),
  generation_duration_ms int,
  CONSTRAINT market_intelligence_report_unique
    UNIQUE (country_id, class_of_business_id, target_year, generated_at)
);

CREATE INDEX IF NOT EXISTS idx_market_intelligence_report_lookup
  ON public.market_intelligence_report
     (country_id, class_of_business_id, target_year, generated_at DESC);


CREATE TABLE IF NOT EXISTS public.market_intelligence_recommendation (
  rec_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id                 uuid NOT NULL REFERENCES public.market_intelligence_report(report_id)
                                   ON DELETE CASCADE,
  contract_id               uuid NOT NULL REFERENCES public.contract(contract_id),
  -- The recommendation as it applies to THIS specific treaty viewing the report.
  action_type               text NOT NULL,  -- LINE_SIZE / TERMS / EXIT / WATCH
  recommended_line_pct      numeric(7,4),
  recommended_terms_changes jsonb,
    -- free-form: { commission_pct?, brokerage_pct?, profit_commission_pct? }
  rationale                 text NOT NULL,
  confidence                numeric(4,3),
  status                    text NOT NULL DEFAULT 'PENDING',
                            -- PENDING / STAGED / COMMITTED / REJECTED / SUPERSEDED
  acted_at                  timestamptz,
  acted_by_user_id          uuid REFERENCES public.uw_user(user_id),
  created_at                timestamptz DEFAULT now(),
  CONSTRAINT market_intelligence_rec_action_chk
    CHECK (action_type IN ('LINE_SIZE','TERMS','EXIT','WATCH')),
  CONSTRAINT market_intelligence_rec_status_chk
    CHECK (status IN ('PENDING','STAGED','COMMITTED','REJECTED','SUPERSEDED'))
);

CREATE INDEX IF NOT EXISTS idx_market_intelligence_rec_contract_status
  ON public.market_intelligence_recommendation (contract_id, status);

CREATE INDEX IF NOT EXISTS idx_market_intelligence_rec_report
  ON public.market_intelligence_recommendation (report_id);
