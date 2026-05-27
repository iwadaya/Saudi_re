-- 112_strip_large_cat_losses.sql
-- Per-treaty choice of whether large + cat losses are stripped from the claims
-- triangle (the attritional basis used for selecting development factors). When
-- false, dev factors are selected on the original/full triangle and the quick &
-- projected summaries fold all losses into attritional (large/cat shown as nil).
-- Defaults to true to preserve the existing actuarial behaviour.

ALTER TABLE public.contract_prop_details
  ADD COLUMN IF NOT EXISTS strip_large_cat_losses boolean DEFAULT true;

ALTER TABLE public.quote_prop_details
  ADD COLUMN IF NOT EXISTS strip_large_cat_losses boolean DEFAULT true;
