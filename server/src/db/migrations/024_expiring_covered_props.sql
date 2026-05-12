-- Migration 024: add covered_props JSONB column to expiring terms tables
-- Stores the "Covered Properties" rows from NpExpiringStructure screen
-- Idempotent: uses ADD COLUMN IF NOT EXISTS

ALTER TABLE public.contract_np_expiring_terms
  ADD COLUMN IF NOT EXISTS covered_props JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.quote_np_expiring_terms
  ADD COLUMN IF NOT EXISTS covered_props JSONB DEFAULT '[]'::jsonb;
