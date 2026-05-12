-- Migration 043: Fix quote_offer table
-- Ensures primary key, signed_line_pct column, and offer_approval_event quote_id index

-- 1. Add PRIMARY KEY on quote_offer if missing (required for ON CONFLICT upserts)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quote_offer'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE public.quote_offer ADD CONSTRAINT quote_offer_pkey PRIMARY KEY (quote_id);
  END IF;
END $$;

-- 2. Add signed_line_pct column if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quote_offer'
      AND column_name = 'signed_line_pct'
  ) THEN
    ALTER TABLE public.quote_offer ADD COLUMN signed_line_pct numeric(10,6);
  END IF;
END $$;

-- 3. Add signed_at / ntu_at / ntu_reason / decline_reason columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_offer' AND column_name='signed_at') THEN
    ALTER TABLE public.quote_offer ADD COLUMN signed_at timestamptz;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_offer' AND column_name='ntu_at') THEN
    ALTER TABLE public.quote_offer ADD COLUMN ntu_at timestamptz;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_offer' AND column_name='ntu_reason') THEN
    ALTER TABLE public.quote_offer ADD COLUMN ntu_reason text;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='quote_offer' AND column_name='decline_reason') THEN
    ALTER TABLE public.quote_offer ADD COLUMN decline_reason text;
  END IF;
END $$;

-- 4. Ensure offer_approval_event has quote_id index (for quote approval trail queries)
CREATE INDEX IF NOT EXISTS idx_offer_event_quote_id
  ON public.offer_approval_event (quote_id, created_at ASC)
  WHERE quote_id IS NOT NULL;

-- 5. Add quote_id to offer_approval_event if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'offer_approval_event'
      AND column_name = 'quote_id'
  ) THEN
    ALTER TABLE public.offer_approval_event ADD COLUMN quote_id uuid;
  END IF;
END $$;


-- 6. Add parent_contract_id to quote table (for renewal chain tracking)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quote'
      AND column_name = 'parent_contract_id'
  ) THEN
    ALTER TABLE public.quote ADD COLUMN parent_contract_id uuid;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_quote_parent
  ON public.quote (parent_contract_id)
  WHERE parent_contract_id IS NOT NULL;

-- 7. Add alt_contract_id to quote table (display reference)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quote'
      AND column_name = 'alt_contract_id'
  ) THEN
    ALTER TABLE public.quote ADD COLUMN alt_contract_id text;
  END IF;
END $$;
