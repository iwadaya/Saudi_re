-- Seed 004: full base reference catalogue — plain SQL for seeding DIRECTLY
-- against PostgreSQL, no Node/npm required:
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f server/src/db/seeds/004_reference_catalogue.sql
--
-- The complete catalogue a healthy database carries after migrations + boot
-- seeding (startup/ensureReferenceData.js), captured as one idempotent file:
-- 75 countries, 32 currencies (with their USD rates), 15 classes of
-- business, 11 brokers, 11 treaty types, 15 rated reinsurers, 22 cedant
-- companies, and the 81 country-inflation rows migration 013 ships. It does
-- NOT include the Ghana pack — that is 003_ghana_reference.sql — and it
-- writes NO contracts and no users.
--
-- Normally unnecessary: migrations and boot seeding already provide all of
-- this. Run it to verify or heal a database whose catalogue is missing or
-- partial — every INSERT targets a natural key, so rows already present are
-- left untouched and a re-run is a no-op. Requires a migrated schema.
--
-- Generated from a freshly migrated database; regenerate rather than editing
-- rows by hand when the migrations' catalogue changes.
--
-- No BEGIN/COMMIT here: seeds/run.js sends this whole file as ONE query, so
-- PostgreSQL executes it atomically in a single implicit transaction; with
-- psql pass -1 (single-transaction) as shown above.

-- ═══ Countries (75) ═══
INSERT INTO public.country (country_code, country_name, region) VALUES
  ('AE', 'United Arab Emirates', 'GCC'),
  ('AO', 'Angola', 'Sub-Saharan Africa'),
  ('AR', 'Argentina', 'Americas'),
  ('AT', 'Austria', 'Europe'),
  ('AU', 'Australia', 'East Asia & Pacific'),
  ('BD', 'Bangladesh', 'South Asia'),
  ('BE', 'Belgium', 'Europe'),
  ('BH', 'Bahrain', 'GCC'),
  ('BR', 'Brazil', 'Americas'),
  ('CA', 'Canada', 'Americas'),
  ('CH', 'Switzerland', 'Europe'),
  ('CL', 'Chile', 'Americas'),
  ('CN', 'China', 'East Asia & Pacific'),
  ('CO', 'Colombia', 'Americas'),
  ('DE', 'Germany', 'Europe'),
  ('DK', 'Denmark', 'Europe'),
  ('DZ', 'Algeria', 'North Africa'),
  ('EC', 'Ecuador', 'Americas'),
  ('EG', 'Egypt', 'North Africa'),
  ('ES', 'Spain', 'Europe'),
  ('ET', 'Ethiopia', 'Sub-Saharan Africa'),
  ('FI', 'Finland', 'Europe'),
  ('FR', 'France', 'Europe'),
  ('GB', 'United Kingdom', 'Europe'),
  ('GH', 'Ghana', 'Sub-Saharan Africa'),
  ('GR', 'Greece', 'Europe'),
  ('HK', 'Hong Kong', 'East Asia & Pacific'),
  ('ID', 'Indonesia', 'Southeast Asia'),
  ('IE', 'Ireland', 'Europe'),
  ('IN', 'India', 'South Asia'),
  ('IQ', 'Iraq', 'Levant'),
  ('IT', 'Italy', 'Europe'),
  ('JO', 'Jordan', 'Levant'),
  ('JP', 'Japan', 'East Asia & Pacific'),
  ('KE', 'Kenya', 'Sub-Saharan Africa'),
  ('KR', 'South Korea', 'East Asia & Pacific'),
  ('KW', 'Kuwait', 'GCC'),
  ('LB', 'Lebanon', 'Levant'),
  ('LK', 'Sri Lanka', 'South Asia'),
  ('LY', 'Libya', 'North Africa'),
  ('MA', 'Morocco', 'North Africa'),
  ('MX', 'Mexico', 'Americas'),
  ('MY', 'Malaysia', 'Southeast Asia'),
  ('MZ', 'Mozambique', 'Sub-Saharan Africa'),
  ('NG', 'Nigeria', 'Sub-Saharan Africa'),
  ('NL', 'Netherlands', 'Europe'),
  ('NO', 'Norway', 'Europe'),
  ('NP', 'Nepal', 'South Asia'),
  ('NZ', 'New Zealand', 'East Asia & Pacific'),
  ('OM', 'Oman', 'GCC'),
  ('PE', 'Peru', 'Americas'),
  ('PH', 'Philippines', 'Southeast Asia'),
  ('PK', 'Pakistan', 'South Asia'),
  ('PL', 'Poland', 'Europe'),
  ('PS', 'Palestine', 'Levant'),
  ('PT', 'Portugal', 'Europe'),
  ('QA', 'Qatar', 'GCC'),
  ('RU', 'Russia', 'Europe'),
  ('SA', 'Saudi Arabia', 'GCC'),
  ('SD', 'Sudan', 'North Africa'),
  ('SE', 'Sweden', 'Europe'),
  ('SG', 'Singapore', 'Southeast Asia'),
  ('SY', 'Syria', 'Levant'),
  ('TH', 'Thailand', 'Southeast Asia'),
  ('TN', 'Tunisia', 'North Africa'),
  ('TR', 'Turkey', 'Europe'),
  ('TW', 'Taiwan', 'East Asia & Pacific'),
  ('TZ', 'Tanzania', 'Sub-Saharan Africa'),
  ('UG', 'Uganda', 'Sub-Saharan Africa'),
  ('US', 'United States', 'Americas'),
  ('VE', 'Venezuela', 'Americas'),
  ('VN', 'Vietnam', 'Southeast Asia'),
  ('ZA', 'South Africa', 'Sub-Saharan Africa'),
  ('ZM', 'Zambia', 'Sub-Saharan Africa'),
  ('ZW', 'Zimbabwe', 'Sub-Saharan Africa')
