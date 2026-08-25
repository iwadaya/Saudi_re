-- 141_fac_accumulation_share_scale_fix.sql
--
-- fac_location carrier shares are stored as fractions (0..1), but fac_risk
-- our_share_pct / ri_share_pct are stored as percentages (0..100). The phase-4
-- accumulation view used risk-level shares as whole multipliers when location
-- share was absent, overstating committed exposure (e.g. 15% became 15x).
-- Rebuild mv_fac_accumulation with the correct /100 fallback.

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
      * COALESCE(l.carrier_pd_share_pct, COALESCE(r.our_share_pct, r.ri_share_pct, 100) / 100.0)
    ) AS committed_si,
    SUM(
      COALESCE(l.pd_si, 0) * COALESCE(l.pd_pml_pct, 1)
      * COALESCE(l.carrier_pd_share_pct, COALESCE(r.our_share_pct, r.ri_share_pct, 100) / 100.0)
      + COALESCE(l.bi_si, 0) * COALESCE(l.bi_pml_pct, 1)
      * COALESCE(
        l.carrier_bi_share_pct,
        l.carrier_pd_share_pct,
        COALESCE(r.our_share_pct, r.ri_share_pct, 100) / 100.0
      )
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fac_accumulation_key
  ON public.mv_fac_accumulation (cresta_zone, rating_family, source_kind, uw_year, country_id);
