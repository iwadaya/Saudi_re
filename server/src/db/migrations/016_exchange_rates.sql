-- Migration 016: Exchange rate reference table
-- Stores rates against USD as base currency.
-- rate_to_usd = how many USD per 1 unit of the currency.
-- E.g. SAR: rate_to_usd = 0.2667 means 1 SAR = 0.2667 USD (or 1 USD = 3.75 SAR)

CREATE TABLE IF NOT EXISTS public.ref_exchange_rate (
  rate_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  currency_code TEXT NOT NULL,
  rate_to_usd NUMERIC(18,8) NOT NULL,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT DEFAULT 'SEED',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Unique: one rate per currency per date
DO $$ BEGIN
  ALTER TABLE public.ref_exchange_rate
    ADD CONSTRAINT ref_exchange_rate_code_date_uq UNIQUE (currency_code, effective_date);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Create index for efficient lookup
CREATE INDEX IF NOT EXISTS idx_ref_exchange_rate_code_date
  ON public.ref_exchange_rate (currency_code, effective_date DESC);

-- Seed exchange rates (rates to USD, as of ~2025 mid-year)
-- USD is always 1.0. All other rates: 1 unit of currency = X USD.
INSERT INTO public.ref_exchange_rate (currency_code, rate_to_usd, effective_date, source)
SELECT code, rate, '2025-01-01'::date, 'SEED'
FROM (VALUES
  ('USD', 1.00000000),
  ('EUR', 1.08500000),    -- 1 EUR = 1.085 USD
  ('GBP', 1.27200000),    -- 1 GBP = 1.272 USD
  ('AED', 0.27230000),    -- 1 AED = 0.2723 USD (pegged ~3.6725)
  ('SAR', 0.26670000),    -- 1 SAR = 0.2667 USD (pegged ~3.75)
  ('KWD', 3.25500000),    -- 1 KWD = 3.255 USD
  ('BHD', 2.65300000),    -- 1 BHD = 2.653 USD (pegged ~0.376)
  ('OMR', 2.59740000),    -- 1 OMR = 2.5974 USD (pegged ~0.385)
  ('QAR', 0.27470000),    -- 1 QAR = 0.2747 USD (pegged ~3.64)
  ('JOD', 1.41040000),    -- 1 JOD = 1.4104 USD (pegged ~0.709)
  ('EGP', 0.02040000),    -- 1 EGP = 0.0204 USD (~49 EGP/USD)
  ('MAD', 0.10100000),    -- 1 MAD = 0.101 USD (~9.9 MAD/USD)
  ('ZAR', 0.05500000),    -- 1 ZAR = 0.055 USD (~18.2 ZAR/USD)
  ('NGN', 0.00063000),    -- 1 NGN = 0.00063 USD (~1590 NGN/USD)
  ('KES', 0.00645000),    -- 1 KES = 0.00645 USD (~155 KES/USD)
  ('INR', 0.01190000),    -- 1 INR = 0.0119 USD (~84 INR/USD)
  ('PKR', 0.00357000),    -- 1 PKR = 0.00357 USD (~280 PKR/USD)
  ('LKR', 0.00310000),    -- 1 LKR = 0.0031 USD (~323 LKR/USD)
  ('MYR', 0.21300000),    -- 1 MYR = 0.213 USD (~4.7 MYR/USD)
  ('SGD', 0.74500000),    -- 1 SGD = 0.745 USD
  ('JPY', 0.00645000),    -- 1 JPY = 0.00645 USD (~155 JPY/USD)
  ('CNY', 0.13800000),    -- 1 CNY = 0.138 USD (~7.25 CNY/USD)
  ('KRW', 0.00072000),    -- 1 KRW = 0.00072 USD (~1390 KRW/USD)
  ('THB', 0.02820000),    -- 1 THB = 0.0282 USD (~35.5 THB/USD)
  ('IDR', 0.00006100),    -- 1 IDR = 0.000061 USD (~16400 IDR/USD)
  ('AUD', 0.65300000),    -- 1 AUD = 0.653 USD
  ('NZD', 0.60800000),    -- 1 NZD = 0.608 USD
  ('CAD', 0.73600000),    -- 1 CAD = 0.736 USD
  ('CHF', 1.12300000),    -- 1 CHF = 1.123 USD
  ('TRY', 0.02940000),    -- 1 TRY = 0.0294 USD (~34 TRY/USD)
  ('BRL', 0.17700000),    -- 1 BRL = 0.177 USD (~5.65 BRL/USD)
  ('MXN', 0.05710000)     -- 1 MXN = 0.0571 USD (~17.5 MXN/USD)
) AS v(code, rate)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ref_exchange_rate
  WHERE currency_code = v.code AND effective_date = '2025-01-01'
);
