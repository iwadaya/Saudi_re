-- 111_loss_policy_inception_date.sql
-- Policy inception date per loss. For risks-attaching treaties the
-- underwriting (origin) year a loss attaches to is the policy inception year,
-- so we capture the inception date and derive uw_year from it (falling back to
-- the loss date when inception is absent). Persisted so the derivation is
-- reproducible and editable across sessions.

ALTER TABLE public.contract_large_losses
  ADD COLUMN IF NOT EXISTS policy_inception_date date;

ALTER TABLE public.contract_cat_losses
  ADD COLUMN IF NOT EXISTS policy_inception_date date;
