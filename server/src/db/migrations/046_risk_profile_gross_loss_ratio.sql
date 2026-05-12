-- Migration 046: add gross_loss_ratio to risk profile tables
-- Supports Swiss Re exposure rating Step 8 (brochure p.22):
-- multiply gross XL premium sum by cedant's avg claims burden
-- to convert to a risk premium before computing ROL.

ALTER TABLE public.contract_risk_profile
  ADD COLUMN IF NOT EXISTS gross_loss_ratio NUMERIC;

ALTER TABLE public.quote_risk_profile
  ADD COLUMN IF NOT EXISTS gross_loss_ratio NUMERIC;
