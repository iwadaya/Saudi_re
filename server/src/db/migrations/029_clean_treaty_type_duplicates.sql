-- 029: Align treaty_type table to the 11 canonical rows.
--
-- PROPORTIONAL (6):     Quota Share, Quota Share & Surplus, First Surplus,
--                       Second Surplus, Third Surplus, Fac Oblig
-- NON_PROPORTIONAL (5): Risk XL, CAT XL, Risk & CAT XL, Stop Loss, Aggregate XL
--
-- Any non-canonical rows have their contract/quote FKs nulled before deletion.
-- Canonical rows that are missing are inserted.

DO $$ DECLARE
  r RECORD;
BEGIN

  -- ── 1. Null FKs and delete any rows NOT in the canonical list ────────────
  FOR r IN
    SELECT treaty_type_id FROM public.treaty_type
    WHERE treaty_type NOT IN (
      'Quota Share', 'Quota Share & Surplus', 'First Surplus',
      'Second Surplus', 'Third Surplus', 'Fac Oblig',
      'Risk XL', 'CAT XL', 'Risk & CAT XL', 'Stop Loss', 'Aggregate XL'
    )
  LOOP
    UPDATE public.contract SET treaty_type_id = NULL WHERE treaty_type_id = r.treaty_type_id;
    UPDATE public.quote    SET treaty_type_id = NULL WHERE treaty_type_id = r.treaty_type_id;
    DELETE FROM public.treaty_type WHERE treaty_type_id = r.treaty_type_id;
  END LOOP;

  -- ── 2. Insert any missing canonical rows ─────────────────────────────────
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

END $$;

-- Drop the orphan plural alias table if it still exists (no FK constraints point to it)
DROP TABLE IF EXISTS public.treaty_types;
