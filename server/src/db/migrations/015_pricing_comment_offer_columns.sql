-- Migration 015: Add comment, offer state, and exposure rating columns
-- These fields are sent by the PropPricing screen but were never persisted.

-- Pricing outputs: comment + offer workflow state
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS uw_comment TEXT;
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS offer_status TEXT;
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS offer_line TEXT;
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS offer_comment TEXT;
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS offer_approver TEXT;
ALTER TABLE public.contract_pricing_outputs ADD COLUMN IF NOT EXISTS signed_line_pct NUMERIC;

-- Pricing components: exposure rating column
ALTER TABLE public.pricing_components ADD COLUMN IF NOT EXISTS exposure_value TEXT;