ON CONFLICT (country_code) WHERE is_active IS NOT FALSE DO NOTHING;

-- ═══ Currencies (32) ═══
INSERT INTO public.currency (currency_code, currency_name) VALUES
  ('AED', 'UAE Dirham'),
  ('AUD', 'Australian Dollar'),
  ('BHD', 'Bahraini Dinar'),
  ('BRL', 'Brazilian Real'),
  ('CAD', 'Canadian Dollar'),
  ('CHF', 'Swiss Franc'),
  ('CNY', 'Chinese Yuan'),
  ('EGP', 'Egyptian Pound'),
  ('EUR', 'Euro'),
  ('GBP', 'British Pound'),
  ('IDR', 'Indonesian Rupiah'),
  ('INR', 'Indian Rupee'),
  ('JOD', 'Jordanian Dinar'),
  ('JPY', 'Japanese Yen'),
  ('KES', 'Kenyan Shilling'),
  ('KRW', 'South Korean Won'),
  ('KWD', 'Kuwaiti Dinar'),
  ('LKR', 'Sri Lankan Rupee'),
  ('MAD', 'Moroccan Dirham'),
  ('MXN', 'Mexican Peso'),
  ('MYR', 'Malaysian Ringgit'),
  ('NGN', 'Nigerian Naira'),
  ('NZD', 'New Zealand Dollar'),
  ('OMR', 'Omani Rial'),
  ('PKR', 'Pakistani Rupee'),
  ('QAR', 'Qatari Riyal'),
  ('SAR', 'Saudi Riyal'),
  ('SGD', 'Singapore Dollar'),
  ('THB', 'Thai Baht'),
  ('TRY', 'Turkish Lira'),
  ('USD', 'US Dollar'),
  ('ZAR', 'South African Rand')
ON CONFLICT (currency_code) DO NOTHING;

-- ═══ Classes of business (15) ═══
INSERT INTO public.class_of_business (class_of_business, code) VALUES
  ('Agriculture', 'AGR'),
  ('Aviation', 'AVI'),
  ('Credit & Surety', 'CS'),
  ('Energy', 'ENE'),
  ('Engineering', 'ENG'),
  ('Group Life', 'GL'),
  ('Liability', 'LIA'),
  ('Life', 'LIFE'),
  ('Marine', 'MAR'),
  ('Medical', 'MED'),
  ('Miscellaneous', 'MISC'),
  ('Motor', 'MOT'),
  ('Political Violence', NULL),
  ('Property', 'PROP'),
  ('Workers Compensation', 'WC')
ON CONFLICT (class_of_business) WHERE is_active IS NOT FALSE DO NOTHING;

-- ═══ Brokers (11) ═══
INSERT INTO public.brokers (broker_name) VALUES
  ('Aon'),
  ('BMS Group'),
  ('Direct'),
  ('Ed Broking'),
  ('Gallagher Re'),
  ('Guy Carpenter'),
  ('Howden'),
  ('Lockton Re'),
  ('Marsh'),
  ('UIB'),
  ('Willis Towers Watson')
