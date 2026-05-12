-- Migration 011: Add doc_type and title to contract_document
ALTER TABLE public.contract_document ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE public.contract_document ADD COLUMN IF NOT EXISTS title text;
