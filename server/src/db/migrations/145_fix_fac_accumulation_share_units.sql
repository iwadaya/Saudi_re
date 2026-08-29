-- 145_fix_fac_accumulation_share_units.sql
-- Fix the share units in mv_fac_accumulation (migration 137).
--
-- The facultative leg multiplied SI/PML by
--   COALESCE(l.carrier_pd_share_pct, r.our_share_pct, r.ri_share_pct, 1)
-- which mixes two unit conventions. fac_location.carrier_pd_share_pct /
-- carrier_bi_share_pct are FRACTIONS 0..1 (validation/facultative.js
-- optionalFraction01), but fac_risk.our_share_pct / ri_share_pct are WHOLE
-- PERCENT 0..100 (validation/facultative.js pct100 — a 25% line is stored as
-- 25, not 0.25). Whenever the risk-level fallback applied, committed exposure
-- came out 100x too large: our_share_pct=25 on a 100m location with a 0.4 PML
-- produced 1,000,000,000 of committed PML instead of 10,000,000. That figure
-- feeds the bind-time accumulation gate and every fac_zone_budget comparison.
--
-- The fix divides the risk-level fallbacks by 100 so every branch of the
-- COALESCE is a fraction. The view is otherwise copied verbatim from 137
-- (which cannot be edited — it is already applied everywhere).

DROP MATERIALIZED VIEW IF EXISTS public.mv_fac_accumulation;
CREATE MATERIALIZED VIEW public.mv_fac_accumulation AS
  SELECT
    l.cresta_zone,
    r.country_id,
    COALESCE(c.rating_family, 'SCHEDULE_PROPERTY') AS rating_family,
    r.uw_year,
    'FAC'::text AS source_kind,
    SUM(
      (COALESCE(l.pd_si, 0) + COALESCE(l.bi_si, 0))
      * COALESCE(l.carrier_pd_share_pct, r.our_share_pct / 100.0, r.ri_share_pct / 100.0, 1)
    ) AS committed_si,
    SUM(
      COALESCE(l.pd_si, 0) * COALESCE(l.pd_pml_pct, 1)
      * COALESCE(l.carrier_pd_share_pct, r.our_share_pct / 100.0, r.ri_share_pct / 100.0, 1)
      + COALESCE(l.bi_si, 0) * COALESCE(l.bi_pml_pct, 1)
      * COALESCE(l.carrier_bi_share_pct, l.carrier_pd_share_pct,
                 r.our_share_pct / 100.0, r.ri_share_pct / 100.0, 1)
    ) AS committed_pml,
    COUNT(DISTINCT r.fac_risk_id) AS risk_count
  FROM public.fac_risk r
  JOIN public.fac_location l ON l.fac_risk_id = r.fac_risk_id
  LEFT JOIN public.fac_class_of_business c ON c.fac_cob_id = r.fac_cob_id
  WHERE r.status = 'BOUND'
    AND l.cresta_zone IS NOT NULL
    AND l.cresta_zone <> ''
  GROUP BY 1, 2, 3, 4

  UNION ALL

  SELECT
    d.zone_id AS cresta_zone,
    d.country_id,
    'TREATY'::text AS rating_family,
    ct.uw_year,
    'TREATY'::text AS source_kind,
    SUM(COALESCE(d.eq_agg,0) + COALESCE(d.ws_agg,0) + COALESCE(d.flood_agg,0)
        + COALESCE(d.srcc_agg,0) + COALESCE(d.others_agg,0)) AS committed_si,
    NULL::numeric AS committed_pml,
    COUNT(DISTINCT ct.contract_id) AS risk_count
  FROM public.contract ct
  JOIN public.contract_cresta_data d ON d.contract_id = ct.contract_id
  WHERE d.zone_id IS NOT NULL AND d.zone_id <> ''
  GROUP BY 1, 2, 3, 4;

-- REFRESH MATERIALIZED VIEW CONCURRENTLY (facAccumulationService.js) needs
-- this unique index — same key as migration 137 created.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fac_accumulation_key
  ON public.mv_fac_accumulation (cresta_zone, rating_family, source_kind, uw_year, country_id);