ON CONFLICT (broker_name) WHERE is_active IS NOT FALSE DO NOTHING;

-- ═══ Treaty types (11) ═══
INSERT INTO public.treaty_type (treaty_type, category) VALUES
  ('Aggregate XL', 'NON_PROPORTIONAL'),
  ('CAT XL', 'NON_PROPORTIONAL'),
  ('Risk & CAT XL', 'NON_PROPORTIONAL'),
  ('Risk XL', 'NON_PROPORTIONAL'),
  ('Stop Loss', 'NON_PROPORTIONAL'),
  ('Fac Oblig', 'PROPORTIONAL'),
  ('First Surplus', 'PROPORTIONAL'),
  ('Quota Share', 'PROPORTIONAL'),
  ('Quota Share & Surplus', 'PROPORTIONAL'),
  ('Second Surplus', 'PROPORTIONAL'),
  ('Third Surplus', 'PROPORTIONAL')
ON CONFLICT (treaty_type) DO NOTHING;

-- ═══ Reinsurers (15, with ratings) ═══
INSERT INTO public.reinsurers (reinsurer_name, rating) VALUES
  ('Africa Re', 'A-'),
  ('CCR Re', 'A'),
  ('Everest Re', 'A+'),
  ('Hannover Re', 'AA-'),
  ('Korean Re', 'A'),
  ('Lloyds', 'A+'),
  ('Maiden Re', 'A'),
  ('Munich Re', 'AA-'),
  ('PartnerRe', 'A+'),
  ('Qatar Re', 'A'),
  ('RGA', 'A+'),
  ('SCOR', 'AA-'),
  ('Swiss Re', 'AA-'),
  ('Transatlantic Re', 'A+'),
  ('Trust Re', 'B++')
ON CONFLICT (reinsurer_name) DO NOTHING;

-- ═══ Cedant companies (22) — country resolved by code, never by UUID ═══
INSERT INTO public.companies (company_name, country_id)
SELECT v.company_name, c.country_id
  FROM (VALUES
    ('ADNIC', 'AE'),
    ('AXA UK', 'GB'),
    ('Abu Dhabi National Insurance', 'AE'),
    ('Al Rajhi Takaful', 'SA'),
    ('Allianz Egypt', 'EG'),
    ('Aviva', 'GB'),
    ('Bupa Arabia', 'SA'),
    ('Dubai Insurance', 'AE'),
    ('GIG Egypt', 'EG'),
    ('Gulf Insurance Group', 'KW'),
    ('Gulf Union Insurance', 'SA'),
    ('Kuwait Insurance', 'KW'),
    ('Malath Insurance', 'SA'),
    ('Misr Insurance', 'EG'),
    ('Oman Insurance', 'AE'),
    ('Orient Insurance', 'AE'),
    ('RSA Insurance', 'GB'),
    ('Salama Islamic Insurance', 'AE'),
    ('Tawuniya', 'SA'),
    ('Walaa Insurance', 'SA'),
    ('Warba Insurance', 'KW'),
    ('Zurich UK', 'GB')
  ) AS v(company_name, country_code)
  JOIN public.country c ON c.country_code = v.country_code
ON CONFLICT (company_name) WHERE is_active IS NOT FALSE DO NOTHING;

