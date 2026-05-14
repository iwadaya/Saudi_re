-- 082_fac_pricing_engine_columns.sql
-- Extend fac_pricing with the columns the new pricing engine produces:
-- user inputs (indemnity, commission / margin / other-expenses, extra
-- cover loadings, market rate) and the full engine output (rate path
-- per-mille columns, premiums, underwriting score + decision, market
-- vs technical band, plus engine version and warnings snapshot).
-- The client computes everything via computeFacQuote; the server just
-- writes what's posted so the row is a faithful snapshot of what the
-- underwriter saw.
-- All columns are nullable (the screen can be saved mid-flight); the
-- defaults match the engine's own defaults so a partial draft renders
-- cleanly.

ALTER TABLE public.fac_pricing
  -- Engine inputs
  ADD COLUMN IF NOT EXISTS indemnity_months       integer,
  ADD COLUMN IF NOT EXISTS commission_pct         numeric(7,4) DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS margin_pct             numeric(7,4) DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS other_expenses_pct     numeric(7,4) DEFAULT 0.005,
  ADD COLUMN IF NOT EXISTS extra_cover_loadings   jsonb        DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS market_rate_pm         numeric(12,8),

  -- Engine outputs — rate path
  ADD COLUMN IF NOT EXISTS technical_rate_pm      numeric(12,8),
  ADD COLUMN IF NOT EXISTS total_rate_pm          numeric(12,8),
  ADD COLUMN IF NOT EXISTS bi_rate_pm             numeric(12,8),
  ADD COLUMN IF NOT EXISTS net_rate_pm            numeric(12,8),
  ADD COLUMN IF NOT EXISTS final_net_rate_pm      numeric(12,8),
  ADD COLUMN IF NOT EXISTS final_gross_rate_pm    numeric(12,8),
  ADD COLUMN IF NOT EXISTS technical_premium      numeric(18,2),
  ADD COLUMN IF NOT EXISTS expected_premium       numeric(18,2),

  -- Engine outputs — score + capacity decision
  ADD COLUMN IF NOT EXISTS underwriting_score     numeric(6,2),
  ADD COLUMN IF NOT EXISTS capacity_grade         text,
  ADD COLUMN IF NOT EXISTS uw_action              text,
  ADD COLUMN IF NOT EXISTS max_capacity_pct       numeric(7,4),
  ADD COLUMN IF NOT EXISTS max_capacity_sar       numeric(18,2),
  ADD COLUMN IF NOT EXISTS market_vs_tech_pct     numeric(7,4),
  ADD COLUMN IF NOT EXISTS market_vs_tech_band    text,

  -- Provenance
  ADD COLUMN IF NOT EXISTS engine_version         text,
  ADD COLUMN IF NOT EXISTS engine_warnings        jsonb        DEFAULT '[]'::jsonb;
