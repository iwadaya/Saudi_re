-- 014_risk_profile_exposure_params.sql
-- Add exposure rating parameters to contract_risk_profile for audit:
-- selected_curve (which Swiss Re / MBBEFD curve was used)
-- custom_b, custom_g (if Custom curve was selected)
-- Ensures c_value and pml_percentage also exist (they should already).

BEGIN;

-- Ensure c_value and pml_percentage exist (idempotent)
ALTER TABLE public.contract_risk_profile
  ADD COLUMN IF NOT EXISTS c_value         numeric(12,6) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pml_percentage  numeric(8,4)  DEFAULT 100;

-- Add curve selection for audit
ALTER TABLE public.contract_risk_profile
  ADD COLUMN IF NOT EXISTS selected_curve  text,          -- 'Y1' | 'Y2' | 'Y3' | 'Y4' | 'Custom' | 'DB:curvename'
  ADD COLUMN IF NOT EXISTS custom_b        numeric(12,6), -- MBBEFD b parameter (only for Custom)
  ADD COLUMN IF NOT EXISTS custom_g        numeric(12,6); -- MBBEFD g parameter (only for Custom)

COMMIT;
