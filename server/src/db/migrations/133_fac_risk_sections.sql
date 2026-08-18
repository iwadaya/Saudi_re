-- 133_fac_risk_sections.sql
-- Facultative risk sections (design doc §4.5 M2, finding F6).
--
-- The Risk Detail screen has always let an underwriter split a risk into
-- up to five sections, tick several classes of business per section, and
-- enter a sum insured PER CLASS. None of that survived a save: the PUT
-- persisted only fac_risk.fac_cob_id (the first COB of the last-edited
-- section) and the summed fac_risk.total_sum_insured, so on reload the
-- screen rebuilt a single section with a single class carrying the whole
-- total. Every section boundary and per-class split was silently lost.
--
-- This table is that missing storage. It is also the seam the multi-class
-- redesign needs: a section carries its own rating family and exposure
-- base, so one risk can hold a PROJECT_WORKS section and a
-- LIABILITY_LIMIT section side by side (a CAR policy with a Section II
-- TPL) without either of them having to pretend to be property.
--
-- Columns beyond sum_insured are nullable and unused today — they are the
-- landing area for the non-property families so adding those does not
-- need another table rebuild.

CREATE TABLE IF NOT EXISTS public.fac_risk_section (
  section_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id      uuid NOT NULL
                     REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  section_no       integer NOT NULL CHECK (section_no BETWEEN 1 AND 20),
  fac_cob_id       uuid NOT NULL
                     REFERENCES public.fac_class_of_business(fac_cob_id),

  -- Resolved from the class at save time so the pricing pipeline never has
  -- to join back to the catalogue mid-compute. Nullable until migration
  -- 134 backfills the taxonomy.
  rating_family    text,

  -- The exposure base, in the units this section's family rates on.
  -- sum_insured stays the property/engineering/hull number; exposure_base
  -- + exposure_unit carry turnover, contract value, vehicle-years, etc.
  sum_insured      numeric(18,2),
  exposure_base    numeric(18,2),
  exposure_unit    text,

  -- Layer/limit structure for the families that rate to a limit.
  limit_amount     numeric(18,2),
  attachment       numeric(18,2),
  deductible       numeric(18,2),
  deductible_basis text,

  currency_id      uuid REFERENCES public.currency(currency_id),

  -- Family-schema-validated payload for everything that does not warrant a
  -- typed column (territory splits, commodity mixes, control questionnaires).
  exposure_detail  jsonb NOT NULL DEFAULT '{}'::jsonb,

  sort_order       integer DEFAULT 0,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  CONSTRAINT fac_risk_section_unique UNIQUE (fac_risk_id, section_no, fac_cob_id)
);

CREATE INDEX IF NOT EXISTS idx_fac_risk_section_risk
  ON public.fac_risk_section (fac_risk_id, section_no);
CREATE INDEX IF NOT EXISTS idx_fac_risk_section_cob
  ON public.fac_risk_section (fac_cob_id);

CREATE OR REPLACE FUNCTION public.fac_risk_section_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fac_risk_section_touch ON public.fac_risk_section;
CREATE TRIGGER trg_fac_risk_section_touch
  BEFORE UPDATE ON public.fac_risk_section
  FOR EACH ROW EXECUTE FUNCTION public.fac_risk_section_touch();


-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill: one section per existing risk that already names a class.
--
-- This reconstructs exactly what the old save path was able to express —
-- a single section, a single class, the whole sum insured — so existing
-- risks open with a section rather than an empty screen. It cannot
-- recover the splits that were never written; there is no record of them.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO public.fac_risk_section
  (fac_risk_id, section_no, fac_cob_id, sum_insured, currency_id, sort_order)
SELECT r.fac_risk_id, 1, r.fac_cob_id, r.total_sum_insured, r.currency_id, 0
FROM public.fac_risk r
WHERE r.fac_cob_id IS NOT NULL
ON CONFLICT ON CONSTRAINT fac_risk_section_unique DO NOTHING;
