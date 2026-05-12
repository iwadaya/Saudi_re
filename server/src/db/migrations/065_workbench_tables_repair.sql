-- 065_workbench_tables_repair.sql
-- Migration 062 created formula_comments but somehow skipped
-- formula_parameters and formula_change_log on Neon — every workbench
-- request 500s on 'relation "public.formula_X" does not exist'.
-- This migration is idempotent (CREATE TABLE IF NOT EXISTS) and safe to
-- run wherever the tables are missing OR already present.

CREATE TABLE IF NOT EXISTS public.formula_parameters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module          text NOT NULL,
  formula_name    text NOT NULL,
  parameter_key   text NOT NULL,
  current_value   jsonb,
  pending_value   jsonb,
  status          text NOT NULL DEFAULT 'APPROVED'
                  CHECK (status IN ('APPROVED', 'PENDING', 'REJECTED')),
  updated_by      uuid,
  updated_by_name text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (module, formula_name, parameter_key)
);

CREATE INDEX IF NOT EXISTS idx_formula_parameters_status
  ON public.formula_parameters (status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_formula_parameters_formula
  ON public.formula_parameters (module, formula_name);

CREATE TABLE IF NOT EXISTS public.formula_change_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_parameter_id  uuid NOT NULL REFERENCES public.formula_parameters(id) ON DELETE CASCADE,
  action                text NOT NULL
                        CHECK (action IN ('SUBMIT', 'APPROVE', 'REJECT', 'EDIT')),
  old_value             jsonb,
  new_value             jsonb,
  changed_by            uuid,
  changed_by_name       text,
  changed_at            timestamptz NOT NULL DEFAULT now(),
  comment               text,
  approved_by           uuid,
  approved_by_name      text,
  approved_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_formula_change_log_param
  ON public.formula_change_log (formula_parameter_id, changed_at DESC);
