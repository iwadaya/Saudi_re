-- Component pricing snapshots: stores historical snapshots of the component pricing table
CREATE TABLE IF NOT EXISTS public.pricing_component_snapshots (
  id SERIAL PRIMARY KEY,
  contract_id UUID NOT NULL,
  snapshot_date TIMESTAMP DEFAULT NOW(),
  snapshot_label TEXT,  -- e.g. "Initial pricing", "Post UW review"
  components JSONB NOT NULL,  -- full snapshot of all component rows + columns
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_pcs_contract ON public.pricing_component_snapshots(contract_id);
