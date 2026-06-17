-- Migration 124: per-structure quote type + lead/follow line on quote_np_final_structure
-- Fully idempotent — safe to re-run on any DB state.
--
-- Lead/follow line is a SINGLE value "across" each NP final-quote structure (not
-- per layer), and quote type is per structure. NpFinalPricing's clientStructures
-- persist these via quotes.js saveQuoteFinalWorkflowState. The dedicated columns
-- make them queryable alongside selected_for_approval (raw_structure JSONB still
-- carries the full object). lead_line_pct is set for LEAD quotes; follow_line_pct
-- for INDICATIVE.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='quote_np_final_structure' AND column_name='quote_type') THEN
    ALTER TABLE public.quote_np_final_structure
      ADD COLUMN quote_type text NOT NULL DEFAULT 'LEAD';
  END IF;
END $$;

-- CHECK as a named constraint so the idempotency guard can find it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quote_np_final_structure'::regclass
      AND conname = 'quote_np_final_structure_quote_type_chk') THEN
    ALTER TABLE public.quote_np_final_structure
      ADD CONSTRAINT quote_np_final_structure_quote_type_chk
      CHECK (quote_type IN ('LEAD','INDICATIVE'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='quote_np_final_structure' AND column_name='lead_line_pct') THEN
    ALTER TABLE public.quote_np_final_structure ADD COLUMN lead_line_pct numeric;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='quote_np_final_structure' AND column_name='follow_line_pct') THEN
    ALTER TABLE public.quote_np_final_structure ADD COLUMN follow_line_pct numeric;
  END IF;
END $$;
