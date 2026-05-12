-- 073_pricing_component_persistence_alignment.sql
--
-- Align pricing persistence tables with the active /api/pricing/save and
-- /api/pricing/:id/component-snapshot routes.

ALTER TABLE public.pricing_components
  ADD COLUMN IF NOT EXISTS selected boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS underwriter_value text,
  ADD COLUMN IF NOT EXISTS display_order integer;

UPDATE public.pricing_components
   SET underwriter_value = uw_value
 WHERE underwriter_value IS NULL
   AND uw_value IS NOT NULL;

ALTER TABLE public.contract_pricing_outputs
  ALTER COLUMN technical_result TYPE numeric(20,8);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'pricing_component_snapshots'
       AND column_name = 'id'
       AND column_default IS NOT NULL
  ) THEN
    CREATE SEQUENCE IF NOT EXISTS public.pricing_component_snapshots_id_seq;

    ALTER TABLE public.pricing_component_snapshots
      ALTER COLUMN id SET DEFAULT nextval('public.pricing_component_snapshots_id_seq');

    ALTER SEQUENCE public.pricing_component_snapshots_id_seq
      OWNED BY public.pricing_component_snapshots.id;
  END IF;

  IF to_regclass('public.pricing_component_snapshots_id_seq') IS NOT NULL THEN
    PERFORM setval(
      'public.pricing_component_snapshots_id_seq',
      COALESCE((SELECT max(id) FROM public.pricing_component_snapshots), 0) + 1,
      false
    );
  END IF;
END $$;
