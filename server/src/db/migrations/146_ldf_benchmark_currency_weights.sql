-- 146: Currency-normalise the LDF benchmark volume weights (audit F24).
--
-- mv_ldf_contributions weighted each contract by its RAW contract_epi_split
-- premium in the contract's native currency, so region/global (and any
-- mixed-currency country) benchmarks were dominated by low-unit-value
-- currencies: two economically equal treaties — 780,000,000 JPY
-- (= 5,031,000 USD @ 0.00645) with LDF 1.8 and 5,000,000 USD with LDF 1.2 —
-- produced weighted_ldf 1.796 instead of the currency-correct
-- (1.8·5,031,000 + 1.2·5,000,000)/10,031,000 = 1.5009, and total_premium was
-- a meaningless JPY+USD sum.
--
-- Fix: join the LATEST ref_exchange_rate per contract currency (highest
-- effective_date, same normalisation the dashboard / facClassAccumulationService
-- use) and weight by premium × rate_to_usd. class_premium / total_premium are
-- now USD amounts.
--
-- Fallback: a contract whose currency has NO ref_exchange_rate row (or no
-- currency at all) keeps rate 1.0, i.e. its premium is treated as already-USD.
-- That is deliberate: it preserves the contract's contribution instead of
-- dropping it, matches the previous behaviour for USD books, and any gap in
-- the rate table is a data problem to fix in ref_exchange_rate — not a reason
-- to silently exclude a signed treaty from the benchmark.
--
-- Drop/recreate (same approach as 105/108) because a materialized view's
-- SELECT cannot be altered in place. The three benchmark MVs are recreated
-- EXACTLY as migration 108 defined them (they read from contributions), and
-- every unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY is
-- recreated. public.refresh_ldf_benchmarks() is untouched — it references the
-- views by name and remains valid (and remains deliberately unused; see
-- services/ldf/benchmark.js refreshBenchmarks()).

DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_global  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_region  CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_benchmark_country CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_ldf_contributions     CASCADE;

-- ── per-contract per-class contribution rows ──────────────────────────────
CREATE MATERIALIZED VIEW public.mv_ldf_contributions AS
WITH latest_fx AS (
    SELECT DISTINCT ON (currency_code)
           currency_code,
           rate_to_usd
    FROM public.ref_exchange_rate
    ORDER BY currency_code, effective_date DESC
)
SELECT
    cdf.contract_id,
    ccob.class_of_business_id,
    ces.premium * COALESCE(fx.rate_to_usd, 1)  AS class_premium,  -- USD
    c.country_id,
    co.region                                  AS region,
    tt.category                                AS treaty_category,
    cdf.triangle_type,
    cdf.dev_month,
    cdf.selected_ldf                           AS ldf
FROM public.contract_dev_factor cdf
JOIN public.contract                   c    ON c.contract_id = cdf.contract_id
JOIN public.contract_class_of_business ccob ON ccob.contract_id = cdf.contract_id
LEFT JOIN public.contract_epi_split ces
       ON ces.contract_id = cdf.contract_id
      AND ces.class_of_business_id = ccob.class_of_business_id
LEFT JOIN public.country     co  ON co.country_id      = c.country_id
LEFT JOIN public.treaty_type tt  ON tt.treaty_type_id  = c.treaty_type_id
LEFT JOIN public.currency    cur ON cur.currency_id    = c.currency_id
LEFT JOIN latest_fx          fx  ON fx.currency_code   = cur.currency_code
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

-- ── COUNTRY scope (verbatim from migration 108) ───────────────────────────
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

-- ── REGION scope (verbatim from migration 108) ────────────────────────────
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

-- ── GLOBAL scope (verbatim from migration 108) ────────────────────────────
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

COMMENT ON MATERIALIZED VIEW public.mv_ldf_contributions IS
  'Per-contract per-class LDF contribution rows. class_premium is the contract''s class EPI converted to USD via the latest ref_exchange_rate for the contract currency (rate 1.0 fallback when no rate row exists). Refreshed via services/ldf/benchmark.js refreshBenchmarks().';

COMMENT ON MATERIALIZED VIEW public.mv_ldf_benchmark_country IS
  'Volume-weighted average LDFs per class × country × treaty_category × triangle_type × dev_month. Weights and total_premium are USD (migration 146). Refreshed via public.refresh_ldf_benchmarks().';
