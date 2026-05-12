-- 005: Reference data - handles both fresh install and existing schema

-- Country table (add if missing, skip if exists)
CREATE TABLE IF NOT EXISTS public.country (
  country_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  country_name TEXT NOT NULL,
  country_code TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Try adding region column (ignore if exists or table differs)
DO $$ BEGIN
  ALTER TABLE public.country ADD COLUMN IF NOT EXISTS region TEXT;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Currency table
CREATE TABLE IF NOT EXISTS public.currency (
  currency_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  currency_code TEXT NOT NULL,
  currency_name TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
-- Add unique constraint only if not present
DO $$ BEGIN
  ALTER TABLE public.currency ADD CONSTRAINT currency_code_unique UNIQUE (currency_code);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Generic ref_list system
CREATE TABLE IF NOT EXISTS public.ref_list (
  list_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  list_key TEXT NOT NULL,
  list_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.ref_list ADD CONSTRAINT ref_list_key_unique UNIQUE (list_key);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.ref_list_item (
  item_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  list_id UUID,
  name TEXT NOT NULL,
  code TEXT,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed countries (only insert if table is empty or missing these)
INSERT INTO public.country (country_name, country_code) 
SELECT * FROM (VALUES
  ('United Arab Emirates', 'AE'), ('Saudi Arabia', 'SA'), ('Kuwait', 'KW'),
  ('Bahrain', 'BH'), ('Oman', 'OM'), ('Qatar', 'QA'), ('Jordan', 'JO'),
  ('Lebanon', 'LB'), ('Egypt', 'EG'), ('Morocco', 'MA'), ('Tunisia', 'TN'),
  ('Algeria', 'DZ'), ('South Africa', 'ZA'), ('Nigeria', 'NG'), ('Kenya', 'KE'),
  ('United Kingdom', 'GB'), ('France', 'FR'), ('Germany', 'DE'), ('Italy', 'IT'),
  ('Spain', 'ES'), ('Switzerland', 'CH'), ('Netherlands', 'NL'), ('Belgium', 'BE'),
  ('Turkey', 'TR'), ('India', 'IN'), ('Pakistan', 'PK'), ('Sri Lanka', 'LK'),
  ('Bangladesh', 'BD'), ('Malaysia', 'MY'), ('Singapore', 'SG'), ('Japan', 'JP'),
  ('China', 'CN'), ('South Korea', 'KR'), ('Thailand', 'TH'), ('Indonesia', 'ID'),
  ('Philippines', 'PH'), ('Australia', 'AU'), ('New Zealand', 'NZ'),
  ('United States', 'US'), ('Canada', 'CA'), ('Mexico', 'MX'), ('Brazil', 'BR'),
  ('Chile', 'CL'), ('Colombia', 'CO'), ('Argentina', 'AR')
) AS v(n, c)
WHERE NOT EXISTS (SELECT 1 FROM public.country WHERE country_code = v.c);

-- Seed currencies
INSERT INTO public.currency (currency_code, currency_name)
SELECT * FROM (VALUES
  ('USD', 'US Dollar'), ('EUR', 'Euro'), ('GBP', 'British Pound'),
  ('AED', 'UAE Dirham'), ('SAR', 'Saudi Riyal'), ('KWD', 'Kuwaiti Dinar'),
  ('BHD', 'Bahraini Dinar'), ('OMR', 'Omani Rial'), ('QAR', 'Qatari Riyal'),
  ('JOD', 'Jordanian Dinar'), ('EGP', 'Egyptian Pound'), ('MAD', 'Moroccan Dirham'),
  ('ZAR', 'South African Rand'), ('NGN', 'Nigerian Naira'), ('KES', 'Kenyan Shilling'),
  ('INR', 'Indian Rupee'), ('PKR', 'Pakistani Rupee'), ('LKR', 'Sri Lankan Rupee'),
  ('MYR', 'Malaysian Ringgit'), ('SGD', 'Singapore Dollar'), ('JPY', 'Japanese Yen'),
  ('CNY', 'Chinese Yuan'), ('KRW', 'South Korean Won'), ('THB', 'Thai Baht'),
  ('IDR', 'Indonesian Rupiah'), ('AUD', 'Australian Dollar'), ('NZD', 'New Zealand Dollar'),
  ('CAD', 'Canadian Dollar'), ('CHF', 'Swiss Franc'), ('TRY', 'Turkish Lira'),
  ('BRL', 'Brazilian Real'), ('MXN', 'Mexican Peso')
) AS v(code, nm)
WHERE NOT EXISTS (SELECT 1 FROM public.currency WHERE currency_code = v.code);

-- Companies (cedants) table
CREATE TABLE IF NOT EXISTS public.companies (
  company_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  country_id UUID,
  company_type TEXT DEFAULT 'CEDANT',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed cedants (only if none exist)
DO $$
DECLARE v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.companies LIMIT 1) THEN
    SELECT country_id INTO v_id FROM public.country WHERE country_code='AE' LIMIT 1;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.companies (company_name, country_id) VALUES
        ('Abu Dhabi National Insurance', v_id), ('ADNIC', v_id), ('Orient Insurance', v_id),
        ('Oman Insurance', v_id), ('Dubai Insurance', v_id), ('Salama Islamic Insurance', v_id);
    END IF;
    SELECT country_id INTO v_id FROM public.country WHERE country_code='SA' LIMIT 1;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.companies (company_name, country_id) VALUES
        ('Tawuniya', v_id), ('Bupa Arabia', v_id), ('Malath Insurance', v_id),
        ('Al Rajhi Takaful', v_id), ('Walaa Insurance', v_id), ('Gulf Union Insurance', v_id);
    END IF;
    SELECT country_id INTO v_id FROM public.country WHERE country_code='KW' LIMIT 1;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.companies (company_name, country_id) VALUES
        ('Kuwait Insurance', v_id), ('Gulf Insurance Group', v_id), ('Warba Insurance', v_id);
    END IF;
    SELECT country_id INTO v_id FROM public.country WHERE country_code='GB' LIMIT 1;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.companies (company_name, country_id) VALUES
        ('Aviva', v_id), ('AXA UK', v_id), ('RSA Insurance', v_id), ('Zurich UK', v_id);
    END IF;
    SELECT country_id INTO v_id FROM public.country WHERE country_code='EG' LIMIT 1;
    IF v_id IS NOT NULL THEN
      INSERT INTO public.companies (company_name, country_id) VALUES
        ('Misr Insurance', v_id), ('GIG Egypt', v_id), ('Allianz Egypt', v_id);
    END IF;
  END IF;
END $$;

-- Brokers table
CREATE TABLE IF NOT EXISTS public.brokers (
  broker_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  broker_name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.brokers (broker_name)
SELECT v.n FROM (VALUES
  ('Aon'), ('Marsh'), ('Willis Towers Watson'), ('Guy Carpenter'),
  ('Gallagher Re'), ('Lockton Re'), ('Ed Broking'), ('BMS Group'),
  ('UIB'), ('Howden'), ('Direct')
) AS v(n)
WHERE NOT EXISTS (SELECT 1 FROM public.brokers WHERE broker_name = v.n);

-- Treaty types table
CREATE TABLE IF NOT EXISTS public.treaty_types (
  treaty_type_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  treaty_type TEXT NOT NULL,
  category TEXT DEFAULT 'PROPORTIONAL',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.treaty_types ADD CONSTRAINT treaty_types_unique UNIQUE (treaty_type);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

INSERT INTO public.treaty_types (treaty_type, category)
SELECT * FROM (VALUES
  ('Quota Share', 'PROPORTIONAL'), ('Quota Share & Surplus', 'PROPORTIONAL'),
  ('First Surplus', 'PROPORTIONAL'), ('Second Surplus', 'PROPORTIONAL'),
  ('Third Surplus', 'PROPORTIONAL'), ('Fac Oblig', 'PROPORTIONAL'),
  ('Cat XL', 'NON_PROPORTIONAL'), ('Per Risk XL', 'NON_PROPORTIONAL'),
  ('Agg XL', 'NON_PROPORTIONAL'), ('Fac XL', 'NON_PROPORTIONAL'),
  ('Stop Loss', 'NON_PROPORTIONAL'), ('Industry Loss Warranty', 'NON_PROPORTIONAL')
) AS v(tt, cat)
WHERE NOT EXISTS (SELECT 1 FROM public.treaty_types WHERE treaty_type = v.tt);

-- Class of business table
-- class_of_business table created by 000_core_schema with columns:
-- class_of_business_id, class_of_business, code
-- Insert using correct column names, handle both old (class_name) and new schema
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='class_of_business' AND column_name='class_of_business') THEN
    INSERT INTO public.class_of_business (class_of_business, code)
    SELECT * FROM (VALUES
      ('Property', 'PROP'), ('Motor', 'MOT'), ('Marine', 'MAR'),
      ('Engineering', 'ENG'), ('Liability', 'LIA'), ('Medical', 'MED'),
      ('Aviation', 'AVI'), ('Energy', 'ENE'), ('Agriculture', 'AGR'),
      ('Credit & Surety', 'CS'), ('Miscellaneous', 'MISC'), ('Life', 'LIFE'),
      ('Group Life', 'GL'), ('Workers Compensation', 'WC')
    ) AS v(n, c)
    WHERE NOT EXISTS (SELECT 1 FROM public.class_of_business WHERE class_of_business = v.n);
  ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='class_of_business' AND column_name='class_name') THEN
    INSERT INTO public.class_of_business (class_name, class_code)
    SELECT * FROM (VALUES
      ('Property', 'PROP'), ('Motor', 'MOT'), ('Marine', 'MAR'),
      ('Engineering', 'ENG'), ('Liability', 'LIA'), ('Medical', 'MED'),
      ('Aviation', 'AVI'), ('Energy', 'ENE'), ('Agriculture', 'AGR'),
      ('Credit & Surety', 'CS'), ('Miscellaneous', 'MISC'), ('Life', 'LIFE'),
      ('Group Life', 'GL'), ('Workers Compensation', 'WC')
    ) AS v(n, c)
    WHERE NOT EXISTS (SELECT 1 FROM public.class_of_business WHERE class_name = v.n);
  END IF;
END $$;

-- Reinsurers table
CREATE TABLE IF NOT EXISTS public.reinsurers (
  reinsurer_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reinsurer_name TEXT NOT NULL,
  rating TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.reinsurers ADD COLUMN IF NOT EXISTS rating TEXT, ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

INSERT INTO public.reinsurers (reinsurer_name, rating)
SELECT * FROM (VALUES
  ('Swiss Re', 'AA-'), ('Munich Re', 'AA-'), ('Hannover Re', 'AA-'),
  ('SCOR', 'AA-'), ('Lloyds', 'A+'), ('RGA', 'A+'),
  ('Everest Re', 'A+'), ('PartnerRe', 'A+'), ('Transatlantic Re', 'A+'),
  ('Korean Re', 'A'), ('Africa Re', 'A-'), ('Trust Re', 'B++'),
  ('CCR Re', 'A'), ('Qatar Re', 'A'), ('Maiden Re', 'A')
) AS v(n, r)
WHERE NOT EXISTS (SELECT 1 FROM public.reinsurers WHERE reinsurer_name = v.n);
