-- Migration 062: Actuarial Formula Workbench
--
-- Three tables backing the standalone Workbench screen, where actuaries
-- can edit pricing parameters, propose changes for approval, leave
-- comments, and see a full change history.
--
-- formula_parameters
--   One row per (module, formula_name, parameter_key). current_value is
--   the live value engines should read; pending_value carries an actuary's
--   proposed change while it sits awaiting an approver.
--
-- formula_change_log
--   Append-only history. Every status transition (submit, approve, reject)
--   writes a row so we can show the diff and audit trail in the UI.
--
-- formula_comments
--   Threaded discussion attached to a formula_name. parent_comment_id
--   carries the thread relationship.

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

CREATE TABLE IF NOT EXISTS public.formula_comments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module             text NOT NULL,
  formula_name       text NOT NULL,
  comment_text       text NOT NULL,
  author_id          uuid,
  author_name        text,
  author_role        text,
  parent_comment_id  uuid REFERENCES public.formula_comments(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_formula_comments_formula
  ON public.formula_comments (module, formula_name, created_at DESC);
