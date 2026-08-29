-- 150: Natural-key uniqueness for the seedable reference tables (audit F37).
--
-- country / class_of_business / brokers / companies had only uuid PKs, so the
-- bare ON CONFLICT DO NOTHING in seeds/002_reference_data.sql never matched
-- and every seed run inserted a full duplicate set of reference rows
-- (currency, treaty_type and reinsurers already had natural-key uniques).
--
-- The unique indexes are PARTIAL — they cover only rows the app treats as
-- active (lookups.js filters `is_active IS NOT FALSE`, migration 141):
--   * soft-deleted rows may legitimately share a name with a live replacement
--     (deactivate 'Acme', recreate 'Acme'), so a full unique would break the
--     141 soft-delete model;
--   * integration-test fixtures insert is_active=false reference rows against
--     the shared DB, some with deliberately non-unique codes (e.g. the
--     facClassAccumulation suite's 'A17' country code) — those must keep
--     working.
-- The seed targets these keys explicitly (ON CONFLICT (col) WHERE is_active
-- IS NOT FALSE), which is what makes it idempotent.
--
-- Before indexing, DEACTIVATE (never delete — rows may be FK targets) all but
-- one row per duplicated active natural key. Keepers are chosen to prefer the
-- most-enriched row (region/code/country set), then the lowest id for
-- determinism. On this repo's test DB the audit residue was removed first, so
-- these UPDATEs are expected to touch 0 rows.

WITH ranked AS (
  SELECT country_id,
         row_number() OVER (
           PARTITION BY country_code
           ORDER BY (region IS NOT NULL) DESC, (axco_country_code IS NOT NULL) DESC, country_id
         ) AS rn
  FROM public.country
  WHERE is_active IS NOT FALSE
)
UPDATE public.country c SET is_active = false
FROM ranked r
WHERE r.country_id = c.country_id AND r.rn > 1;

WITH ranked AS (
  SELECT class_of_business_id,
         row_number() OVER (
           PARTITION BY class_of_business
           ORDER BY (code IS NOT NULL) DESC, (axco_class_code IS NOT NULL) DESC, class_of_business_id
         ) AS rn
  FROM public.class_of_business
  WHERE is_active IS NOT FALSE
)
UPDATE public.class_of_business c SET is_active = false
FROM ranked r
WHERE r.class_of_business_id = c.class_of_business_id AND r.rn > 1;

WITH ranked AS (
  SELECT broker_id,
         row_number() OVER (PARTITION BY broker_name ORDER BY broker_id) AS rn
  FROM public.brokers
  WHERE is_active IS NOT FALSE
)
UPDATE public.brokers b SET is_active = false
FROM ranked r
WHERE r.broker_id = b.broker_id AND r.rn > 1;

WITH ranked AS (
  SELECT company_id,
         row_number() OVER (
           PARTITION BY company_name
           ORDER BY (country_id IS NOT NULL) DESC, company_id
         ) AS rn
  FROM public.companies
  WHERE is_active IS NOT FALSE
)
UPDATE public.companies c SET is_active = false
FROM ranked r
WHERE r.company_id = c.company_id AND r.rn > 1;

-- ── the natural keys ──────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_country_code_active
  ON public.country (country_code) WHERE is_active IS NOT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_class_of_business_name_active
  ON public.class_of_business (class_of_business) WHERE is_active IS NOT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_brokers_name_active
  ON public.brokers (broker_name) WHERE is_active IS NOT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_name_active
  ON public.companies (company_name) WHERE is_active IS NOT FALSE;
