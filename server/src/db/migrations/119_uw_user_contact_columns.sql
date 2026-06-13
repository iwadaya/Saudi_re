-- Migration 119: uw_user contact columns (phone, company_id)
-- Fully idempotent — safe to run multiple times on any DB state.
--
-- POST /auth/users (server/src/routes/auth.js) inserts into uw_user.phone and
-- uw_user.company_id; on databases provisioned before those columns existed the
-- insert failed with 42703 (undefined_column) → 500. Add them in the DO-block
-- style of 034_role_hierarchy_and_mandates.sql.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='uw_user' AND column_name='phone') THEN
    ALTER TABLE public.uw_user ADD COLUMN phone text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='uw_user' AND column_name='company_id') THEN
    ALTER TABLE public.uw_user ADD COLUMN company_id uuid;
  END IF;
END $$;

-- company_id stays a nullable uuid. A FK to public.companies is added ONLY when
-- that table's company_id carries a single-column unique/PK constraint — early
-- schemas created public.companies without a PRIMARY KEY (000_core_schema.sql),
-- and a FK to a non-unique column raises 42830, which is not a skippable error
-- and would break the idempotent re-run guarantee. The guard keeps this clean on
-- every DB shape while wiring the FK where the constraint exists.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='uw_user'
      AND constraint_name='uw_user_company_id_fkey'
  ) AND EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class rel       ON rel.oid = con.conrelid
    JOIN pg_namespace ns    ON ns.oid = rel.relnamespace
    JOIN pg_attribute att   ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
    WHERE ns.nspname = 'public' AND rel.relname = 'companies'
      AND con.contype IN ('p', 'u')
      AND att.attname = 'company_id'
      AND array_length(con.conkey, 1) = 1
  ) THEN
    ALTER TABLE public.uw_user
      ADD CONSTRAINT uw_user_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES public.companies (company_id) ON DELETE SET NULL;
  END IF;
END $$;
