-- 154: Perform migration 104's intended fac cleanup against the real table
--       name (audit F85).
--
-- 104's pre-delete guard checked information_schema for a table named
-- 'facultative_risk', which has never existed — the real table is fac_risk
-- (fac_risk.linked_contract_id → contract.contract_id, default NO ACTION).
-- The guard therefore never fired, and 104's DELETE FROM public.contract
-- would abort with a 23503 FK violation on any database where a
-- required-column-violating contract was linked from a fac risk. On this DB
-- 104 happened to succeed because no such link existed.
--
-- 104 itself must not be edited (it is recorded as applied), so this
-- migration re-runs the intended null-out with the correct table name and
-- then re-runs the cleanup DELETE. On every database where 104 completed the
-- required columns are already NOT NULL, so both statements match zero rows
-- and this is a cheap no-op — but the corpus now contains the cleanup as it
-- was actually intended, and a fresh install replays it correctly.
--
-- Verified on the live test DB before writing: 0 contracts violate the
-- required columns and 0 fac_risk rows carry a linked_contract_id.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='fac_risk' AND column_name='linked_contract_id'
  ) THEN
    UPDATE public.fac_risk
       SET linked_contract_id = NULL
     WHERE linked_contract_id IN (
       SELECT contract_id FROM public.contract
        WHERE cedant_id      IS NULL
           OR broker_id      IS NULL
           OR currency_id    IS NULL
           OR country_id     IS NULL
           OR treaty_type_id IS NULL
           OR inception_date IS NULL
     );
  END IF;
END $$;

-- Re-run 104's cleanup DELETE. No-op wherever 104 completed (the columns are
-- NOT NULL there, so the predicate can never match); the child tables that
-- reference contract without CASCADE were already handled by 104's other two
-- (correctly-named) guards, and the fac_risk null-out above now covers the
-- one it missed.
DELETE FROM public.contract
 WHERE cedant_id        IS NULL
    OR broker_id        IS NULL
    OR currency_id      IS NULL
    OR country_id       IS NULL
    OR treaty_type_id   IS NULL
    OR inception_date   IS NULL;
