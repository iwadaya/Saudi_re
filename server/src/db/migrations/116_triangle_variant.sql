-- Migration 116: ACTUAL vs MODIFIED triangle variant
--
-- Reinsurance underwriters strip large/cat losses OUTSIDE this tool and enter
-- two triangles side by side:
--   * MODIFIED — the already-stripped triangle. This is what the tool PROJECTS.
--   * ACTUAL   — the gross triangle, stored for reference/audit only. It does
--                NOT feed projection, dev-factor selection, or incurred-combine.
--
-- We add this distinction as a `variant` dimension ON the existing cell tables
-- (contract_triangle_cells / quote_triangle_cells) — NOT a parallel table — so
-- a cell is uniquely keyed by (<id>, type, variant, origin_year, dev_months).
--
-- BACKFILL: every existing row is the projected triangle, so the new column
-- defaults to 'MODIFIED' and existing rows backfill to 'MODIFIED' intentionally.
-- ('MODIFIED'::triangle_variant is a constant default, so the ADD COLUMN is a
--  metadata-only change — no table rewrite.)
--
-- INCURRED is still never stored (it's paid + OS, derived at read time) and so
-- has no variant of its own.

-- ── triangle_variant enum: create if absent ──
DO $$
BEGIN
  CREATE TYPE public.triangle_variant AS ENUM ('ACTUAL', 'MODIFIED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── add variant column to both cell tables (existing rows → MODIFIED) ──
ALTER TABLE public.contract_triangle_cells
  ADD COLUMN IF NOT EXISTS variant public.triangle_variant NOT NULL DEFAULT 'MODIFIED';

ALTER TABLE public.quote_triangle_cells
  ADD COLUMN IF NOT EXISTS variant public.triangle_variant NOT NULL DEFAULT 'MODIFIED';

-- ── drop the pre-variant UNIQUE constraint on each table ──
-- Name-agnostic: find the unique constraint that does NOT already include the
-- `variant` column and drop it. After the variant-aware constraint below exists,
-- this finds nothing (it includes `variant`), so re-runs are a safe no-op.
DO $$
DECLARE conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class      r ON r.oid = c.conrelid
  JOIN pg_namespace  n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND r.relname = 'contract_triangle_cells'
    AND c.contype = 'u'
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(c.conkey) ck
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck
      WHERE a.attname = 'variant'
    )
  LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.contract_triangle_cells DROP CONSTRAINT %I', conname);
  END IF;
END $$;

DO $$
DECLARE conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class      r ON r.oid = c.conrelid
  JOIN pg_namespace  n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public'
    AND r.relname = 'quote_triangle_cells'
    AND c.contype = 'u'
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(c.conkey) ck
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ck
      WHERE a.attname = 'variant'
    )
  LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.quote_triangle_cells DROP CONSTRAINT %I', conname);
  END IF;
END $$;

-- ── add the variant-aware UNIQUE constraints ──
-- The UNIQUE constraint creates a backing btree index on
-- (<id>, type, variant, origin_year, dev_months). That index's leading prefix
-- (<id>, type, variant) already serves the per-(id, type, variant) lookup, so
-- the old dedicated lookup indexes below are dropped rather than recreated — a
-- separate (id, type, variant) index would be pure duplicate write overhead.
DO $$
BEGIN
  ALTER TABLE public.contract_triangle_cells
    ADD CONSTRAINT contract_triangle_cells_variant_key
    UNIQUE (contract_id, type, variant, origin_year, dev_months);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.quote_triangle_cells
    ADD CONSTRAINT quote_triangle_variant_unique
    UNIQUE (quote_id, type, variant, origin_year, dev_months);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── drop the now-redundant pre-variant lookup indexes ──
-- Superseded by the leading prefix of each variant-aware UNIQUE constraint's
-- backing index (see note above). Keeping them would only add write overhead.
DROP INDEX IF EXISTS public.idx_triangle_cells_contract;
DROP INDEX IF EXISTS public.idx_quote_triangle_lookup;
