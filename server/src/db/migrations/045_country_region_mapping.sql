-- Migration 045: Populate region column for all countries
-- Regions aligned with Saudi Re / MENA reinsurance market geography

UPDATE public.country SET region = CASE country_code
  -- GCC
  WHEN 'SA' THEN 'GCC'
  WHEN 'AE' THEN 'GCC'
  WHEN 'KW' THEN 'GCC'
  WHEN 'BH' THEN 'GCC'
  WHEN 'QA' THEN 'GCC'
  WHEN 'OM' THEN 'GCC'
  -- Levant
  WHEN 'JO' THEN 'Levant'
  WHEN 'LB' THEN 'Levant'
  WHEN 'SY' THEN 'Levant'
  WHEN 'IQ' THEN 'Levant'
  WHEN 'PS' THEN 'Levant'
  -- North Africa
  WHEN 'EG' THEN 'North Africa'
  WHEN 'MA' THEN 'North Africa'
  WHEN 'TN' THEN 'North Africa'
  WHEN 'DZ' THEN 'North Africa'
  WHEN 'LY' THEN 'North Africa'
  WHEN 'SD' THEN 'North Africa'
  -- Sub-Saharan Africa
  WHEN 'ZA' THEN 'Sub-Saharan Africa'
  WHEN 'NG' THEN 'Sub-Saharan Africa'
  WHEN 'KE' THEN 'Sub-Saharan Africa'
  WHEN 'GH' THEN 'Sub-Saharan Africa'
  WHEN 'ET' THEN 'Sub-Saharan Africa'
  WHEN 'TZ' THEN 'Sub-Saharan Africa'
  WHEN 'UG' THEN 'Sub-Saharan Africa'
  WHEN 'ZW' THEN 'Sub-Saharan Africa'
  WHEN 'ZM' THEN 'Sub-Saharan Africa'
  WHEN 'MZ' THEN 'Sub-Saharan Africa'
  WHEN 'AO' THEN 'Sub-Saharan Africa'
  -- Europe
  WHEN 'GB' THEN 'Europe'
  WHEN 'FR' THEN 'Europe'
  WHEN 'DE' THEN 'Europe'
  WHEN 'IT' THEN 'Europe'
  WHEN 'ES' THEN 'Europe'
  WHEN 'CH' THEN 'Europe'
  WHEN 'NL' THEN 'Europe'
  WHEN 'BE' THEN 'Europe'
  WHEN 'SE' THEN 'Europe'
  WHEN 'NO' THEN 'Europe'
  WHEN 'DK' THEN 'Europe'
  WHEN 'FI' THEN 'Europe'
  WHEN 'AT' THEN 'Europe'
  WHEN 'PT' THEN 'Europe'
  WHEN 'GR' THEN 'Europe'
  WHEN 'IE' THEN 'Europe'
  WHEN 'PL' THEN 'Europe'
  WHEN 'CZ' THEN 'Europe'
  WHEN 'HU' THEN 'Europe'
  WHEN 'RO' THEN 'Europe'
  WHEN 'TR' THEN 'Europe'
  WHEN 'RU' THEN 'Europe'
  -- South Asia
  WHEN 'IN' THEN 'South Asia'
  WHEN 'PK' THEN 'South Asia'
  WHEN 'LK' THEN 'South Asia'
  WHEN 'BD' THEN 'South Asia'
  WHEN 'NP' THEN 'South Asia'
  -- Southeast Asia
  WHEN 'MY' THEN 'Southeast Asia'
  WHEN 'SG' THEN 'Southeast Asia'
  WHEN 'TH' THEN 'Southeast Asia'
  WHEN 'ID' THEN 'Southeast Asia'
  WHEN 'PH' THEN 'Southeast Asia'
  WHEN 'VN' THEN 'Southeast Asia'
  -- East Asia & Pacific
  WHEN 'JP' THEN 'East Asia & Pacific'
  WHEN 'CN' THEN 'East Asia & Pacific'
  WHEN 'KR' THEN 'East Asia & Pacific'
  WHEN 'AU' THEN 'East Asia & Pacific'
  WHEN 'NZ' THEN 'East Asia & Pacific'
  WHEN 'HK' THEN 'East Asia & Pacific'
  WHEN 'TW' THEN 'East Asia & Pacific'
  -- Americas
  WHEN 'US' THEN 'Americas'
  WHEN 'CA' THEN 'Americas'
  WHEN 'MX' THEN 'Americas'
  WHEN 'BR' THEN 'Americas'
  WHEN 'CL' THEN 'Americas'
  WHEN 'CO' THEN 'Americas'
  WHEN 'AR' THEN 'Americas'
  WHEN 'PE' THEN 'Americas'
  WHEN 'EC' THEN 'Americas'
  WHEN 'VE' THEN 'Americas'
  ELSE 'Other'
END
WHERE region IS NULL OR region = '';

-- Also insert any missing MENA/GCC countries not in original seed
INSERT INTO public.country (country_name, country_code, region)
SELECT * FROM (VALUES
  ('Iraq',        'IQ', 'Levant'),
  ('Syria',       'SY', 'Levant'),
  ('Palestine',   'PS', 'Levant'),
  ('Libya',       'LY', 'North Africa'),
  ('Sudan',       'SD', 'North Africa'),
  ('Ghana',       'GH', 'Sub-Saharan Africa'),
  ('Ethiopia',    'ET', 'Sub-Saharan Africa'),
  ('Tanzania',    'TZ', 'Sub-Saharan Africa'),
  ('Uganda',      'UG', 'Sub-Saharan Africa'),
  ('Zimbabwe',    'ZW', 'Sub-Saharan Africa'),
  ('Zambia',      'ZM', 'Sub-Saharan Africa'),
  ('Mozambique',  'MZ', 'Sub-Saharan Africa'),
  ('Angola',      'AO', 'Sub-Saharan Africa'),
  ('Sweden',      'SE', 'Europe'),
  ('Norway',      'NO', 'Europe'),
  ('Denmark',     'DK', 'Europe'),
  ('Finland',     'FI', 'Europe'),
  ('Austria',     'AT', 'Europe'),
  ('Portugal',    'PT', 'Europe'),
  ('Greece',      'GR', 'Europe'),
  ('Ireland',     'IE', 'Europe'),
  ('Poland',      'PL', 'Europe'),
  ('Russia',      'RU', 'Europe'),
  ('Nepal',       'NP', 'South Asia'),
  ('Vietnam',     'VN', 'Southeast Asia'),
  ('Hong Kong',   'HK', 'East Asia & Pacific'),
  ('Taiwan',      'TW', 'East Asia & Pacific'),
  ('Peru',        'PE', 'Americas'),
  ('Ecuador',     'EC', 'Americas'),
  ('Venezuela',   'VE', 'Americas')
) AS v(n, c, r)
WHERE NOT EXISTS (SELECT 1 FROM public.country WHERE country_code = v.c);
