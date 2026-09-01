-- Seed 003: Ghana reference pack — plain SQL for seeding DIRECTLY against
-- PostgreSQL, no Node/npm required:
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f server/src/db/seeds/003_ghana_reference.sql
--
-- Writes the same reference data as the treaty seed's --reference-only mode
-- (server/scripts/seedTestTreaties.js ensureReference — edit both together):
--   • the GH country row, topping up axco_country_code/region on an existing row
--   • the GHS currency and its USD rate (one row per year, Jan 1)
--   • the Ghana CPI series 2000–2026 in ref_country_inflation
--   • eight Ghana CRESTA zones
--   • eight Ghanaian cedant companies
-- It writes NO contracts. CPI and FX are indicative reference values for a
-- test environment, not a source of record (see docs/seed-test-treaties.md).
--
-- Idempotent: every INSERT targets a natural key (the migration-150 partial
-- uniques on country/companies, full uniques on currency/ref_exchange_rate,
-- the ref_country_inflation PK) or guards with NOT EXISTS, so re-running is
-- a no-op. Requires a migrated database — the tables come from migrations.
--
-- No BEGIN/COMMIT here: seeds/run.js sends this whole file as ONE query, so
-- PostgreSQL executes it atomically in a single implicit transaction; with
-- psql pass -1 (single-transaction) as shown above.

-- ═══════════════════════════════════════════════════════════════════
-- Country
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.country (country_code, country_name, region, axco_country_code)
VALUES ('GH', 'Ghana', 'Sub-Saharan Africa', 'GHA')
ON CONFLICT (country_code) WHERE is_active IS NOT FALSE DO NOTHING;

UPDATE public.country
   SET axco_country_code = COALESCE(axco_country_code, 'GHA'),
       region            = COALESCE(region, 'Sub-Saharan Africa')
 WHERE country_code = 'GH';

-- ═══════════════════════════════════════════════════════════════════
-- Currency + USD rate (so Ghanaian treaties convert on the dashboards)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.currency (currency_code, currency_name)
VALUES ('GHS', 'Ghanaian Cedi')
ON CONFLICT (currency_code) DO NOTHING;

INSERT INTO public.ref_exchange_rate (currency_code, rate_to_usd, effective_date, source)
VALUES ('GHS', 0.09, make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, 1, 1), 'SEED')
ON CONFLICT (currency_code, effective_date)
DO UPDATE SET rate_to_usd = EXCLUDED.rate_to_usd, updated_at = now();

-- ═══════════════════════════════════════════════════════════════════
-- Ghana CPI, annual average % change — read by the loss-inflation screens.
-- Historic figures are World Bank/IMF WEO rounded to one decimal; 2025+ are
-- projections. Must match GHANA_CPI in seedTestTreaties.js.
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.ref_country_inflation (country_id, uw_year, inflation_pct, source)
SELECT c.country_id, v.uw_year, v.pct,
       CASE WHEN v.uw_year >= 2025 THEN 'IMF WEO Proj' ELSE 'World Bank' END
  FROM public.country c
 CROSS JOIN (VALUES
    (2000, 25.2), (2001, 32.9), (2002, 14.8), (2003, 26.7), (2004, 12.6),
    (2005, 15.1), (2006, 10.9), (2007, 10.7), (2008, 16.5), (2009, 19.3),
    (2010, 10.7), (2011,  8.7), (2012,  9.2), (2013, 11.7), (2014, 15.5),
    (2015, 17.2), (2016, 17.5), (2017, 12.4), (2018,  9.8), (2019,  7.1),
    (2020,  9.9), (2021, 10.0), (2022, 31.9), (2023, 39.2), (2024, 22.9),
    (2025, 15.0), (2026,  9.5)
  ) AS v(uw_year, pct)
 WHERE c.country_code = 'GH'
ON CONFLICT (country_id, uw_year)
DO UPDATE SET inflation_pct = EXCLUDED.inflation_pct, source = EXCLUDED.source;

-- ═══════════════════════════════════════════════════════════════════
-- CRESTA zones for Ghana — referenced by name in contract_cresta_data.
-- ref_cresta_zone has only a surrogate PK, so guard with NOT EXISTS.
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.ref_cresta_zone (country_id, zone_id, zone_name, sort_order)
SELECT c.country_id, v.zone_id, v.zone_name, v.sort_order
  FROM public.country c
 CROSS JOIN (VALUES
    ('01', 'Greater Accra', 1),
    ('02', 'Ashanti',       2),
    ('03', 'Western',       3),
    ('04', 'Central',       4),
    ('05', 'Eastern',       5),
    ('06', 'Northern',      6),
    ('07', 'Volta',         7),
    ('08', 'Upper East',    8)
  ) AS v(zone_id, zone_name, sort_order)
 WHERE c.country_code = 'GH'
   AND NOT EXISTS (
     SELECT 1 FROM public.ref_cresta_zone z
      WHERE z.country_id = c.country_id AND z.zone_id = v.zone_id
   );

-- ═══════════════════════════════════════════════════════════════════
-- Ghanaian cedants
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.companies (company_name, country_id)
SELECT v.company_name, c.country_id
  FROM public.country c
 CROSS JOIN (VALUES
    ('SIC Insurance Company'),
    ('Enterprise Insurance'),
    ('Star Assurance'),
    ('Hollard Insurance Ghana'),
    ('GLICO General Insurance'),
    ('Vanguard Assurance'),
    ('Ghana Union Assurance'),
    ('Activa International Insurance Ghana')
  ) AS v(company_name)
 WHERE c.country_code = 'GH'
ON CONFLICT (company_name) WHERE is_active IS NOT FALSE DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- State summary — psql prints this as the file's result so the operator
-- sees exactly what the database now holds. seeded_contracts stays 0
-- unless the full treaty test portfolio was seeded separately.
-- ═══════════════════════════════════════════════════════════════════
SELECT 'countries' AS item, count(*)::text AS value FROM public.country
UNION ALL SELECT 'classes_of_business', count(*)::text FROM public.class_of_business
UNION ALL SELECT 'brokers',             count(*)::text FROM public.brokers
UNION ALL SELECT 'companies_cedants',   count(*)::text FROM public.companies
UNION ALL SELECT 'currencies',          count(*)::text FROM public.currency
UNION ALL SELECT 'ghs_fx_rates',        count(*)::text FROM public.ref_exchange_rate WHERE currency_code = 'GHS'
UNION ALL SELECT 'ghana_cpi_years',     count(*)::text
  FROM public.ref_country_inflation r JOIN public.country c USING (country_id) WHERE c.country_code = 'GH'
UNION ALL SELECT 'ghana_cresta_zones',  count(*)::text
  FROM public.ref_cresta_zone z JOIN public.country c USING (country_id) WHERE c.country_code = 'GH'
UNION ALL SELECT 'seeded_contracts',    count(*)::text
  FROM public.contract WHERE import_metadata->>'source' = 'seed:test-treaties';
