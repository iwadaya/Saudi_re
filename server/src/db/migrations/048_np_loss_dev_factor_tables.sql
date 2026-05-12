-- 048_np_loss_dev_factor_tables.sql
-- Dedicated relational tables for NP Large Loss and Cat Loss development factors
-- Mirrors contract_np_excess_ldf structure from migration 047

-- ── Large Loss LDF tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_np_large_loss_ldf (
  contract_id   uuid        NOT NULL REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  dev_month     integer     NOT NULL,
  chosen_ldf    numeric     NULL,
  chosen_cdf    numeric     NULL,
  tail_factor   numeric     NOT NULL DEFAULT 1.0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, dev_month)
);

CREATE TABLE IF NOT EXISTS public.quote_np_large_loss_ldf (
  quote_id      uuid        NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  dev_month     integer     NOT NULL,
  chosen_ldf    numeric     NULL,
  chosen_cdf    numeric     NULL,
  tail_factor   numeric     NOT NULL DEFAULT 1.0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, dev_month)
);

-- ── Cat Loss LDF tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_np_cat_loss_ldf (
  contract_id   uuid        NOT NULL REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  dev_month     integer     NOT NULL,
  chosen_ldf    numeric     NULL,
  chosen_cdf    numeric     NULL,
  tail_factor   numeric     NOT NULL DEFAULT 1.0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, dev_month)
);

CREATE TABLE IF NOT EXISTS public.quote_np_cat_loss_ldf (
  quote_id      uuid        NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  dev_month     integer     NOT NULL,
  chosen_ldf    numeric     NULL,
  chosen_cdf    numeric     NULL,
  tail_factor   numeric     NOT NULL DEFAULT 1.0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, dev_month)
);

-- ── Ultimate summary tables — store computed AY ultimates for NpFinalPricing ──

CREATE TABLE IF NOT EXISTS public.contract_np_large_loss_ultimate (
  contract_id   uuid        NOT NULL REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  acc_year      integer     NOT NULL,
  loss_count    integer     NOT NULL DEFAULT 0,
  reported      numeric     NOT NULL DEFAULT 0,
  applied_cdf   numeric     NOT NULL DEFAULT 1.0,
  ibnr          numeric     NOT NULL DEFAULT 0,
  ultimate      numeric     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, acc_year)
);

CREATE TABLE IF NOT EXISTS public.quote_np_large_loss_ultimate (
  quote_id      uuid        NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  acc_year      integer     NOT NULL,
  loss_count    integer     NOT NULL DEFAULT 0,
  reported      numeric     NOT NULL DEFAULT 0,
  applied_cdf   numeric     NOT NULL DEFAULT 1.0,
  ibnr          numeric     NOT NULL DEFAULT 0,
  ultimate      numeric     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, acc_year)
);

CREATE TABLE IF NOT EXISTS public.contract_np_cat_loss_ultimate (
  contract_id   uuid        NOT NULL REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  acc_year      integer     NOT NULL,
  loss_count    integer     NOT NULL DEFAULT 0,
  reported      numeric     NOT NULL DEFAULT 0,
  applied_cdf   numeric     NOT NULL DEFAULT 1.0,
  ibnr          numeric     NOT NULL DEFAULT 0,
  ultimate      numeric     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, acc_year)
);

CREATE TABLE IF NOT EXISTS public.quote_np_cat_loss_ultimate (
  quote_id      uuid        NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  acc_year      integer     NOT NULL,
  loss_count    integer     NOT NULL DEFAULT 0,
  reported      numeric     NOT NULL DEFAULT 0,
  applied_cdf   numeric     NOT NULL DEFAULT 1.0,
  ibnr          numeric     NOT NULL DEFAULT 0,
  ultimate      numeric     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, acc_year)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_contract_np_large_loss_ldf_contract
  ON public.contract_np_large_loss_ldf (contract_id);

CREATE INDEX IF NOT EXISTS idx_quote_np_large_loss_ldf_quote
  ON public.quote_np_large_loss_ldf (quote_id);

CREATE INDEX IF NOT EXISTS idx_contract_np_cat_loss_ldf_contract
  ON public.contract_np_cat_loss_ldf (contract_id);

CREATE INDEX IF NOT EXISTS idx_quote_np_cat_loss_ldf_quote
  ON public.quote_np_cat_loss_ldf (quote_id);

CREATE INDEX IF NOT EXISTS idx_contract_np_large_loss_ult_contract
  ON public.contract_np_large_loss_ultimate (contract_id);

CREATE INDEX IF NOT EXISTS idx_contract_np_cat_loss_ult_contract
  ON public.contract_np_cat_loss_ultimate (contract_id);
