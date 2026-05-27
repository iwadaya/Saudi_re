-- 110_loss_actuarial_reported_date.sql
-- Separate two distinct dates that were previously conflated on a loss:
--
--   * reported_date           — "Saved in Universe": when the loss row was
--                               saved into the system. Mirrors the loss-list
--                               report_date and is used by the renewal-cycle
--                               comparison view.
--   * actuarial_reported_date — when the loss was actuarially reported /
--                               booked into the cedant's triangle. This is
--                               what determines the development period the
--                               loss is stripped from. User-entered and
--                               nullable; when absent, stripping falls back
--                               to date_of_loss + a quarter.

ALTER TABLE public.contract_large_losses
  ADD COLUMN IF NOT EXISTS actuarial_reported_date date;

ALTER TABLE public.contract_cat_losses
  ADD COLUMN IF NOT EXISTS actuarial_reported_date date;
