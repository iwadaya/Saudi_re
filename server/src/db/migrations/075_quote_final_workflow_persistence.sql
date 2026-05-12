-- 075_quote_final_workflow_persistence.sql
-- Relational persistence for NP final quote alternatives, approval picks,
-- final-pricing scaffolding, and quote negotiation/change tracking.

CREATE TABLE IF NOT EXISTS public.quote_np_final_structure (
  quote_id uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  structure_no integer NOT NULL,
  structure_key text,
  structure_label text,
  selected_for_approval boolean NOT NULL DEFAULT false,
  raw_structure jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, structure_no)
);

CREATE INDEX IF NOT EXISTS idx_quote_np_final_structure_quote
  ON public.quote_np_final_structure (quote_id, structure_no);

CREATE INDEX IF NOT EXISTS idx_quote_np_final_structure_selected
  ON public.quote_np_final_structure (quote_id)
  WHERE selected_for_approval;

CREATE TABLE IF NOT EXISTS public.quote_np_final_structure_layer (
  quote_id uuid NOT NULL,
  structure_no integer NOT NULL,
  layer_number integer NOT NULL,
  layer_key text,
  layer_limit numeric(18,2),
  attachment numeric(18,2),
  egnpi numeric(18,2),
  earned_premium numeric(18,2),
  rate numeric(12,8),
  rol numeric(12,8),
  risk boolean NOT NULL DEFAULT false,
  cat boolean NOT NULL DEFAULT false,
  pure_burn_pct numeric(18,6),
  pareto_pct numeric(18,6),
  burn_plus_pareto_pct numeric(18,6),
  exposure_pct numeric(18,6),
  burn_weight_pct numeric(10,4),
  pareto_weight_pct numeric(10,4),
  exposure_weight_pct numeric(10,4),
  loading_pct numeric(10,4),
  uw_price_pct numeric(18,6),
  risk_pure_burn_pct numeric(18,6),
  risk_pareto_pct numeric(18,6),
  risk_burn_plus_pareto_pct numeric(18,6),
  risk_exposure_pct numeric(18,6),
  risk_burn_weight_pct numeric(10,4),
  risk_pareto_weight_pct numeric(10,4),
  risk_exposure_weight_pct numeric(10,4),
  risk_loading_pct numeric(10,4),
  risk_uw_price_pct numeric(18,6),
  risk_prob_attach_pct numeric(18,6),
  risk_prob_exhaust_pct numeric(18,6),
  cat_pure_burn_pct numeric(18,6),
  cat_pareto_pct numeric(18,6),
  cat_burn_plus_pareto_pct numeric(18,6),
  cat_exposure_pct numeric(18,6),
  cat_burn_weight_pct numeric(10,4),
  cat_pareto_weight_pct numeric(10,4),
  cat_exposure_weight_pct numeric(10,4),
  cat_loading_pct numeric(10,4),
  cat_uw_price_pct numeric(18,6),
  cat_prob_attach_pct numeric(18,6),
  cat_prob_exhaust_pct numeric(18,6),
  raw_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, structure_no, layer_number),
  CONSTRAINT quote_np_final_structure_layer_parent_fkey
    FOREIGN KEY (quote_id, structure_no)
    REFERENCES public.quote_np_final_structure (quote_id, structure_no)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quote_np_final_structure_layer_quote
  ON public.quote_np_final_structure_layer (quote_id, structure_no, layer_number);

CREATE TABLE IF NOT EXISTS public.quote_np_final_structure_cob (
  quote_id uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  structure_no integer NOT NULL,
  scope_key text NOT NULL,
  class_of_business_id uuid NOT NULL REFERENCES public.class_of_business(class_of_business_id) ON DELETE CASCADE,
  limit_amount numeric(18,2),
  layer_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  manual_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, scope_key, class_of_business_id)
);

CREATE INDEX IF NOT EXISTS idx_quote_np_final_structure_cob_quote
  ON public.quote_np_final_structure_cob (quote_id, structure_no);

CREATE TABLE IF NOT EXISTS public.quote_np_final_expiring_probability (
  quote_id uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  layer_number integer NOT NULL,
  prob_attach_pct numeric(18,6),
  prob_exhaust_pct numeric(18,6),
  raw_layer jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quote_id, layer_number)
);

CREATE INDEX IF NOT EXISTS idx_quote_np_final_expiring_probability_quote
  ON public.quote_np_final_expiring_probability (quote_id, layer_number);

CREATE TABLE IF NOT EXISTS public.quote_negotiation_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  quote_version integer,
  event_type text NOT NULL,
  actor_name text,
  actor_role text,
  reason text,
  changed_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_negotiation_event_quote_created
  ON public.quote_negotiation_event (quote_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quote_negotiation_event_type
  ON public.quote_negotiation_event (event_type);
