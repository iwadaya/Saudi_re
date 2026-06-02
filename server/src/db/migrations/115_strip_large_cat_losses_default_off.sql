-- 115_strip_large_cat_losses_default_off.sql
-- Flip the proportional-triangle strip default from true to false.
-- The underwriter now strips large/cat losses OUTSIDE the tool and imports
-- pre-stripped triangles, so the tool should project the triangle as-is unless
-- stripping is explicitly turned on per treaty. Migration 112 introduced this
-- column defaulting to true; this inverts the column default to false.
-- NOTE: intentionally NOT backfilling existing rows — saved treaties keep
-- whatever the underwriter set (NULL/true/false). Only new rows pick up the
-- new false default. The stripping capability remains fully intact and is
-- re-enabled per treaty via the Dev Factors toggle.

ALTER TABLE public.contract_prop_details
  ALTER COLUMN strip_large_cat_losses SET DEFAULT false;

ALTER TABLE public.quote_prop_details
  ALTER COLUMN strip_large_cat_losses SET DEFAULT false;
