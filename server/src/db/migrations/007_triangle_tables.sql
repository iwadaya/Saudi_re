-- 007: Triangle and dev factor tables

CREATE TABLE IF NOT EXISTS public.contract_triangle_cells (
  cell_id     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL,
  type        public.triangle_type NOT NULL,
  origin_year INT NOT NULL,
  dev_months  INT NOT NULL,
  cum_value   NUMERIC(18,2) DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(contract_id, type, origin_year, dev_months)
);

CREATE TABLE IF NOT EXISTS public.contract_dev_factor (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contract_id UUID NOT NULL,
  triangle_type TEXT NOT NULL,
  dev_month INT NOT NULL,
  selected_ldf NUMERIC,
  selected_cdf NUMERIC,
  actual_ldf NUMERIC,
  actual_cdf NUMERIC,
  param_ldf NUMERIC,
  param_cdf NUMERIC,
  chosen_source TEXT,
  chosen_ldf NUMERIC,
  chosen_cdf NUMERIC,
  overridden BOOLEAN DEFAULT false,
  parametrized_ldf NUMERIC,
  parametrized_cdf NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(contract_id, triangle_type, dev_month)
);

-- Index for faster lookups
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_triangle_cells_contract ON public.contract_triangle_cells(contract_id, type);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_dev_factor_contract ON public.contract_dev_factor(contract_id, triangle_type);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
