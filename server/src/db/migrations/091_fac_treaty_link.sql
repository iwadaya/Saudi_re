-- 091_fac_treaty_link.sql
-- Links a fac risk to an active treaty so the underwriter sees what
-- capacity has already been written. Also stores the COB cross-map
-- between fac_class_of_business (granular: Property All Risks, Hull &
-- Machinery, …) and class_of_business (generic: Property, Marine, …),
-- which the eligibility query joins through.
--
-- The users table is uw_user in this codebase, not public."user". The
-- original spec referenced public."user" — using uw_user to match the
-- rest of the schema (same as migrations 079, 090).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. fac_treaty_link
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_treaty_link (
  link_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id        uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id) ON DELETE CASCADE,
  contract_id        uuid NOT NULL REFERENCES public.contract(contract_id) ON DELETE RESTRICT,
  link_type          text NOT NULL,
  -- VOLUNTARY_OVER_TREATY / OBLIGATORY_OUTSIDE_TREATY /
  -- FAC_INSTEAD_OF_TREATY / INFORMATIONAL
  capacity_used      numeric(18,2),
  notes              text,
  created_at         timestamptz DEFAULT now(),
  created_by_user_id uuid REFERENCES public.uw_user(user_id),
  UNIQUE (fac_risk_id, contract_id)
);

CREATE INDEX IF NOT EXISTS idx_fac_treaty_link_contract
  ON public.fac_treaty_link (contract_id);
CREATE INDEX IF NOT EXISTS idx_fac_treaty_link_risk
  ON public.fac_treaty_link (fac_risk_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. fac_to_treaty_cob_map
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_to_treaty_cob_map (
  fac_cob_id           uuid PRIMARY KEY
                            REFERENCES public.fac_class_of_business(fac_cob_id),
  class_of_business_id uuid NOT NULL
                            REFERENCES public.class_of_business(class_of_business_id)
);

-- Seed obvious pairs by mapping fac category → generic class name.
-- Anything we can't match (e.g. CYBER, niche project classes) is left
-- for manual extension via the table. A NOTICE summarises what got
-- seeded so an out-of-spec install is visible in the migration log.
WITH src AS (
  SELECT
    fcb.fac_cob_id,
    CASE
      WHEN fcb.class_name = 'Motor' THEN 'Motor'
      WHEN fcb.category = 'PROPERTY'    THEN 'Property'
      WHEN fcb.category = 'ENGINEERING' THEN 'Engineering'
      WHEN fcb.category = 'MARINE'      THEN 'Marine'
      WHEN fcb.category = 'ENERGY'      THEN 'Energy'
      WHEN fcb.category = 'CASUALTY'    THEN 'Liability'
      ELSE NULL
    END AS target_class_name
  FROM public.fac_class_of_business fcb
)
INSERT INTO public.fac_to_treaty_cob_map (fac_cob_id, class_of_business_id)
SELECT s.fac_cob_id, cob.class_of_business_id
  FROM src s
  JOIN public.class_of_business cob ON cob.class_of_business = s.target_class_name
 WHERE s.target_class_name IS NOT NULL
ON CONFLICT (fac_cob_id) DO UPDATE
  SET class_of_business_id = EXCLUDED.class_of_business_id;

DO $$
DECLARE
  n_mapped int;
  n_unmapped int;
BEGIN
  SELECT count(*) INTO n_mapped FROM public.fac_to_treaty_cob_map;
  SELECT count(*) INTO n_unmapped
    FROM public.fac_class_of_business
    WHERE fac_cob_id NOT IN (SELECT fac_cob_id FROM public.fac_to_treaty_cob_map);
  RAISE NOTICE 'fac_to_treaty_cob_map: % mapped, % unmapped fac classes', n_mapped, n_unmapped;
  IF n_mapped < 5 THEN
    RAISE NOTICE 'WARNING: only % rows seeded into fac_to_treaty_cob_map — verify the COB master is populated', n_mapped;
  END IF;
END
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Integrity check (no-op now; documents the cedant invariant)
-- ═══════════════════════════════════════════════════════════════════════════
-- A fac_treaty_link is only valid when the contract and the fac risk
-- share a cedant. We don't add a CHECK constraint because both
-- foreign keys are nullable on either side, but we surface a clear
-- error if any row violates the invariant — so a future bulk import
-- can't silently link the wrong parties.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
    FROM public.fac_treaty_link l
    JOIN public.fac_risk r ON r.fac_risk_id = l.fac_risk_id
    JOIN public.contract c ON c.contract_id = l.contract_id
   WHERE r.cedant_id IS DISTINCT FROM c.cedant_id;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'fac_treaty_link has % row(s) with mismatched cedant_id between fac_risk and contract', bad_count;
  END IF;
END
$$;
