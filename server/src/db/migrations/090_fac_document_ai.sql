-- 090_fac_document_ai.sql
-- Document AI ingestion: extends fac_document with storage / kind /
-- size metadata, then introduces three tables for analysis + AI-driven
-- recommendations + the canonical field-code catalogue the runner uses
-- to gate what comes back from the model.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Extend fac_document
-- ═══════════════════════════════════════════════════════════════════════════
-- NOTE: the users table in this codebase is uw_user (not "user") — keeping
-- the FK against the actual table name. The original spec referenced
-- public."user" which doesn't exist here.
ALTER TABLE public.fac_document
  ADD COLUMN IF NOT EXISTS document_kind        text DEFAULT 'OTHER',
  ADD COLUMN IF NOT EXISTS storage_key          text,
  ADD COLUMN IF NOT EXISTS mime_type            text,
  ADD COLUMN IF NOT EXISTS byte_size            bigint,
  ADD COLUMN IF NOT EXISTS uploaded_by_user_id  uuid
    REFERENCES public.uw_user(user_id),
  ADD COLUMN IF NOT EXISTS uploaded_at          timestamptz DEFAULT now();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. fac_document_analysis — one row per AI run on a document
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_document_analysis (
  analysis_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES public.fac_document(document_id)
                       ON DELETE CASCADE,
  fac_risk_id    uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id)
                       ON DELETE CASCADE,
  analysis_kind  text NOT NULL,
  status         text NOT NULL DEFAULT 'PENDING',
  provider       text,
  model          text,
  started_at     timestamptz,
  completed_at   timestamptz,
  duration_ms    integer,
  error          text,
  raw_response   jsonb,
  extracted      jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary        text,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fac_doc_analysis_risk_created
  ON public.fac_document_analysis (fac_risk_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. fac_ai_recommendation — one row per AI-suggested edit
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_ai_recommendation (
  recommendation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id        uuid NOT NULL REFERENCES public.fac_document_analysis(analysis_id)
                             ON DELETE CASCADE,
  fac_risk_id        uuid NOT NULL REFERENCES public.fac_risk(fac_risk_id)
                             ON DELETE CASCADE,
  target_screen      text NOT NULL,
  target_field       text NOT NULL,
  current_value      jsonb,
  suggested_value    jsonb NOT NULL,
  rationale          text NOT NULL,
  confidence         numeric(4,3),
  status             text NOT NULL DEFAULT 'PENDING',
  acted_at           timestamptz,
  acted_by_user_id   uuid REFERENCES public.uw_user(user_id),
  created_at         timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fac_ai_rec_risk_status_created
  ON public.fac_ai_recommendation (fac_risk_id, status, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. fac_ai_extraction_field — catalogue of canonical field codes the
-- AI runner is allowed to emit. Anything the model returns whose
-- target_field is not in here is silently dropped (defence in depth
-- against hallucinated keys).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.fac_ai_extraction_field (
  field_code  text PRIMARY KEY,
  screen      text NOT NULL,
  data_type   text NOT NULL,
  description text
);

INSERT INTO public.fac_ai_extraction_field (field_code, screen, data_type, description) VALUES
  -- Risk header
  ('cedant_name',            'FAC_RISK_DETAIL', 'TEXT',  'Cedant company name as it appears on the slip'),
  ('original_insured',       'FAC_RISK_DETAIL', 'TEXT',  'Insured / assured name'),
  ('inception_date',         'FAC_RISK_DETAIL', 'DATE',  'Policy inception date'),
  ('expiry_date',            'FAC_RISK_DETAIL', 'DATE',  'Policy expiry date'),
  ('occupancy_code',         'FAC_RISK_DETAIL', 'INT',   'Resolved occupancy code (after server fuzzy-mapping the name)'),

  -- Sum insured / locations
  ('original_pd_si',         'FAC_LOCATIONS',   'NUMERIC',  'Material damage SI in original currency'),
  ('original_bi_si',         'FAC_LOCATIONS',   'NUMERIC',  'Business interruption SI in original currency'),
  ('pd_pml_pct',             'FAC_LOCATIONS',   'NUMERIC',  'MD PML as a fraction 0..1'),
  ('bi_pml_pct',             'FAC_LOCATIONS',   'NUMERIC',  'BI PML as a fraction 0..1'),
  ('original_ccy',           'FAC_LOCATIONS',   'TEXT',     '3-letter ISO currency code'),
  ('location.append',        'FAC_LOCATIONS',   'LOCATION_ARRAY', 'Append a new fac_location row'),

  -- Factor selections
  ('factor.CONSTRUCTION',      'FAC_PRICING', 'FACTOR_OPTION', 'Construction quality factor'),
  ('factor.AGE_OF_RISK',       'FAC_PRICING', 'FACTOR_OPTION', 'Age of risk factor'),
  ('factor.CLAIM_EXPERIENCE',  'FAC_PRICING', 'FACTOR_OPTION', 'Claim experience factor'),
  ('factor.FIRE_FIGHTING',     'FAC_PRICING', 'FACTOR_OPTION', 'Fire-fighting equipment factor'),
  ('factor.EXTERNAL_EXPOSURE', 'FAC_PRICING', 'FACTOR_OPTION', 'External exposure factor'),
  ('factor.NATCAT_EXPOSURE',   'FAC_PRICING', 'FACTOR_OPTION', 'Natural perils exposure factor'),
  ('factor.MANAGEMENT',        'FAC_PRICING', 'FACTOR_OPTION', 'Management quality factor'),
  ('factor.SURVEY_RATING',     'FAC_PRICING', 'FACTOR_OPTION', 'Survey report rating factor'),
  ('factor.SURVEY_AGE',        'FAC_PRICING', 'FACTOR_OPTION', 'Survey report age factor'),
  ('factor.DEDUCTIBLE_LEVEL',  'FAC_PRICING', 'FACTOR_OPTION', 'Deductible level factor'),
  ('factor.BI_PLAN',           'FAC_PRICING', 'FACTOR_OPTION', 'Business interruption plan factor'),

  -- Loss history
  ('loss_history.append',    'FAC_LOSS_HISTORY', 'LOSS_APPEND', 'Append a new fac_loss_history row'),

  -- Clauses & exclusions checklist
  ('clause.LM7',           'FAC_DEDUCTIBLES', 'CLAUSE_TOGGLE', 'LM7 wording clause toggle'),
  ('clause.ABI',           'FAC_DEDUCTIBLES', 'CLAUSE_TOGGLE', 'ABI wording clause toggle'),
  ('clause.LMA_3100',      'FAC_DEDUCTIBLES', 'CLAUSE_TOGGLE', 'Sanction limitation and exclusion clause'),
  ('clause.NMA_2919',      'FAC_DEDUCTIBLES', 'CLAUSE_TOGGLE', 'Political risks exclusion'),
  ('clause.NMA_2915',      'FAC_DEDUCTIBLES', 'CLAUSE_TOGGLE', 'Electronic data endorsement B'),
  ('clause.LM3_NMA_2737',  'FAC_DEDUCTIBLES', 'CLAUSE_TOGGLE', 'Claims cooperation clause'),

  -- COPE
  ('cope.construction_year',        'FAC_COPE', 'INT',     'Year of construction'),
  ('cope.fire_walls',               'FAC_COPE', 'TEXT',    'Fire-wall description / boolean-ish'),
  ('cope.sprinkler_system',         'FAC_COPE', 'TEXT',    'Sprinkler system description'),
  ('cope.sprinkler_type',           'FAC_COPE', 'TEXT',    'Sprinkler type'),
  ('cope.fire_brigade_distance_km', 'FAC_COPE', 'NUMERIC', 'Fire-brigade distance in km')
ON CONFLICT (field_code) DO UPDATE SET
  screen      = EXCLUDED.screen,
  data_type   = EXCLUDED.data_type,
  description = EXCLUDED.description;