-- ═══ Exchange rates (32 — one per currency; updates a stale rate on re-run) ═══
INSERT INTO public.ref_exchange_rate (currency_code, rate_to_usd, effective_date, source) VALUES
  ('AED', 0.27230000, '2025-01-01'::date, 'SEED'),
  ('AUD', 0.65300000, '2025-01-01'::date, 'SEED'),
  ('BHD', 2.65300000, '2025-01-01'::date, 'SEED'),
  ('BRL', 0.17700000, '2025-01-01'::date, 'SEED'),
  ('CAD', 0.73600000, '2025-01-01'::date, 'SEED'),
  ('CHF', 1.12300000, '2025-01-01'::date, 'SEED'),
  ('CNY', 0.13800000, '2025-01-01'::date, 'SEED'),
  ('EGP', 0.02040000, '2025-01-01'::date, 'SEED'),
  ('EUR', 1.08500000, '2025-01-01'::date, 'SEED'),
  ('GBP', 1.27200000, '2025-01-01'::date, 'SEED'),
  ('IDR', 0.00006100, '2025-01-01'::date, 'SEED'),
  ('INR', 0.01190000, '2025-01-01'::date, 'SEED'),
  ('JOD', 1.41040000, '2025-01-01'::date, 'SEED'),
  ('JPY', 0.00645000, '2025-01-01'::date, 'SEED'),
  ('KES', 0.00645000, '2025-01-01'::date, 'SEED'),
  ('KRW', 0.00072000, '2025-01-01'::date, 'SEED'),
  ('KWD', 3.25500000, '2025-01-01'::date, 'SEED'),
  ('LKR', 0.00310000, '2025-01-01'::date, 'SEED'),
  ('MAD', 0.10100000, '2025-01-01'::date, 'SEED'),
  ('MXN', 0.05710000, '2025-01-01'::date, 'SEED'),
  ('MYR', 0.21300000, '2025-01-01'::date, 'SEED'),
  ('NGN', 0.00063000, '2025-01-01'::date, 'SEED'),
  ('NZD', 0.60800000, '2025-01-01'::date, 'SEED'),
  ('OMR', 2.59740000, '2025-01-01'::date, 'SEED'),
  ('PKR', 0.00357000, '2025-01-01'::date, 'SEED'),
  ('QAR', 0.27470000, '2025-01-01'::date, 'SEED'),
  ('SAR', 0.26670000, '2025-01-01'::date, 'SEED'),
  ('SGD', 0.74500000, '2025-01-01'::date, 'SEED'),
  ('THB', 0.02820000, '2025-01-01'::date, 'SEED'),
  ('TRY', 0.02940000, '2025-01-01'::date, 'SEED'),
  ('USD', 1.00000000, '2025-01-01'::date, 'SEED'),
  ('ZAR', 0.05500000, '2025-01-01'::date, 'SEED')
ON CONFLICT (currency_code, effective_date)
DO UPDATE SET rate_to_usd = EXCLUDED.rate_to_usd, updated_at = now();

