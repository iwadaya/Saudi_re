-- Migration 002: Contract/Quote ownership & assignment tracking
-- Adds columns and history table for the assignment system.
-- Requires migration 001 (uw_user table).

BEGIN;

-- 1. ADD OWNERSHIP COLUMNS
ALTER TABLE public.contract
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid REFERENCES public.uw_user(user_id);

CREATE INDEX IF NOT EXISTS idx_contract_assigned_to ON public.contract (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_contract_created_by ON public.contract (created_by_user_id);

ALTER TABLE public.quote
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid REFERENCES public.uw_user(user_id);

CREATE INDEX IF NOT EXISTS idx_quote_assigned_to ON public.quote (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_quote_created_by ON public.quote (created_by_user_id);

-- 2. ASSIGNMENT HISTORY
CREATE TABLE IF NOT EXISTS public.contract_assignment_history (
  assignment_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type       text NOT NULL,
  entity_id         uuid NOT NULL,
  from_user_id      uuid REFERENCES public.uw_user(user_id),
  to_user_id        uuid NOT NULL REFERENCES public.uw_user(user_id),
  assigned_by       uuid NOT NULL REFERENCES public.uw_user(user_id),
  assignment_type   text NOT NULL CHECK (assignment_type IN ('CREATED','SELF_ASSIGNED','REASSIGNED')),
  comment           text,
  assigned_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignment_history_entity
  ON public.contract_assignment_history (entity_type, entity_id, assigned_at DESC);

COMMIT;
