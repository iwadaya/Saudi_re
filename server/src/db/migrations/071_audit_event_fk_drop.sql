-- 071: Drop FK from contract_audit_event.contract_id to contract.contract_id
--
-- Background:
--   The DELETE handler in routes/treaties.js correctly:
--     1. Deletes the contract row
--     2. Logs a 'DELETED' audit event referencing the just-deleted contract_id
--
--   The FK rejects step 2 because the contract row no longer exists.
--   logAudit catches the error and only logs a warning, so the user-facing
--   DELETE succeeds — but the audit trail silently drops the most important
--   event in the contract's lifecycle.
--
-- Why drop the FK rather than reorder?
--   An audit table by definition outlives the entities it records. We WANT
--   to be able to query "show all events for contract X, including its
--   deletion" months after the contract is gone. Keeping the FK forces a
--   choice between losing the deletion record (current behavior) or
--   cascading the entire audit history away (worse).
--
-- Schema-drift note:
--   The FK exists under TWO names depending on DB history:
--     - contract_audit_event_contract_id_fkey  (Postgres auto-generated,
--                                               with ON DELETE CASCADE,
--                                               present on older databases)
--     - fk_contract_audit_event_contract_id    (explicit name from
--                                               migration 057, present on
--                                               fresh CI databases)
--   We drop both to be safe. Idempotent — no-ops on either branch.
DO $$ BEGIN
  ALTER TABLE public.contract_audit_event
    DROP CONSTRAINT IF EXISTS fk_contract_audit_event_contract_id;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.contract_audit_event
    DROP CONSTRAINT IF EXISTS contract_audit_event_contract_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
