-- 148: Missing FKs on contract_loss_selection_snapshot_item.snapshot_id and
--       contract_gem_eq_scenario.contract_id (audit F34).
--
-- contract_loss_selection_snapshot_item was created by the 000 core dump with
-- NO foreign key on snapshot_id — migration 012's version (REFERENCES ... ON
-- DELETE CASCADE) was a CREATE TABLE IF NOT EXISTS no-op. The snapshot HEADER
-- cascades away when its contract/quote is deleted (FKs from 057/072), so
-- every quote/contract delete permanently orphaned the item rows.
-- contract_gem_eq_scenario (migration 125) has the same hole on contract_id.
--
-- Pattern follows the 057 FK-retrofit runbook: delete existing orphans, ADD
-- CONSTRAINT ... NOT VALID (no full-table validation scan while the ACCESS
-- EXCLUSIVE lock is held), then VALIDATE in the same migration — safe here
-- because the orphans were just removed, and it keeps these two constraints
-- out of the NOT-VALID backlog that maintenance/validate_not_valid_fks.sql
-- has to chase.

DELETE FROM public.contract_loss_selection_snapshot_item i
 WHERE NOT EXISTS (SELECT 1 FROM public.contract_loss_selection_snapshot s
                    WHERE s.snapshot_id = i.snapshot_id);

ALTER TABLE public.contract_loss_selection_snapshot_item
  ADD CONSTRAINT fk_snapshot_item_snapshot_id
  FOREIGN KEY (snapshot_id)
  REFERENCES public.contract_loss_selection_snapshot(snapshot_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.contract_loss_selection_snapshot_item
  VALIDATE CONSTRAINT fk_snapshot_item_snapshot_id;

DELETE FROM public.contract_gem_eq_scenario g
 WHERE NOT EXISTS (SELECT 1 FROM public.contract c
                    WHERE c.contract_id = g.contract_id);

ALTER TABLE public.contract_gem_eq_scenario
  ADD CONSTRAINT fk_contract_gem_eq_scenario_contract_id
  FOREIGN KEY (contract_id)
  REFERENCES public.contract(contract_id)
  ON DELETE CASCADE
  NOT VALID;

ALTER TABLE public.contract_gem_eq_scenario
  VALIDATE CONSTRAINT fk_contract_gem_eq_scenario_contract_id;
