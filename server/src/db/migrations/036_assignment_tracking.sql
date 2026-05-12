-- Migration 036: Full assignment tracking
-- Ensures contract_assignment_history exists and adds profile-view tracking.
-- All additive, all idempotent.

CREATE TABLE IF NOT EXISTS public.contract_assignment_history (
  history_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN ('CONTRACT','QUOTE')),
  entity_id     uuid NOT NULL,
  from_user_id  uuid REFERENCES public.uw_user(user_id),
  to_user_id    uuid NOT NULL REFERENCES public.uw_user(user_id),
  assigned_by   uuid REFERENCES public.uw_user(user_id),
  action        text NOT NULL DEFAULT 'ASSIGNED'
    CHECK (action IN ('ASSIGNED','SELF_ASSIGNED','ALLOCATED','RETURNED','VIEWED_AS')),
  comment       text,
  assigned_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assign_history_entity ON public.contract_assignment_history (entity_type, entity_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_assign_history_to     ON public.contract_assignment_history (to_user_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_assign_history_by     ON public.contract_assignment_history (assigned_by, assigned_at DESC);

-- Ensure assigned_to_user_id on contract (migration 002 should have done this)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract' AND column_name='assigned_to_user_id') THEN
    ALTER TABLE public.contract ADD COLUMN assigned_to_user_id uuid REFERENCES public.uw_user(user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract' AND column_name='created_by_user_id') THEN
    ALTER TABLE public.contract ADD COLUMN created_by_user_id uuid REFERENCES public.uw_user(user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='assigned_to_user_id') THEN
    ALTER TABLE public.quote ADD COLUMN assigned_to_user_id uuid REFERENCES public.uw_user(user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='created_by_user_id') THEN
    ALTER TABLE public.quote ADD COLUMN created_by_user_id uuid REFERENCES public.uw_user(user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contract_assigned_to ON public.contract (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_quote_assigned_to    ON public.quote    (assigned_to_user_id);
