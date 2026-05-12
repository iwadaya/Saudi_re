-- Seed 002: Reference data aligned to actual schema tables
-- Tables: treaty_type, class_of_business, brokers, companies, country, currency
-- Safe to run multiple times (ON CONFLICT DO NOTHING).

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- Treaty Types (actual table: treaty_type with columns treaty_type, category)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.treaty_type (treaty_type, category) VALUES
  ('Quota Share',           'PROPORTIONAL'),
  ('Quota Share & Surplus', 'PROPORTIONAL'),
  ('First Surplus',         'PROPORTIONAL'),
  ('Second Surplus',        'PROPORTIONAL'),
  ('Third Surplus',         'PROPORTIONAL'),
  ('Fac Oblig',             'PROPORTIONAL'),
  ('Risk XL',               'NON_PROPORTIONAL'),
  ('CAT XL',                'NON_PROPORTIONAL'),
  ('Risk & CAT XL',         'NON_PROPORTIONAL'),
  ('Stop Loss',             'NON_PROPORTIONAL'),
  ('Aggregate XL',          'NON_PROPORTIONAL')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Class of Business (actual columns: class_of_business, code)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.class_of_business (class_of_business, code) VALUES
  ('Property',         'PROPERTY'),
  ('Casualty',         'CASUALTY'),
  ('Marine',           'MARINE'),
  ('Aviation',         'AVIATION'),
  ('Motor',            'MOTOR'),
  ('Engineering',      'ENGINEERING'),
  ('Energy',           'ENERGY'),
  ('Agriculture',      'AGRICULTURE'),
  ('Life',             'LIFE'),
  ('Health',           'HEALTH'),
  ('Cyber',            'CYBER'),
  ('Financial Lines',  'FIN_LINES'),
  ('Liability',        'LIABILITY'),
  ('Workers Comp',     'WORKERS_COMP'),
  ('Misc Accident',    'MISC_ACCIDENT')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Countries (actual table: country with country_code, country_name)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.country (country_code, country_name) VALUES
  ('SA',  'Saudi Arabia'),
  ('AE',  'United Arab Emirates'),
  ('BH',  'Bahrain'),
  ('KW',  'Kuwait'),
  ('OM',  'Oman'),
  ('QA',  'Qatar'),
  ('JO',  'Jordan'),
  ('LB',  'Lebanon'),
  ('EG',  'Egypt'),
  ('MA',  'Morocco'),
  ('NG',  'Nigeria'),
  ('KE',  'Kenya'),
  ('ZA',  'South Africa'),
  ('IN',  'India'),
  ('PK',  'Pakistan'),
  ('TR',  'Turkey'),
  ('GB',  'United Kingdom'),
  ('FR',  'France'),
  ('DE',  'Germany'),
  ('US',  'United States')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Currencies (actual table: currency with currency_code, currency_name)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.currency (currency_code, currency_name) VALUES
  ('USD', 'US Dollar'),
  ('SAR', 'Saudi Riyal'),
  ('AED', 'UAE Dirham'),
  ('GBP', 'British Pound'),
  ('EUR', 'Euro'),
  ('BHD', 'Bahraini Dinar'),
  ('KWD', 'Kuwaiti Dinar'),
  ('OMR', 'Omani Rial'),
  ('QAR', 'Qatari Riyal'),
  ('EGP', 'Egyptian Pound'),
  ('INR', 'Indian Rupee'),
  ('ZAR', 'South African Rand'),
  ('NGN', 'Nigerian Naira'),
  ('TRY', 'Turkish Lira')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Brokers (actual table: brokers with broker_name)
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.brokers (broker_name) VALUES
  ('Aon Re'),
  ('Guy Carpenter'),
  ('Gallagher Re'),
  ('Willis Re'),
  ('Howden Re'),
  ('Direct - No Broker')
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════
-- Cedants (actual table: companies with company_name, country_id)
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_sa uuid; v_ae uuid; v_bh uuid; v_kw uuid; v_eg uuid; v_om uuid;
BEGIN
  SELECT country_id INTO v_sa FROM public.country WHERE country_code = 'SA' LIMIT 1;
  SELECT country_id INTO v_ae FROM public.country WHERE country_code = 'AE' LIMIT 1;
  SELECT country_id INTO v_bh FROM public.country WHERE country_code = 'BH' LIMIT 1;
  SELECT country_id INTO v_kw FROM public.country WHERE country_code = 'KW' LIMIT 1;
  SELECT country_id INTO v_eg FROM public.country WHERE country_code = 'EG' LIMIT 1;
  SELECT country_id INTO v_om FROM public.country WHERE country_code = 'OM' LIMIT 1;

  INSERT INTO public.companies (company_name, country_id) VALUES
    ('Tawuniya',                     v_sa),
    ('MEDGULF',                      v_sa),
    ('Al Rajhi Takaful',             v_sa),
    ('Bupa Arabia',                  v_sa),
    ('Walaa Insurance',              v_sa),
    ('SALAMA',                       v_sa),
    ('Orient Insurance',             v_ae),
    ('Oman Insurance Co',            v_ae),
    ('Abu Dhabi National Insurance', v_ae),
    ('Sukoon Insurance',             v_ae),
    ('GIG Bahrain',                  v_bh),
    ('Solidarity Bahrain',           v_bh),
    ('Kuwait Insurance Co',          v_kw),
    ('Gulf Insurance Group',         v_kw),
    ('Misr Insurance',               v_eg),
    ('GIG Egypt',                    v_eg),
    ('Dhofar Insurance',             v_om),
    ('National Life & General',      v_om)
  ON CONFLICT DO NOTHING;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- Reinsurers
-- ═══════════════════════════════════════════════════════════════════
INSERT INTO public.reinsurers (reinsurer_name) VALUES
  ('Munich Re'),
  ('Swiss Re'),
  ('Hannover Re'),
  ('SCOR'),
  ('RenaissanceRe'),
  ('Berkshire Hathaway Re'),
  ('Lloyd''s'),
  ('Everest Re')
ON CONFLICT DO NOTHING;

COMMIT;
