-- Migration 021: Fix NP expiring tables — use UUID contract_id (no FK constraint)
-- Migration 020 used INTEGER FK which doesn't match the platform's UUID contract IDs.
-- This migration drops and recreates with correct types. Safe to run multiple times.

-- Note: DROP statements removed — migration runner now tracks applied migrations
-- and will never re-run this file, so destructive DROPs are not needed.

-- ── Contract: expiring layers ──
CREATE TABLE IF NOT EXISTS public.contract_np_expiring_layers (
  expiring_layer_id     SERIAL PRIMARY KEY,
  contract_id           UUID NOT NULL,
  layer_number          INTEGER NOT NULL,
  attachment            NUMERIC,
  layer_limit           NUMERIC,
  aggregate_limit       NUMERIC,
  egnpi                 NUMERIC,
  earned_premium        NUMERIC,
  rate                  NUMERIC,
  rol                   NUMERIC,
  num_reinstatements    INTEGER,
  reinstatement_pct     NUMERIC,
  annual_agg_deductible NUMERIC,
  peril_scope           TEXT NOT NULL DEFAULT 'BOTH',
  mdp                   NUMERIC,
  mdp_pct               NUMERIC,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (contract_id, layer_number)
);

-- ── Contract: expiring terms ──
CREATE TABLE IF NOT EXISTS public.contract_np_expiring_terms (
  id                        SERIAL PRIMARY KEY,
  contract_id               UUID NOT NULL UNIQUE,
  egnpi                     NUMERIC,
  deductible                NUMERIC,
  risk_limit                NUMERIC,
  cat_limit                 NUMERIC,
  brokerage_pct             NUMERIC,
  no_claims_bonus_pct       NUMERIC,
  profit_commission_pct     NUMERIC,
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

-- ── Quote: expiring layers ──
CREATE TABLE IF NOT EXISTS public.quote_np_expiring_layers (
  expiring_layer_id     SERIAL PRIMARY KEY,
  quote_id              UUID NOT NULL,
  layer_number          INTEGER NOT NULL,
  attachment            NUMERIC,
  layer_limit           NUMERIC,
  aggregate_limit       NUMERIC,
  egnpi                 NUMERIC,
  earned_premium        NUMERIC,
  rate                  NUMERIC,
  rol                   NUMERIC,
  num_reinstatements    INTEGER,
  reinstatement_pct     NUMERIC,
  annual_agg_deductible NUMERIC,
  peril_scope           TEXT NOT NULL DEFAULT 'BOTH',
  mdp                   NUMERIC,
  mdp_pct               NUMERIC,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (quote_id, layer_number)
);

-- ── Quote: expiring terms ──
CREATE TABLE IF NOT EXISTS public.quote_np_expiring_terms (
  id                        SERIAL PRIMARY KEY,
  quote_id                  UUID NOT NULL UNIQUE,
  egnpi                     NUMERIC,
  deductible                NUMERIC,
  risk_limit                NUMERIC,
  cat_limit                 NUMERIC,
  brokerage_pct             NUMERIC,
  no_claims_bonus_pct       NUMERIC,
  profit_commission_pct     NUMERIC,
  notes                     TEXT,
  created_at                TIMESTAMPTZ DEFAULT now(),
  updated_at                TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_np_expiring_layers_contract  ON public.contract_np_expiring_layers (contract_id, layer_number);
CREATE INDEX IF NOT EXISTS idx_np_expiring_terms_contract   ON public.contract_np_expiring_terms  (contract_id);
CREATE INDEX IF NOT EXISTS idx_quote_np_expiring_layers_qid ON public.quote_np_expiring_layers    (quote_id, layer_number);
CREATE INDEX IF NOT EXISTS idx_quote_np_expiring_terms_qid  ON public.quote_np_expiring_terms     (quote_id);
