-- Migration 026: Add next_approver column to public.quote for CU approval workflow
ALTER TABLE public.quote ADD COLUMN IF NOT EXISTS next_approver text;
