


-- 066_hot_path_indexes.sql
-- Targeted indexes for query patterns the EXPLAIN output flagged as
-- doing extra sorts or sequential scans on tables that are hit on every
-- home / dashboard / treaty-detail render. All `IF NOT EXISTS` so this
-- migration is idempotent.

-- ── contract_offer: "latest offer per contract" lookup ───────────────────────
-- Pattern (home.js, lookups.js, dashboard.js, nonProp.js):
--   SELECT ... FROM public.contract_offer o
--    WHERE o.contract_id = c.contract_id
--    ORDER BY o.updated_at DESC LIMIT 1
-- The pre-existing idx_contract_offer_contract is just (contract_id), so
-- the planner has to fetch every offer for the contract and sort. With
-- (contract_id, updated_at DESC) the LIMIT 1 lookup is a single index
-- seek — a meaningful win when this subquery is correlated to N rows.
CREATE INDEX IF NOT EXISTS idx_contract_offer_contract_updated
  ON public.contract_offer (contract_id, updated_at DESC);

-- nonProp.js variant uses created_at instead of updated_at.
CREATE INDEX IF NOT EXISTS idx_contract_offer_contract_created
  ON public.contract_offer (contract_id, created_at DESC);

-- ── contract_document: docs panel on quote / contract detail ─────────────────
-- Existing idx_quote_doc_lookup is (quote_id) only; the route also
-- ORDER BYs uploaded_at DESC. Composite removes the sort step on the
-- usually-small but always-fetched docs list.
CREATE INDEX IF NOT EXISTS idx_quote_doc_lookup_uploaded
  ON public.contract_document (quote_id, uploaded_at DESC)
  WHERE quote_id IS NOT NULL;

-- ── country: dashboard region filter ────────────────────────────────────────
-- dashboard.js builds region buckets via "WHERE region IS NOT NULL ORDER BY 1".
-- Tiny table, but worth a partial index since the same query also drives
-- other reference UIs and the SELECT DISTINCT region is otherwise a heap scan.
CREATE INDEX IF NOT EXISTS idx_country_region
  ON public.country (region)
  WHERE region IS NOT NULL;

-- ── contract: home-screen ORDER BY updated_at on filtered status ─────────────
-- We already have idx_contract_updated_at (updated_at DESC) and
-- idx_contract_assigned_status (assigned_to_user_id, uw_status, updated_at DESC).
-- The home query that hits this most without an assignee filter is:
--   WHERE c.uw_status NOT IN ('DRAFT') ORDER BY c.updated_at DESC LIMIT 50
-- A composite (uw_status, updated_at DESC) lets the planner walk the
-- index for any single status without re-sorting.
CREATE INDEX IF NOT EXISTS idx_contract_status_updated
  ON public.contract (uw_status, updated_at DESC);

-- Same pattern on the quote side — /quotes list + home submitted/quotes panel.
CREATE INDEX IF NOT EXISTS idx_quote_status_updated
  ON public.quote (status, updated_at DESC);

-- ── contract.uw_year: dashboard "DISTINCT uw_year" / portfolio export ───────
-- Already covered for non-NULL filtering via idx_contract_uw_year_status,
-- but that's a partial index excluding common terminal states. A plain
-- (uw_year DESC) helps the dashboard "last 10 years" lookup without
-- pulling the partial predicate into the rewrite.
CREATE INDEX IF NOT EXISTS idx_contract_uw_year_desc
  ON public.contract (uw_year DESC)
  WHERE uw_year IS NOT NULL;
