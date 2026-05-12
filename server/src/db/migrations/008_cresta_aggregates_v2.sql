-- 008_cresta_aggregates_v2.sql
-- Restructure cresta aggregates: per contract + treaty_type + COB + occupancy distribution

-- Create the table if it doesn't exist yet (covers fresh installs)
CREATE TABLE IF NOT EXISTS public.contract_cresta_data (
  id              BIGSERIAL PRIMARY KEY,
  contract_id     UUID NOT NULL,
  country_id      TEXT,
  zone_id         TEXT,
  zone_name       TEXT,
  eq_agg          NUMERIC(18,2) DEFAULT 0,
  ws_agg          NUMERIC(18,2) DEFAULT 0,
  flood_agg       NUMERIC(18,2) DEFAULT 0,
  srcc_agg        NUMERIC(18,2) DEFAULT 0,
  others_agg      NUMERIC(18,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Add new columns for v2 (treaty_type, cob_id, occupancy splits)
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS treaty_type TEXT DEFAULT 'Both';
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS cob_id UUID;
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS cob_name TEXT;

-- Occupancy distribution columns (stored as percentages on each zone row)
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS residential_bldg_pct NUMERIC(6,2) DEFAULT 30;
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS commercial_bldg_pct NUMERIC(6,2) DEFAULT 25;
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS commercial_cont_pct NUMERIC(6,2) DEFAULT 15;
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS industrial_bldg_pct NUMERIC(6,2) DEFAULT 20;
ALTER TABLE public.contract_cresta_data ADD COLUMN IF NOT EXISTS industrial_cont_pct NUMERIC(6,2) DEFAULT 10;

-- Composite index for lookups: contract + treaty_type + cob
CREATE INDEX IF NOT EXISTS idx_cresta_contract_type_cob
  ON public.contract_cresta_data (contract_id, treaty_type, cob_id);

CREATE INDEX IF NOT EXISTS idx_cresta_contract_country
  ON public.contract_cresta_data (contract_id, country_id);
