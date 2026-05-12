-- Migration 025: Add UNIQUE constraint on contract_offer(contract_id) for ON CONFLICT upsert support
-- Idempotent: uses ADD CONSTRAINT IF NOT EXISTS pattern via DO block

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contract_offer_contract_id_key'
      AND conrelid = 'public.contract_offer'::regclass
  ) THEN
    ALTER TABLE public.contract_offer
      ADD CONSTRAINT contract_offer_contract_id_key UNIQUE (contract_id);
  END IF;
END $$;
