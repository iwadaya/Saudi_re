-- 105: Benchmark LDFs by class × scope, derived from contract_dev_factor.
--
-- We materialise three views (country / region / global) of volume-weighted
-- average LDFs per class_of_business × triangle_type × dev_month.
--
-- Weight = the contract's gross premium on that class (from contract_epi_split).
-- A contract contributes to a class's benchmark only if:
--   - the contract is bound (status = 'BOUND')
--   - the dev factor was actually selected (selected_ldf IS NOT NULL)
--   - the class appears on the contract's COB list
--   - the LDF is within sanity bounds (0.5 ≤ LDF ≤ 10) — outliers are
--     suppressed at the source to keep weighted averages stable
--
-- Refresh: REFRESH MATERIALIZED VIEW CONCURRENTLY on a nightly cron, plus
-- after each contract is bound (handled in routes/contracts.js).

-- ── per-contract per-class contribution rows (the building block) ─────────
CREATE MATERIALIZED VIEW public.mv_ldf_contributions AS
SELECT
    cdf.contract_id,
    ccob.class_of_business_id,
    ces.premium                              AS class_premium,
    c.country_id,
    co.region                                AS region,
    cdf.triangle_type,
    cdf.dev_month,
    cdf.selected_ldf                         AS ldf
FROM public.contract_dev_factor cdf
JOIN public.contracts          c    ON c.contract_id = cdf.contract_id
JOIN public.contract_class_of_business ccob ON ccob.contract_id = cdf.contract_id
LEFT JOIN public.contract_epi_split ces
       ON ces.contract_id = cdf.contract_id
      AND ces.class_of_business_id = ccob.class_of_business_id
LEFT JOIN public.country co ON co.country_id = c.country_id
WHERE c.status = 'BOUND'
  AND cdf.selected_ldf IS NOT NULL
  AND cdf.selected_ldf BETWEEN 0.5 AND 10.0
  AND cdf.triangle_type IN ('PREMIUM','CLAIMS_PAID','CLAIMS_OS','INCURRED');

CREATE INDEX mv_ldf_contrib_lookup
    ON public.mv_ldf_contributions
       (class_of_business_id, triangle_type, dev_month, country_id);

CREATE INDEX mv_ldf_contrib_region
    ON public.mv_ldf_contributions
       (class_of_business_id, triangle_type, dev_month, region);

-- ── COUNTRY scope ─────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_country AS
SELECT
    class_of_business_id,
    country_id,
    triangle_type,
    dev_month,
    COUNT(DISTINCT contract_id) AS n_contracts,
    SUM(COALESCE(class_premium, 0)) AS total_premium,
    -- volume weighted (NULL falls back to simple average via COALESCE)
    CASE WHEN SUM(COALESCE(class_premium, 0)) > 0
         THEN SUM(ldf * COALESCE(class_premium, 0)) / SUM(COALESCE(class_premium, 0))
         ELSE AVG(ldf)
    END AS weighted_ldf,
    AVG(ldf) AS simple_ldf,
    STDDEV_POP(ldf) AS stddev_ldf,
    MIN(ldf) AS min_ldf,
    MAX(ldf) AS max_ldf
FROM public.mv_ldf_contributions
WHERE country_id IS NOT NULL
GROUP BY class_of_business_id, country_id, triangle_type, dev_month;

CREATE UNIQUE INDEX mv_ldf_country_pk
    ON public.mv_ldf_benchmark_country
       (class_of_business_id, country_id, triangle_type, dev_month);

-- ── REGION scope ──────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_region AS
SELECT
    class_of_business_id,
    region,
    triangle_type,
    dev_month,
    COUNT(DISTINCT contract_id) AS n_contracts,
    SUM(COALESCE(class_premium, 0)) AS total_premium,
    CASE WHEN SUM(COALESCE(class_premium, 0)) > 0
         THEN SUM(ldf * COALESCE(class_premium, 0)) / SUM(COALESCE(class_premium, 0))
         ELSE AVG(ldf)
    END AS weighted_ldf,
    AVG(ldf) AS simple_ldf,
    STDDEV_POP(ldf) AS stddev_ldf,
    MIN(ldf) AS min_ldf,
    MAX(ldf) AS max_ldf
FROM public.mv_ldf_contributions
WHERE region IS NOT NULL
GROUP BY class_of_business_id, region, triangle_type, dev_month;

CREATE UNIQUE INDEX mv_ldf_region_pk
    ON public.mv_ldf_benchmark_region
       (class_of_business_id, region, triangle_type, dev_month);

-- ── GLOBAL scope ──────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_global AS
SELECT
    class_of_business_id,
    triangle_type,
    dev_month,
    COUNT(DISTINCT contract_id) AS n_contracts,
    SUM(COALESCE(class_premium, 0)) AS total_premium,
    CASE WHEN SUM(COALESCE(class_premium, 0)) > 0
         THEN SUM(ldf * COALESCE(class_premium, 0)) / SUM(COALESCE(class_premium, 0))
         ELSE AVG(ldf)
    END AS weighted_ldf,
    AVG(ldf) AS simple_ldf,
    STDDEV_POP(ldf) AS stddev_ldf,
    MIN(ldf) AS min_ldf,
    MAX(ldf) AS max_ldf
FROM public.mv_ldf_contributions
GROUP BY class_of_business_id, triangle_type, dev_month;

CREATE UNIQUE INDEX mv_ldf_global_pk
    ON public.mv_ldf_benchmark_global
       (class_of_business_id, triangle_type, dev_month);

-- ── Helper function: refresh all three views ──────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_ldf_benchmarks()
RETURNS void LANGUAGE sql AS $$
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_contributions;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_country;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_region;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_global;
$$;

COMMENT ON MATERIALIZED VIEW public.mv_ldf_benchmark_country IS
  'Volume-weighted average LDFs per class × country × triangle_type × dev_month. Refreshed via public.refresh_ldf_benchmarks().';
