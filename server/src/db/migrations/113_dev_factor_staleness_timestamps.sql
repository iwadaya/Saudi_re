-- 113_dev_factor_staleness_timestamps.sql
-- Staleness tracking for saved dev factors: lets the UI warn that factors may
-- need review when a triangle has been edited after the factors were saved.
--
-- contract_triangle_cells.updated_at  — when the triangle (this type) was last saved
-- contract_dev_factor.saved_at        — when the dev factors (this type) were last saved
--
-- Both tables are rewritten (DELETE + INSERT) on every save, so a DEFAULT of
-- now() makes these columns naturally reflect the last save without any route
-- changes. Existing rows are backfilled from created_at as a baseline.

ALTER TABLE public.contract_triangle_cells
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
ALTER TABLE public.quote_triangle_cells
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

ALTER TABLE public.contract_dev_factor
  ADD COLUMN IF NOT EXISTS saved_at timestamp with time zone DEFAULT now();
ALTER TABLE public.quote_dev_factor
  ADD COLUMN IF NOT EXISTS saved_at timestamp with time zone DEFAULT now();

UPDATE public.contract_triangle_cells SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE public.quote_triangle_cells    SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE public.contract_dev_factor     SET saved_at   = created_at WHERE saved_at   IS NULL;
UPDATE public.quote_dev_factor        SET saved_at   = created_at WHERE saved_at   IS NULL;
