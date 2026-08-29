-- 151: Count only premium-weighted contributors in the LDF benchmark
--      n_contracts (audit F108).
--
-- Contracts with no contract_epi_split row for the class (class_premium
-- NULL) — or a zero premium — counted toward n_contracts and hence the
-- >= 5 per-dev-month scope-acceptance threshold in
-- services/ldf/benchmark.js, but carry ZERO weight in weighted_ldf
-- (SUM(ldf * COALESCE(class_premium, 0)) / SUM(COALESCE(class_premium, 0))
-- ignores them). A dev-month row with 4 NULL-premium contracts and 1
-- premium-bearing one passed the credibility gate as n=5 while the number
-- that prices was a single-contract weighted average.
--
-- Fix: n_contracts now counts DISTINCT contracts with COALESCE(class_premium,
-- 0) > 0 — the contracts that actually influence weighted_ldf. A dev-month
-- row whose contributors ALL lack premium reports n_contracts = 0 (its
-- weighted_ldf falls back to AVG(ldf) via the CASE), so the threshold
-- rejects it — the conservative reading.
--
-- Everything else is IDENTICAL to migration 146's definitions:
-- mv_ldf_contributions is untouched, total_premium / weighted_ldf /
-- simple_ldf / stddev / min / max are unchanged, and every unique index
-- required by REFRESH MATERIALIZED VIEW CONCURRENTLY is recreated.
-- Drop/recreate (same approach as 105/108/146) because a materialized
-- view's SELECT cannot be altered in place.

DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_global  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_region  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_country CASCADE;

-- ── COUNTRY scope ─────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_benchmark_country AS
SELECT
    class_of_business_id,
    country_id,
    treaty_category,
    triangle_type,
    dev_month,
    COUNT(DISTINCT contract_id)
        FILTER (WHERE COALESCE(class_premium, 0) > 0) AS n_contracts,
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
    COUNT(DISTINCT contract_id)
        FILTER (WHERE COALESCE(class_premium, 0) > 0) AS n_contracts,
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
    COUNT(DISTINCT contract_id)
        FILTER (WHERE COALESCE(class_premium, 0) > 0) AS n_contracts,
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

COMMENT ON MATERIALIZED VIEW public.mv_ldf_benchmark_country IS
  'Volume-weighted average LDFs per class × country × treaty_category × triangle_type × dev_month. Weights and total_premium are USD (migration 146). n_contracts counts only premium-weighted contributors — contracts with a positive USD class premium (migration 151) — so the >=5 credibility gate cannot be passed by contracts that carry no weight in weighted_ldf. Refreshed via public.refresh_ldf_benchmarks().';
