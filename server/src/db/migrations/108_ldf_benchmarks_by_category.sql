-- 108: Segregate LDF benchmarks by treaty category (PROPORTIONAL vs NON_PROPORTIONAL).
--
-- Paid/incurred development on a proportional triangle (ground-up cession)
-- looks quite different from non-proportional (excess of loss), so blending
-- across categories would muddy the curve. We add treaty_category as a
-- grouping dimension to all four MVs and require callers to pick a side
-- when looking up benchmarks.
--
-- Migration is a drop/recreate (not an in-place add) because the unique
-- indexes that CONCURRENTLY refresh depends on need to include the new
-- key column.

DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_global  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_region  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_country CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_contributions     CASCADE;
DROP FUNCTION  IF EXISTS public.refresh_ldf_benchmarks();

-- ── per-contract per-class contribution rows ──────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_contributions AS
SELECT
    cdf.contract_id,
    ccob.class_of_business_id,
    ces.premium                              AS class_premium,
    c.country_id,
    co.region                                AS region,
    tt.category                              AS treaty_category,
    cdf.triangle_type,
    cdf.dev_month,
    cdf.selected_ldf                         AS ldf
FROM public.contract_dev_factor cdf
JOIN public.contract                   c    ON c.contract_id = cdf.contract_id
JOIN public.contract_class_of_business ccob ON ccob.contract_id = cdf.contract_id
LEFT JOIN public.contract_epi_split ces
       ON ces.contract_id = cdf.contract_id
      AND ces.class_of_business_id = ccob.class_of_business_id
LEFT JOIN public.country     co ON co.country_id     = c.country_id
LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
WHERE c.status IN ('SIGNED','DECLINED','NTU')
  AND cdf.selected_ldf IS NOT NULL
  AND cdf.selected_ldf BETWEEN 0.5 AND 10.0
  AND cdf.triangle_type IN ('PREMIUM','CLAIMS_PAID','CLAIMS_OS','INCURRED')
  AND tt.category IN ('PROPORTIONAL','NON_PROPORTIONAL');

CREATE UNIQUE INDEX mv_ldf_contrib_pk
    ON public.mv_ldf_contributions
       (contract_id, class_of_business_id, triangle_type, dev_month);

CREATE INDEX mv_ldf_contrib_lookup
    ON public.mv_ldf_contributions
       (class_of_business_id, triangle_type, treaty_category, dev_month, country_id);

CREATE INDEX mv_ldf_contrib_region
    ON public.mv_ldf_contributions
       (class_of_business_id, triangle_type, treaty_category, dev_month, region);

-- ── COUNTRY scope ─────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_country AS
SELECT
    class_of_business_id,
    country_id,
    treaty_category,
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
WHERE country_id IS NOT NULL
GROUP BY class_of_business_id, country_id, treaty_category, triangle_type, dev_month;

CREATE UNIQUE INDEX mv_ldf_country_pk
    ON public.mv_ldf_benchmark_country
       (class_of_business_id, country_id, treaty_category, triangle_type, dev_month);

-- ── REGION scope ──────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_region AS
SELECT
    class_of_business_id,
    region,
    treaty_category,
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
GROUP BY class_of_business_id, region, treaty_category, triangle_type, dev_month;

CREATE UNIQUE INDEX mv_ldf_region_pk
    ON public.mv_ldf_benchmark_region
       (class_of_business_id, region, treaty_category, triangle_type, dev_month);

-- ── GLOBAL scope ──────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_global AS
SELECT
    class_of_business_id,
    treaty_category,
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
GROUP BY class_of_business_id, treaty_category, triangle_type, dev_month;

CREATE UNIQUE INDEX mv_ldf_global_pk
    ON public.mv_ldf_benchmark_global
       (class_of_business_id, treaty_category, triangle_type, dev_month);

-- ── Refresh helper ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_ldf_benchmarks()
RETURNS void LANGUAGE sql AS $$
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_contributions;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_country;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_region;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_ldf_benchmark_global;
$$;

COMMENT ON MATERIALIZED VIEW public.mv_ldf_benchmark_country IS
  'Volume-weighted average LDFs per class × country × treaty_category × triangle_type × dev_month. Refreshed via public.refresh_ldf_benchmarks().';
