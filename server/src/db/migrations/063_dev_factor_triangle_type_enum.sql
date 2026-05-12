-- 063: Convert {contract,quote}_dev_factor.triangle_type from TEXT to the
-- public.triangle_type ENUM, matching the type already used on
-- {contract,quote}_triangle_cells.type.
--
-- Without this, a typo in the URL (e.g. /dev-factors/foo) silently
-- writes triangle_type='FOO' since the column accepts arbitrary text.
-- The route handlers already uppercase the URL param, so the only
-- legitimate values are PREMIUM / CLAIMS_PAID / CLAIMS_OS / INCURRED
-- — exactly the enum's labels.
--
-- Strategy: normalise any case drift first (defensive — values should
-- already be upper-cased by the route), then ALTER COLUMN with USING.
-- If a row carries a value outside the enum, the ALTER will fail loudly
-- and operators must inspect/clean before re-running. That's the right
-- failure mode here: a non-enum dev_factor.triangle_type is broken data
-- whose downstream pricing reads will produce nonsense.

DO $$
BEGIN
  -- Normalise existing rows up-front so the cast succeeds.
  UPDATE public.contract_dev_factor
     SET triangle_type = upper(triangle_type)
   WHERE triangle_type IS NOT NULL
     AND triangle_type <> upper(triangle_type);

  UPDATE public.quote_dev_factor
     SET triangle_type = upper(triangle_type)
   WHERE triangle_type IS NOT NULL
     AND triangle_type <> upper(triangle_type);

  -- contract_dev_factor.triangle_type → public.triangle_type
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='contract_dev_factor'
       AND column_name='triangle_type'
       AND udt_name='text'
  ) THEN
    ALTER TABLE public.contract_dev_factor
      ALTER COLUMN triangle_type TYPE public.triangle_type
      USING triangle_type::public.triangle_type;
  END IF;

  -- quote_dev_factor.triangle_type → public.triangle_type
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='quote_dev_factor'
       AND column_name='triangle_type'
       AND udt_name='text'
  ) THEN
    ALTER TABLE public.quote_dev_factor
      ALTER COLUMN triangle_type TYPE public.triangle_type
      USING triangle_type::public.triangle_type;
  END IF;
END$$;