-- ═══ Country inflation (81 rows, migration 013's series) ═══
INSERT INTO public.ref_country_inflation (country_id, uw_year, inflation_pct, source)
SELECT c.country_id, v.uw_year, v.pct, v.source
  FROM (VALUES
    ('AE', 2000, 1.4000, 'World Bank'),
    ('AE', 2001, 2.8000, 'World Bank'),
    ('AE', 2002, 2.9000, 'World Bank'),
    ('AE', 2003, 3.1000, 'World Bank'),
    ('AE', 2004, 5.0000, 'World Bank'),
    ('AE', 2005, 6.2000, 'World Bank'),
    ('AE', 2006, 9.3000, 'World Bank'),
    ('AE', 2007, 11.1000, 'World Bank'),
    ('AE', 2008, 12.3000, 'World Bank'),
    ('AE', 2009, 1.6000, 'World Bank'),
    ('AE', 2010, 0.9000, 'World Bank'),
    ('AE', 2011, 0.9000, 'World Bank'),
    ('AE', 2012, 0.7000, 'World Bank'),
    ('AE', 2013, 1.1000, 'World Bank'),
    ('AE', 2014, 2.3000, 'World Bank'),
    ('AE', 2015, 4.1000, 'World Bank'),
    ('AE', 2016, 1.6000, 'World Bank'),
    ('AE', 2017, 2.0000, 'World Bank'),
    ('AE', 2018, 3.1000, 'World Bank'),
    ('AE', 2019, -1.9000, 'World Bank'),
    ('AE', 2020, -2.1000, 'World Bank'),
    ('AE', 2021, 0.2000, 'World Bank'),
    ('AE', 2022, 4.8000, 'IMF WEO'),
    ('AE', 2023, 1.6000, 'IMF WEO'),
    ('AE', 2024, 2.1000, 'IMF WEO'),
    ('AE', 2025, 2.3000, 'IMF WEO Proj'),
    ('AE', 2026, 2.2000, 'IMF WEO Proj'),
    ('GB', 2000, 0.8000, 'ONS'),
    ('GB', 2001, 1.2000, 'ONS'),
    ('GB', 2002, 1.3000, 'ONS'),
    ('GB', 2003, 1.4000, 'ONS'),
    ('GB', 2004, 1.3000, 'ONS'),
    ('GB', 2005, 2.1000, 'ONS'),
    ('GB', 2006, 2.3000, 'ONS'),
    ('GB', 2007, 2.3000, 'ONS'),
    ('GB', 2008, 3.6000, 'ONS'),
    ('GB', 2009, 2.2000, 'ONS'),
    ('GB', 2010, 3.3000, 'ONS'),
    ('GB', 2011, 4.5000, 'ONS'),
    ('GB', 2012, 2.8000, 'ONS'),
    ('GB', 2013, 2.6000, 'ONS'),
    ('GB', 2014, 1.5000, 'ONS'),
    ('GB', 2015, 0.0000, 'ONS'),
    ('GB', 2016, 0.7000, 'ONS'),
    ('GB', 2017, 2.7000, 'ONS'),
    ('GB', 2018, 2.5000, 'ONS'),
    ('GB', 2019, 1.8000, 'ONS'),
    ('GB', 2020, 0.9000, 'ONS'),
    ('GB', 2021, 2.6000, 'ONS'),
    ('GB', 2022, 10.1000, 'ONS'),
    ('GB', 2023, 7.3000, 'ONS'),
    ('GB', 2024, 2.5000, 'IMF WEO'),
    ('GB', 2025, 2.2000, 'IMF WEO Proj'),
    ('GB', 2026, 2.0000, 'IMF WEO Proj'),
    ('SA', 2000, -1.1000, 'World Bank'),
    ('SA', 2001, -0.8000, 'World Bank'),
    ('SA', 2002, 0.2000, 'World Bank'),
    ('SA', 2003, 0.6000, 'World Bank'),
    ('SA', 2004, 0.4000, 'World Bank'),
    ('SA', 2005, 0.6000, 'World Bank'),
    ('SA', 2006, 2.3000, 'World Bank'),
    ('SA', 2007, 4.1000, 'World Bank'),
    ('SA', 2008, 9.9000, 'World Bank'),
    ('SA', 2009, 5.1000, 'World Bank'),
    ('SA', 2010, 3.8000, 'World Bank'),
    ('SA', 2011, 3.7000, 'World Bank'),
    ('SA', 2012, 2.9000, 'World Bank'),
    ('SA', 2013, 3.5000, 'World Bank'),
    ('SA', 2014, 2.7000, 'World Bank'),
    ('SA', 2015, 2.2000, 'World Bank'),
    ('SA', 2016, 3.5000, 'World Bank'),
    ('SA', 2017, -0.9000, 'World Bank'),
    ('SA', 2018, 2.5000, 'World Bank'),
    ('SA', 2019, -2.1000, 'World Bank'),
    ('SA', 2020, 3.4000, 'World Bank'),
    ('SA', 2021, 3.1000, 'World Bank'),
    ('SA', 2022, 2.5000, 'IMF WEO'),
    ('SA', 2023, 2.3000, 'IMF WEO'),
    ('SA', 2024, 1.7000, 'IMF WEO'),
    ('SA', 2025, 2.0000, 'IMF WEO Proj'),
    ('SA', 2026, 2.0000, 'IMF WEO Proj')
  ) AS v(country_code, uw_year, pct, source)
  JOIN public.country c ON c.country_code = v.country_code
ON CONFLICT (country_id, uw_year)
DO UPDATE SET inflation_pct = EXCLUDED.inflation_pct, source = EXCLUDED.source;

-- ═══ State summary — printed as the file's result when run via psql ═══
SELECT 'countries' AS item, count(*)::text AS value FROM public.country
UNION ALL SELECT 'currencies',          count(*)::text FROM public.currency
UNION ALL SELECT 'classes_of_business', count(*)::text FROM public.class_of_business
UNION ALL SELECT 'brokers',             count(*)::text FROM public.brokers
UNION ALL SELECT 'treaty_types',        count(*)::text FROM public.treaty_type
UNION ALL SELECT 'reinsurers',          count(*)::text FROM public.reinsurers
UNION ALL SELECT 'companies_cedants',   count(*)::text FROM public.companies
UNION ALL SELECT 'exchange_rates',      count(*)::text FROM public.ref_exchange_rate
UNION ALL SELECT 'inflation_rows',      count(*)::text FROM public.ref_country_inflation
UNION ALL SELECT 'seeded_contracts',    count(*)::text
  FROM public.contract WHERE import_metadata->>'source' = 'seed:test-treaties';
