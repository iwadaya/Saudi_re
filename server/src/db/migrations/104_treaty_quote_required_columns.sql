-- 104: NOT NULL integrity on always-required identifying columns for
-- contract and quote. Wipes any existing rows that violate (test data
-- per operator confirmation). FK CASCADE on child tables (added in
-- migration 057) handles child cleanup.
--
-- App-layer Treaty Detail validation prevents the user-facing path
-- from ever creating a row that violates these constraints, so this
-- is purely integrity hardening — not a behavior change.
--
-- Columns NOT changed: qs_limit, surplus_max_retention, retention_pct,
-- cession_pct, num_lines, EPIs, commission fields, LP fields. Those
-- are conditional on treaty/commission mode and stay nullable; the
-- app layer enforces them.
--
-- The migration runner wraps every file in a transaction already, so
-- there's no explicit BEGIN/COMMIT here (matches 100..103).

-- ── Clean up rows that violate the new constraints ─────────────────
-- Child tables CASCADE via FK constraints from migration 057.
DELETE FROM public.contract
 WHERE cedant_id        IS NULL
    OR broker_id        IS NULL
    OR currency_id      IS NULL
    OR country_id       IS NULL
    OR treaty_type_id   IS NULL
    OR inception_date   IS NULL;

DELETE FROM public.quote
 WHERE cedant_id        IS NULL
    OR broker_id        IS NULL
    OR currency_id      IS NULL
    OR country_id       IS NULL
    OR treaty_type_id   IS NULL
    OR uw_year          IS NULL
    OR inception_date   IS NULL;

-- ── contract ───────────────────────────────────────────────────────
-- uw_year is already NOT NULL on contract; included here for symmetry
-- with the quote block — the SET NOT NULL on an already-NOT-NULL
-- column is a no-op in PostgreSQL.
ALTER TABLE public.contract ALTER COLUMN cedant_id        SET NOT NULL;
ALTER TABLE public.contract ALTER COLUMN broker_id        SET NOT NULL;
ALTER TABLE public.contract ALTER COLUMN currency_id      SET NOT NULL;
ALTER TABLE public.contract ALTER COLUMN country_id       SET NOT NULL;
ALTER TABLE public.contract ALTER COLUMN treaty_type_id   SET NOT NULL;
ALTER TABLE public.contract ALTER COLUMN uw_year          SET NOT NULL;
ALTER TABLE public.contract ALTER COLUMN inception_date   SET NOT NULL;

-- ── quote ──────────────────────────────────────────────────────────
ALTER TABLE public.quote ALTER COLUMN cedant_id        SET NOT NULL;
ALTER TABLE public.quote ALTER COLUMN broker_id        SET NOT NULL;
ALTER TABLE public.quote ALTER COLUMN currency_id      SET NOT NULL;
ALTER TABLE public.quote ALTER COLUMN country_id       SET NOT NULL;
ALTER TABLE public.quote ALTER COLUMN treaty_type_id   SET NOT NULL;
ALTER TABLE public.quote ALTER COLUMN uw_year          SET NOT NULL;
ALTER TABLE public.quote ALTER COLUMN inception_date   SET NOT NULL;
