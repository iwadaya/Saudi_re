-- Migration 059: Force-attach DEFAULT nextval(...) to NP expiring id columns
--
-- Migration 000 created contract_np_expiring_terms (and the layer + quote
-- twins) with `id integer NOT NULL` — no sequence, no default. Migration
-- 021 tried to recreate them with SERIAL PRIMARY KEY but used CREATE TABLE
-- IF NOT EXISTS, so any DB that already had the 000 version got the fix
-- as a no-op. The INSERTs in npExpiringPut() don't specify id, so on
-- those DBs every save fails with
--   null value in column "id" of relation "contract_np_expiring_terms"
--   violates not-null constraint
--
-- CREATE SEQUENCE IF NOT EXISTS + ALTER COLUMN SET DEFAULT are both
-- idempotent, so re-running on a correctly-configured DB is a no-op.

-- ── contract_np_expiring_layers.expiring_layer_id ──
CREATE SEQUENCE IF NOT EXISTS public.contract_np_expiring_layers_expiring_layer_id_seq
  OWNED BY public.contract_np_expiring_layers.expiring_layer_id;
ALTER TABLE public.contract_np_expiring_layers
  ALTER COLUMN expiring_layer_id
  SET DEFAULT nextval('public.contract_np_expiring_layers_expiring_layer_id_seq');
SELECT setval(
  'public.contract_np_expiring_layers_expiring_layer_id_seq',
  COALESCE((SELECT MAX(expiring_layer_id) FROM public.contract_np_expiring_layers), 0) + 1,
  false
);

-- ── quote_np_expiring_layers.expiring_layer_id ──
CREATE SEQUENCE IF NOT EXISTS public.quote_np_expiring_layers_expiring_layer_id_seq
  OWNED BY public.quote_np_expiring_layers.expiring_layer_id;
ALTER TABLE public.quote_np_expiring_layers
  ALTER COLUMN expiring_layer_id
  SET DEFAULT nextval('public.quote_np_expiring_layers_expiring_layer_id_seq');
SELECT setval(
  'public.quote_np_expiring_layers_expiring_layer_id_seq',
  COALESCE((SELECT MAX(expiring_layer_id) FROM public.quote_np_expiring_layers), 0) + 1,
  false
);

-- ── contract_np_expiring_terms.id ──
CREATE SEQUENCE IF NOT EXISTS public.contract_np_expiring_terms_id_seq
  OWNED BY public.contract_np_expiring_terms.id;
ALTER TABLE public.contract_np_expiring_terms
  ALTER COLUMN id
  SET DEFAULT nextval('public.contract_np_expiring_terms_id_seq');
SELECT setval(
  'public.contract_np_expiring_terms_id_seq',
  COALESCE((SELECT MAX(id) FROM public.contract_np_expiring_terms), 0) + 1,
  false
);

-- ── quote_np_expiring_terms.id ──
CREATE SEQUENCE IF NOT EXISTS public.quote_np_expiring_terms_id_seq
  OWNED BY public.quote_np_expiring_terms.id;
ALTER TABLE public.quote_np_expiring_terms
  ALTER COLUMN id
  SET DEFAULT nextval('public.quote_np_expiring_terms_id_seq');
SELECT setval(
  'public.quote_np_expiring_terms_id_seq',
  COALESCE((SELECT MAX(id) FROM public.quote_np_expiring_terms), 0) + 1,
  false
);
