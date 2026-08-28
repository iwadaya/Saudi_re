-- 155: Make fac_layer / fac_pricing_method uniqueness hold for NULL
--       section_id rows (audit F86).
--
-- fac_layer_unique (136) and fac_pricing_method_unique (135) are UNIQUE
-- constraints over a NULLABLE section_id. PostgreSQL treats NULLs as
-- distinct by default, so for the common section-less rows the constraints
-- enforced nothing: two concurrent PUT /fac/risks/:id/layers saves (a
-- DELETE-then-INSERT with no advisory lock) could both insert the same
-- (fac_risk_id, NULL, layer_no) tower, doubling every SUM the fac dashboard
-- rolls up — the exact MVCC race migration 064 documented and fixed for
-- CRESTA. 136's own backfill (`ON CONFLICT ON CONSTRAINT fac_layer_unique DO
-- NOTHING`) could never observe a conflict for the NULL-section rows it
-- inserted.
--
-- Fix: recreate both constraints as UNIQUE NULLS NOT DISTINCT (PostgreSQL
-- 15+; the deployment targets PG 16). The constraint NAMES are preserved so
-- 136's ON CONFLICT ON CONSTRAINT reference (and any other by-name arbiter)
-- keeps working. Existing NULL-section duplicates are removed first, keeping
-- the most recently written row per key — verified zero such duplicates on
-- the live test DB, so the DELETEs are no-ops there.
--
-- Note (flagged, out of scope here): the save handlers in
-- routes/facultative.js still lack the per-risk pg_advisory_xact_lock the
-- CRESTA handlers take. With this constraint the concurrent double-save now
-- fails loudly (unique violation on the second commit) instead of silently
-- doubling the tower.

-- ── fac_layer ───────────────────────────────────────────────────────────────
-- Dedupe NULL-section duplicates: keep the newest (updated_at, then
-- created_at, then layer_id as a deterministic tie-break) per
-- (fac_risk_id, layer_no).
DELETE FROM public.fac_layer f
 USING public.fac_layer g
 WHERE f.fac_risk_id = g.fac_risk_id
   AND f.layer_no    = g.layer_no
   AND f.section_id IS NULL
   AND g.section_id IS NULL
   AND (COALESCE(f.updated_at, f.created_at, 'epoch'::timestamptz), f.layer_id)
     < (COALESCE(g.updated_at, g.created_at, 'epoch'::timestamptz), g.layer_id);

ALTER TABLE public.fac_layer
  DROP CONSTRAINT IF EXISTS fac_layer_unique;

ALTER TABLE public.fac_layer
  ADD CONSTRAINT fac_layer_unique
  UNIQUE NULLS NOT DISTINCT (fac_risk_id, section_id, layer_no);

-- ── fac_pricing_method ──────────────────────────────────────────────────────
DELETE FROM public.fac_pricing_method f
 USING public.fac_pricing_method g
 WHERE f.fac_risk_id = g.fac_risk_id
   AND f.method_code = g.method_code
   AND f.section_id IS NULL
   AND g.section_id IS NULL
   AND (COALESCE(f.created_at, 'epoch'::timestamptz), f.method_row_id)
     < (COALESCE(g.created_at, 'epoch'::timestamptz), g.method_row_id);

ALTER TABLE public.fac_pricing_method
  DROP CONSTRAINT IF EXISTS fac_pricing_method_unique;

ALTER TABLE public.fac_pricing_method
  ADD CONSTRAINT fac_pricing_method_unique
  UNIQUE NULLS NOT DISTINCT (fac_risk_id, section_id, method_code);
