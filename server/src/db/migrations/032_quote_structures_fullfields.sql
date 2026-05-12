-- Migration 032: Quote structures full-field save/hydrate fix
-- ─────────────────────────────────────────────────────────────
-- Ensures:
--   1. quote_np_layers gets a peril_scope CHECK constraint (matches contract_np_layers)
--   2. quote_np_layers: guarantee peril_scope is never NULL
--   3. Back-fill existing quote_np_terms JSONB rows so structures[].layers
--      include annualAggLimit, riskCover, catCover and cobRows include manual[].
--      Derives riskCover/catCover from peril_scope in quote_np_layers for struct 0;
--      other structures keep their stored value or default to true.
--   4. indexes for fast quote_np_layers and quote_np_terms lookups
-- Safe: all statements use IF NOT EXISTS / DO UPDATE / no destructive drops.
-- ─────────────────────────────────────────────────────────────

-- 1. Ensure peril_scope is NOT NULL with default
ALTER TABLE public.quote_np_layers
  ALTER COLUMN peril_scope SET NOT NULL,
  ALTER COLUMN peril_scope SET DEFAULT 'BOTH';

UPDATE public.quote_np_layers
   SET peril_scope = 'BOTH'
 WHERE peril_scope IS NULL;

-- 2. Add CHECK constraint if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'quote_np_layers_peril_scope_check'
       AND conrelid = 'public.quote_np_layers'::regclass
  ) THEN
    ALTER TABLE public.quote_np_layers
      ADD CONSTRAINT quote_np_layers_peril_scope_check
      CHECK (peril_scope = ANY (ARRAY['RISK'::text, 'CAT'::text, 'BOTH'::text]));
  END IF;
END $$;

-- 3. Back-fill JSONB: for each quote_np_terms row that has np_structure.structures,
--    re-merge annualAggLimit, riskCover, catCover into structures[].layers,
--    and manual[] into structures[].cobRows, using quote_np_layers as source for struct 0.
DO $$
DECLARE
  rec RECORD;
  struct_arr  jsonb;
  new_structs jsonb;
  struct_item jsonb;
  layer_item  jsonb;
  new_layers  jsonb;
  new_layer   jsonb;
  cob_item    jsonb;
  new_cobs    jsonb;
  new_cob     jsonb;
  db_layer    RECORD;
  s_idx       int;
  l_idx       int;
  layer_num   int;
BEGIN
  FOR rec IN
    SELECT qt.quote_id, qt.terms
      FROM public.quote_np_terms qt
     WHERE qt.terms ? 'np_structure'
       AND qt.terms->'np_structure' ? 'structures'
  LOOP
    struct_arr  := rec.terms->'np_structure'->'structures';
    new_structs := '[]'::jsonb;

    FOR s_idx IN 0 .. jsonb_array_length(struct_arr) - 1 LOOP
      struct_item := struct_arr -> s_idx;
      new_layers  := '[]'::jsonb;

      FOR l_idx IN 0 .. jsonb_array_length(struct_item->'layers') - 1 LOOP
        layer_item := struct_item->'layers' -> l_idx;
        layer_num  := COALESCE((layer_item->>'layer')::int, l_idx + 1);
        new_layer  := layer_item;

        -- For structure 0 (s_idx=0): pull real values from relational quote_np_layers
        IF s_idx = 0 THEN
          SELECT * INTO db_layer
            FROM public.quote_np_layers
           WHERE quote_id = rec.quote_id
             AND layer_number = layer_num
           LIMIT 1;

          IF FOUND THEN
            -- annualAggLimit from aggregate_limit
            IF db_layer.aggregate_limit IS NOT NULL THEN
              new_layer := jsonb_set(new_layer, '{annualAggLimit}',
                to_jsonb(db_layer.aggregate_limit::text));
            ELSIF NOT (new_layer ? 'annualAggLimit') THEN
              new_layer := new_layer || '{"annualAggLimit": ""}'::jsonb;
            END IF;

            -- riskCover / catCover from peril_scope
            new_layer := jsonb_set(new_layer, '{riskCover}',
              to_jsonb(db_layer.peril_scope = 'RISK' OR db_layer.peril_scope = 'BOTH'));
            new_layer := jsonb_set(new_layer, '{catCover}',
              to_jsonb(db_layer.peril_scope = 'CAT'  OR db_layer.peril_scope = 'BOTH'));
          ELSE
            -- No relational row — set defaults
            IF NOT (new_layer ? 'annualAggLimit') THEN
              new_layer := new_layer || '{"annualAggLimit": ""}'::jsonb;
            END IF;
            IF NOT (new_layer ? 'riskCover') THEN
              new_layer := new_layer || '{"riskCover": true}'::jsonb;
            END IF;
            IF NOT (new_layer ? 'catCover') THEN
              new_layer := new_layer || '{"catCover": true}'::jsonb;
            END IF;
          END IF;

        ELSE
          -- Other structures: just ensure the keys exist with defaults
          IF NOT (new_layer ? 'annualAggLimit') THEN
            new_layer := new_layer || '{"annualAggLimit": ""}'::jsonb;
          END IF;
          IF NOT (new_layer ? 'riskCover') THEN
            new_layer := new_layer || '{"riskCover": true}'::jsonb;
          END IF;
          IF NOT (new_layer ? 'catCover') THEN
            new_layer := new_layer || '{"catCover": true}'::jsonb;
          END IF;
        END IF;

        new_layers := new_layers || jsonb_build_array(new_layer);
      END LOOP;

      -- cobRows: ensure manual[] key exists on each row
      new_cobs := '[]'::jsonb;
      IF struct_item ? 'cobRows' THEN
        FOR l_idx IN 0 .. jsonb_array_length(struct_item->'cobRows') - 1 LOOP
          cob_item := struct_item->'cobRows' -> l_idx;
          IF NOT (cob_item ? 'manual') THEN
            cob_item := cob_item || '{"manual": []}'::jsonb;
          END IF;
          new_cobs := new_cobs || jsonb_build_array(cob_item);
        END LOOP;
      END IF;

      struct_item := jsonb_set(struct_item, '{layers}', new_layers);
      struct_item := jsonb_set(struct_item, '{cobRows}', new_cobs);
      new_structs := new_structs || jsonb_build_array(struct_item);
    END LOOP;

    -- Write back merged structures into the JSONB blob
    UPDATE public.quote_np_terms
       SET terms = jsonb_set(terms,
                    '{np_structure,structures}',
                    new_structs),
           updated_at = now()
     WHERE quote_id = rec.quote_id;
  END LOOP;
END $$;

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_quote_np_layers_quote_layer
  ON public.quote_np_layers (quote_id, layer_number);

CREATE INDEX IF NOT EXISTS idx_quote_np_terms_quote
  ON public.quote_np_terms (quote_id);
