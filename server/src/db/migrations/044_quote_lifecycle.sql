-- Migration 044: Quote lifecycle — amendment versioning + quote→contract binding
-- 
-- LIFECYCLE:
--   DRAFT → AWAITING_APPROVAL → APPROVED → AWAITING_SIGNED_LINE
--   → SIGNED (accepted: triggers bind to contract)
--   → AMENDED (cedant requests changes: creates new quote version)
--   → NTU | DECLINED (terminal)
--
-- AMENDMENT: Each amendment creates a new quote row linked via quote_version_of.
-- The original quote is marked SUPERSEDED; the new version starts as DRAFT.
-- All amendment history is queryable via the version chain.
--
-- BINDING: When CUO/UW confirms acceptance (SIGNED), a new contract is created
-- and all quote data is copied into contract_* tables. The quote gains a
-- bound_contract_id back-reference. The contract gains source_quote_id.

-- ── 1. Add lifecycle columns to quote table ────────────────────────────────

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='quote_ref') THEN
  -- Human-readable quote reference e.g. QT-2026-0042
  ALTER TABLE public.quote ADD COLUMN quote_ref text;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='quote_version') THEN
  ALTER TABLE public.quote ADD COLUMN quote_version integer NOT NULL DEFAULT 1;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='quote_version_of') THEN
  -- Points to the original quote_id this is an amendment of (NULL = original)
  ALTER TABLE public.quote ADD COLUMN quote_version_of uuid;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='amendment_reason') THEN
  ALTER TABLE public.quote ADD COLUMN amendment_reason text;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='amended_at') THEN
  ALTER TABLE public.quote ADD COLUMN amended_at timestamptz;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='bound_contract_id') THEN
  -- Set when quote is bound to a contract
  ALTER TABLE public.quote ADD COLUMN bound_contract_id uuid;
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote' AND column_name='bound_at') THEN
  ALTER TABLE public.quote ADD COLUMN bound_at timestamptz;
END IF; END $$;

-- ── 2. Add source_quote_id to contract table ───────────────────────────────

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contract' AND column_name='source_quote_id') THEN
  ALTER TABLE public.contract ADD COLUMN source_quote_id uuid;
END IF; END $$;

-- ── 3. Quote version sequence for human-readable refs ─────────────────────
CREATE SEQUENCE IF NOT EXISTS public.quote_ref_seq START 1;

-- ── 4. Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_quote_version_of ON public.quote (quote_version_of) WHERE quote_version_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_bound_contract ON public.quote (bound_contract_id) WHERE bound_contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contract_source_quote ON public.contract (source_quote_id) WHERE source_quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quote_ref ON public.quote (quote_ref) WHERE quote_ref IS NOT NULL;


-- ── 5. quote_np_egnpi_year: add inflation_pct + unique constraint ──────────
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_np_egnpi_year' AND column_name='inflation_pct') THEN
  ALTER TABLE public.quote_np_egnpi_year ADD COLUMN inflation_pct numeric(8,4);
END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='quote_np_egnpi_year_quote_year_unique') THEN
  ALTER TABLE public.quote_np_egnpi_year ADD CONSTRAINT quote_np_egnpi_year_quote_year_unique UNIQUE (quote_id, uw_year);
END IF; END $$;
