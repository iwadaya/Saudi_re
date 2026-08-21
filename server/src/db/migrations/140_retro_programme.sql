-- server/src/db/migrations/140_retro_programme.sql
--
-- The outward retro contract, captured manually by an admin for each
-- underwriting year. It is company-level data — one placement per year per
-- currency — read by the offer modal's retro cover analysis to price a written
-- line through the programme (retro quota share, then the retro XL).
--
-- `used_limit_amt` is the part of the XL limit the rest of the book has already
-- burned; the admin maintains it as the year runs. Idempotent.

CREATE TABLE IF NOT EXISTS public.retro_programme (
  retro_programme_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uw_year            integer NOT NULL,
  currency           text    NOT NULL DEFAULT 'USD',
  label              text,
  reinsurer          text,
  inception_date     date,
  expiry_date        date,
  -- Retro XL: limit_amt xs retention_amt, priced at rol_pct rate on line.
  retention_amt      numeric(20,2)  NOT NULL DEFAULT 0,
  limit_amt          numeric(20,2)  NOT NULL DEFAULT 0,
  rol_pct            numeric(12,6)  NOT NULL DEFAULT 0,
  used_limit_amt     numeric(20,2)  NOT NULL DEFAULT 0,
  -- Retro quota share sitting above the XL.
  cession_pct        numeric(12,6)  NOT NULL DEFAULT 0,
  commission_pct     numeric(12,6)  NOT NULL DEFAULT 0,
  -- Largest line the optimiser may recommend against this programme.
  max_line_pct       numeric(12,6)  NOT NULL DEFAULT 25,
  notes              text,
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  CONSTRAINT retro_programme_year_chk    CHECK (uw_year BETWEEN 1900 AND 2200),
  CONSTRAINT retro_programme_pct_chk     CHECK (rol_pct BETWEEN 0 AND 100
                                            AND cession_pct BETWEEN 0 AND 100
                                            AND commission_pct BETWEEN 0 AND 100
                                            AND max_line_pct > 0 AND max_line_pct <= 100),
  CONSTRAINT retro_programme_amount_chk  CHECK (retention_amt >= 0 AND limit_amt >= 0 AND used_limit_amt >= 0)
);

-- One programme per underwriting year per currency — the upsert key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_retro_programme_year_ccy
  ON public.retro_programme (uw_year, currency);

CREATE INDEX IF NOT EXISTS idx_retro_programme_year
  ON public.retro_programme (uw_year DESC);
