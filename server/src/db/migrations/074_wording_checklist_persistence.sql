BEGIN;

CREATE TABLE IF NOT EXISTS public.wording_checklist_item (
  item_key      text PRIMARY KEY,
  section_key   text NOT NULL,
  section_title text NOT NULL,
  label         text NOT NULL,
  display_order integer NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.wording_checklist_item (item_key, section_key, section_title, label, display_order, is_active)
VALUES
  ('claimClause', 'generalClauses', 'General Clauses', 'Claim Clause', 10, true),
  ('contingentBusinessInterruptionClause', 'generalClauses', 'General Clauses', 'Contingent Business Interruption Clause', 20, true),
  ('fullInterestAbroadClause', 'generalClauses', 'General Clauses', 'Full Interest Abroad Clause', 30, true),
  ('downgradingClause', 'generalClauses', 'General Clauses', 'Downgrading Clause', 40, true),
  ('sanctionLimitationClause', 'generalClauses', 'General Clauses', 'Sanction & Limitation Clause', 50, true),
  ('interlockingClause', 'generalClauses', 'General Clauses', 'Interlocking Clause', 60, true),
  ('claimCooperationClause', 'generalClauses', 'General Clauses', 'Claim Cooperation Clause', 70, true),
  ('transmissionDistributionLine', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Transmission and Distribution Line (1,000 m)', 110, true),
  ('russiaUkraineBelarus', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Russia, Ukraine and Belarus', 120, true),
  ('strikesRiotsCivilCommotion', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Strikes, riots, civil commotion', 130, true),
  ('warTerrorismIncludingNCB', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'War & Terrorism including NCB', 140, true),
  ('communicableDisease', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Communicable disease', 150, true),
  ('cyberLoss', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Cyber loss', 160, true),
  ('usaCanada', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'USA / CANADA', 170, true),
  ('nuclearEnergy', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Nuclear Energy', 180, true),
  ('seepagePollutionContamination', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Seepage, Pollution and Contamination', 190, true),
  ('creditInsurance', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Credit Insurance', 200, true),
  ('offshoreEnergy', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Offshore Energy', 210, true),
  ('mandatoryPools', 'exclusionClausesPerils', 'Exclusion Clauses / Perils', 'Risks ceded to mandatory pools', 220, true),
  ('scopeInclusions', 'territorialScope', 'Territorial Scope', 'Territorial scope (inclusions) confirmed', 310, true),
  ('scopeExclusions', 'territorialScope', 'Territorial Scope', 'Territorial exclusions confirmed', 320, true)
ON CONFLICT (item_key) DO UPDATE SET
  section_key = EXCLUDED.section_key,
  section_title = EXCLUDED.section_title,
  label = EXCLUDED.label,
  display_order = EXCLUDED.display_order,
  is_active = EXCLUDED.is_active,
  updated_at = now();

CREATE TABLE IF NOT EXISTS public.contract_wording_checklist_run (
  analysis_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     uuid REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  quote_id        uuid REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  document_id     uuid REFERENCES public.contract_document(document_id) ON DELETE SET NULL,
  doc_type        text,
  provider        text NOT NULL DEFAULT 'manual',
  status          text NOT NULL DEFAULT 'completed',
  summary         text,
  raw_result      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_wording_checklist_run_entity_chk CHECK (
    (contract_id IS NOT NULL AND quote_id IS NULL) OR
    (contract_id IS NULL AND quote_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.contract_wording_checklist (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid REFERENCES public.contract(contract_id) ON DELETE CASCADE,
  quote_id           uuid REFERENCES public.quote(quote_id) ON DELETE CASCADE,
  item_key           text NOT NULL REFERENCES public.wording_checklist_item(item_key),
  status             text NOT NULL DEFAULT 'unknown',
  source             text NOT NULL DEFAULT 'manual',
  evidence           text,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  checked_by_user_id uuid REFERENCES public.uw_user(user_id) ON DELETE SET NULL,
  document_id        uuid REFERENCES public.contract_document(document_id) ON DELETE SET NULL,
  analysis_run_id    uuid REFERENCES public.contract_wording_checklist_run(analysis_run_id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_wording_checklist_status_chk CHECK (status IN ('found', 'missing', 'partial', 'unknown')),
  CONSTRAINT contract_wording_checklist_source_chk CHECK (source IN ('manual', 'ai', 'heuristic')),
  CONSTRAINT contract_wording_checklist_entity_chk CHECK (
    (contract_id IS NOT NULL AND quote_id IS NULL) OR
    (contract_id IS NULL AND quote_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_wording_checklist_contract_item
  ON public.contract_wording_checklist(contract_id, item_key)
  WHERE contract_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_wording_checklist_quote_item
  ON public.contract_wording_checklist(quote_id, item_key)
  WHERE quote_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_wording_checklist_run_contract
  ON public.contract_wording_checklist_run(contract_id)
  WHERE contract_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contract_wording_checklist_run_quote
  ON public.contract_wording_checklist_run(quote_id)
  WHERE quote_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wording_checklist_item_updated') THEN
      CREATE TRIGGER trg_wording_checklist_item_updated
        BEFORE UPDATE ON public.wording_checklist_item
        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contract_wording_checklist_updated') THEN
      CREATE TRIGGER trg_contract_wording_checklist_updated
        BEFORE UPDATE ON public.contract_wording_checklist
        FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
    END IF;
  END IF;
END $$;

COMMIT;
