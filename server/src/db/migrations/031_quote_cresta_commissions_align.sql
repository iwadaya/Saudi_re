-- Migration 031: Align quote_cresta_data and quote_commissions with contract equivalents

-- quote_cresta_data: add columns that contract_cresta_data has
ALTER TABLE public.quote_cresta_data
  ADD COLUMN IF NOT EXISTS treaty_type            text DEFAULT 'Both',
  ADD COLUMN IF NOT EXISTS cob_id                 uuid,
  ADD COLUMN IF NOT EXISTS cob_name               text,
  ADD COLUMN IF NOT EXISTS residential_bldg_pct   numeric(6,2) DEFAULT 30,
  ADD COLUMN IF NOT EXISTS commercial_bldg_pct    numeric(6,2) DEFAULT 25,
  ADD COLUMN IF NOT EXISTS commercial_cont_pct    numeric(6,2) DEFAULT 15,
  ADD COLUMN IF NOT EXISTS industrial_bldg_pct    numeric(6,2) DEFAULT 20,
  ADD COLUMN IF NOT EXISTS industrial_cont_pct    numeric(6,2) DEFAULT 10;

-- quote_commissions: add provisional_commission_pct to match contract_commissions
ALTER TABLE public.quote_commissions
  ADD COLUMN IF NOT EXISTS provisional_commission_pct numeric(5,2);
