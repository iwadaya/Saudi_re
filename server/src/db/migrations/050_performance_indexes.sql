-- 050_performance_indexes.sql
-- Additional indexes for tables added in migrations 047-049 and for
-- frequently-filtered lookup queries.

-- ── companies: cedant lookup by country (fired on every treaty detail open) ──
CREATE INDEX IF NOT EXISTS idx_companies_country_id
  ON public.companies (country_id)
  WHERE country_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_name
  ON public.companies (company_name);

-- ── contract: updated_at for home screen ORDER BY ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_contract_updated_at
  ON public.contract (updated_at DESC);

-- ── contract: uw_year filter for region premium aggregation ───────────────────
CREATE INDEX IF NOT EXISTS idx_contract_uw_year_status
  ON public.contract (uw_year, uw_status)
  WHERE uw_status NOT IN ('DRAFT', 'DECLINED', 'NTU');

-- ── contract_class_of_business: COB aggregation (home + treaty detail) ────────
-- Already have idx_ccob_contract but add covering index with class_of_business_id
CREATE INDEX IF NOT EXISTS idx_ccob_contract_cob
  ON public.contract_class_of_business (contract_id, class_of_business_id);

-- ── quote_class_of_business: same for quotes ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_qcob_quote_cob
  ON public.quote_class_of_business (quote_id, class_of_business_id);

-- ── NP excess LDF tables (migration 047) ─────────────────────────────────────
-- Primary keys already exist; add composite for range scans
CREATE INDEX IF NOT EXISTS idx_contract_np_excess_ldf_devmonth
  ON public.contract_np_excess_ldf (contract_id, dev_month);

CREATE INDEX IF NOT EXISTS idx_quote_np_excess_ldf_devmonth
  ON public.quote_np_excess_ldf (quote_id, dev_month);

-- ── NP large loss LDF / ultimate tables (migration 048) ──────────────────────
CREATE INDEX IF NOT EXISTS idx_contract_np_ll_ldf_devmonth
  ON public.contract_np_large_loss_ldf (contract_id, dev_month);

CREATE INDEX IF NOT EXISTS idx_quote_np_ll_ldf_devmonth
  ON public.quote_np_large_loss_ldf (quote_id, dev_month);

CREATE INDEX IF NOT EXISTS idx_contract_np_cat_ldf_devmonth
  ON public.contract_np_cat_loss_ldf (contract_id, dev_month);

CREATE INDEX IF NOT EXISTS idx_quote_np_cat_ldf_devmonth
  ON public.quote_np_cat_loss_ldf (quote_id, dev_month);

CREATE INDEX IF NOT EXISTS idx_contract_np_ll_ult_year
  ON public.contract_np_large_loss_ultimate (contract_id, acc_year);

CREATE INDEX IF NOT EXISTS idx_contract_np_cat_ult_year
  ON public.contract_np_cat_loss_ultimate (contract_id, acc_year);

-- ── loss selection snapshots: latest snapshot query ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_loss_sel_contract_type
  ON public.contract_loss_selection_snapshot (contract_id, loss_type, created_at DESC)
  WHERE contract_id IS NOT NULL;

-- ── contract_np_terms: JSONB fast path ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_np_terms_contract_gin
  ON public.contract_np_terms USING gin (terms)
  WHERE terms IS NOT NULL;

-- ── triangle cells: frequently scanned by type ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_triangle_cells_contract_type
  ON public.contract_triangle_cells (contract_id, type, origin_year);
