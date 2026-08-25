-- 144_retro_layers_and_regions.sql
-- Retro module, capture depth:
--
--   • retro_programme_layer  — a non-proportional programme is usually a
--     TOWER: several layers with different attachments, limits, rates and
--     reinstatement terms. One row per layer; programme-level attachment /
--     occurrence_limit / rol_pct on retro_programme stay valid for simple
--     single-layer programmes (and as the flattened rollup for old rows).
--   • retro_programme_region — scope by REGION (country.region) as an
--     alternative to enumerating countries: a programme protects a country
--     when covers_all_countries, the country is listed, OR its region is.
--     Lets the manager capture "all of Middle East" once instead of a
--     country list that goes stale.
--   • The seeded demo persona reads as 'Reinsurance Manager' in the login
--     list (role stays Retro Manager / RM).

CREATE TABLE IF NOT EXISTS public.retro_programme_layer (
  layer_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retro_programme_id  uuid NOT NULL REFERENCES public.retro_programme(retro_programme_id) ON DELETE CASCADE,
  layer_number        integer NOT NULL CHECK (layer_number BETWEEN 1 AND 99),
  attachment          numeric(20,2) CHECK (attachment       IS NULL OR attachment       >= 0),
  occurrence_limit    numeric(20,2) CHECK (occurrence_limit IS NULL OR occurrence_limit >= 0),
  aggregate_limit     numeric(20,2) CHECK (aggregate_limit  IS NULL OR aggregate_limit  >= 0),
  reinstatements      integer       CHECK (reinstatements   IS NULL OR reinstatements   >= 0),
  reinstatement_pct   numeric(9,4)  CHECK (reinstatement_pct IS NULL OR (reinstatement_pct >= 0 AND reinstatement_pct <= 200)),
  rol_pct             numeric(9,4)  CHECK (rol_pct          IS NULL OR rol_pct          >= 0),
  premium             numeric(20,2) CHECK (premium          IS NULL OR premium          >= 0),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retro_programme_id, layer_number)
);

CREATE INDEX IF NOT EXISTS idx_retro_programme_layer_prog ON public.retro_programme_layer(retro_programme_id);

CREATE TABLE IF NOT EXISTS public.retro_programme_region (
  retro_programme_id uuid NOT NULL REFERENCES public.retro_programme(retro_programme_id) ON DELETE CASCADE,
  region             text NOT NULL,
  PRIMARY KEY (retro_programme_id, region)
);

CREATE INDEX IF NOT EXISTS idx_retro_prog_region_region ON public.retro_programme_region(region);

-- Login-list label: the seeded persona presents as Reinsurance Manager.
UPDATE public.uw_user
   SET display_name = 'Reinsurance Manager', updated_at = now()
 WHERE username = 'retro.manager' AND display_name = 'Retro Manager';
