-- 055_fac_pricing_ui_state.sql
-- Add a JSONB column to fac_pricing for UI-only state that doesn't belong
-- in a typed column (selected extensions, custom user-defined extensions).

ALTER TABLE public.fac_pricing
  ADD COLUMN IF NOT EXISTS ui_state jsonb NOT NULL DEFAULT '{}'::jsonb;
