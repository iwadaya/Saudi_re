-- 052_np_layer_margin_columns.sql
-- Per-layer margin columns for contract_np_layers / quote_np_layers.
-- Enables cedant summary SUMPRODUCT(earned_premium * margin) / SUM(earned_premium).
--
-- Column mapping to NP Final Pricing screen:
--   hist_margin     ← HIST. MARGIN  (burn-cost historical margin → actual_margin in cedant summary)
--   modelled_margin ← MARGIN        ((expiring-reinsurer)/expiring → actuarial_margin in cedant summary)
--   tech_ratio      ← TECH RATIO    (100 - hist_margin, informational)
--   uw_price        ← REINSURER ROL %
--   expiring_price  ← EXPIRING ROL %
--   lead_price      ← LEAD ROL %

ALTER TABLE public.contract_np_layers
  ADD COLUMN IF NOT EXISTS hist_margin     numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS modelled_margin numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tech_ratio      numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS uw_price        numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS expiring_price  numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lead_price      numeric(12,8) DEFAULT NULL;

ALTER TABLE public.quote_np_layers
  ADD COLUMN IF NOT EXISTS hist_margin     numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS modelled_margin numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tech_ratio      numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS uw_price        numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS expiring_price  numeric(12,8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lead_price      numeric(12,8) DEFAULT NULL;
