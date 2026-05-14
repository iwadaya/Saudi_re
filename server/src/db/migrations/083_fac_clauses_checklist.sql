-- 083_fac_clauses_checklist.sql
-- Per-risk clauses & exclusions checklist (LM7 / ABI / LMA 3100 / NMA 2919
-- / NMA 2915 / LM3 NMA 2737). The catalogue lives in fac_clause_master
-- (seeded in 078); this table only stores the underwriter's tick + a
-- free-text comment per (risk, clause) pair. Composite PK + ON DELETE
-- CASCADE means a deleted risk also drops its checklist rows.

CREATE TABLE IF NOT EXISTS public.fac_clauses_checklist (
  fac_risk_id  uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  clause_code  text NOT NULL REFERENCES public.fac_clause_master(clause_code),
  is_checked   boolean DEFAULT false,
  comments     text,
  updated_at   timestamptz DEFAULT now(),
  PRIMARY KEY (fac_risk_id, clause_code)
);

CREATE OR REPLACE FUNCTION public.fac_clauses_checklist_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fac_clauses_checklist_touch ON public.fac_clauses_checklist;
CREATE TRIGGER trg_fac_clauses_checklist_touch
  BEFORE UPDATE ON public.fac_clauses_checklist
  FOR EACH ROW EXECUTE FUNCTION public.fac_clauses_checklist_touch();
