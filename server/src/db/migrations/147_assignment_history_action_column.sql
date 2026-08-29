-- 147: Repair contract_assignment_history schema drift (audit F33).
--
-- Migration 002 created contract_assignment_history with an `assignment_type`
-- column (CHECK: CREATED / SELF_ASSIGNED / REASSIGNED). Migration 036 meant to
-- redefine the table with an `action` column (ASSIGNED / SELF_ASSIGNED /
-- ALLOCATED / RETURNED / VIEWED_AS) but used CREATE TABLE IF NOT EXISTS, which
-- no-opped. services/assignments.js was written against 036's shape, so every
-- history INSERT failed with 42703 (column "action" does not exist), the error
-- was swallowed, and the assignment audit trail stayed permanently empty.
--
-- Fix: rename assignment_type -> action and widen the CHECK to the union of
-- both vocabularies, so existing rows (if any) stay valid and both the legacy
-- values and the ones the service actually writes ('ALLOCATED','ASSIGNED',
-- 'SELF_ASSIGNED') are accepted.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='contract_assignment_history'
                AND column_name='assignment_type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='contract_assignment_history'
                AND column_name='action') THEN
    ALTER TABLE public.contract_assignment_history RENAME COLUMN assignment_type TO action;
  END IF;
END $$;

-- Replace whichever CHECK is present (the 002 name, or 036's on a DB where the
-- intended shape did apply) with the union vocabulary.
ALTER TABLE public.contract_assignment_history
  DROP CONSTRAINT IF EXISTS contract_assignment_history_assignment_type_check;
ALTER TABLE public.contract_assignment_history
  DROP CONSTRAINT IF EXISTS contract_assignment_history_action_check;
ALTER TABLE public.contract_assignment_history
  ADD CONSTRAINT contract_assignment_history_action_check
  CHECK (action IN ('ASSIGNED','SELF_ASSIGNED','ALLOCATED','RETURNED','VIEWED_AS',
                    'CREATED','REASSIGNED'));

-- 036 intended a default; harmless for the service (it always sends action).
ALTER TABLE public.contract_assignment_history
  ALTER COLUMN action SET DEFAULT 'ASSIGNED';
