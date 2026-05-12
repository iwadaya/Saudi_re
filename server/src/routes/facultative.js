// server/src/routes/facultative.js
// Facultative reinsurance module — CRUD for risks, locations, COPE,
// loss history, dual pricing, documents, market rates, and home listing.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler, numOrNull, dateOrNull } from '../helpers.js';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// LOOKUPS — fac classes of business + market rates
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/lookups/classes', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT fac_cob_id, class_name, category, code, is_project
     FROM public.fac_class_of_business ORDER BY category, class_name`
  );
  res.json(rows);
}));

router.get('/fac/lookups/market-rates', asyncHandler(async (req, res) => {
  const { fac_cob_id, region, hazard_grade } = req.query;
  let sql = `SELECT * FROM public.fac_market_rate WHERE 1=1`;
  const params = [];
  if (fac_cob_id) { params.push(fac_cob_id); sql += ` AND fac_cob_id = $${params.length}`; }
  if (region) { params.push(region); sql += ` AND region = $${params.length}`; }
  if (hazard_grade) { params.push(hazard_grade); sql += ` AND hazard_grade = $${params.length}`; }
  sql += ` ORDER BY region, hazard_grade`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC HOME — list all risks with filters
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks', asyncHandler(async (req, res) => {
  const { status, search } = req.query;

  let sql = `
    SELECT r.fac_risk_id, r.fac_ref, r.insured_name, r.status,
           r.total_sum_insured, r.ri_premium, r.original_premium,
           r.inception_date, r.expiry_date, r.uw_year,
           r.placement_type, r.cedant_retention_pct, r.ri_share_pct,
           r.created_at, r.updated_at,
           c.company_name AS cedant_name,
           co.country_name,
           cb.class_name AS cob_name, cb.category AS cob_category,
           cu.currency_code,
           u.display_name AS assigned_to_name
    FROM public.fac_risk r
    LEFT JOIN public.companies c ON c.company_id = r.cedant_id
    LEFT JOIN public.country co ON co.country_id = r.country_id
    LEFT JOIN public.fac_class_of_business cb ON cb.fac_cob_id = r.fac_cob_id
    LEFT JOIN public.currency cu ON cu.currency_id = r.currency_id
    LEFT JOIN public.uw_user u ON u.user_id = r.assigned_to_user_id
    WHERE 1=1
  `;
  const params = [];

  if (status && status !== 'ALL') {
    params.push(status);
    sql += ` AND r.status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (r.fac_ref ILIKE $${params.length}
             OR r.insured_name ILIKE $${params.length}
             OR c.company_name ILIKE $${params.length}
             OR co.country_name ILIKE $${params.length}
             OR cb.class_name ILIKE $${params.length})`;
  }
  sql += ` ORDER BY r.updated_at DESC NULLS LAST LIMIT 200`;

  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC RISK — CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET single risk (full detail)
router.get('/fac/risks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(`
    SELECT r.*,
           c.company_name AS cedant_name,
           co.country_name,
           cb.class_name AS cob_name, cb.category AS cob_category,
           cu.currency_code,
           b.broker_name
    FROM public.fac_risk r
    LEFT JOIN public.companies c ON c.company_id = r.cedant_id
    LEFT JOIN public.country co ON co.country_id = r.country_id
    LEFT JOIN public.fac_class_of_business cb ON cb.fac_cob_id = r.fac_cob_id
    LEFT JOIN public.currency cu ON cu.currency_id = r.currency_id
    LEFT JOIN public.brokers b ON b.broker_id = r.broker_id
    WHERE r.fac_risk_id = $1
  `, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Risk not found' });
  res.json(rows[0]);
}));

// CREATE new risk
router.post('/fac/risks', asyncHandler(async (req, res) => {
  const b = req.body;
  const { rows } = await pool.query(`
    INSERT INTO public.fac_risk (
      cedant_id, broker_id, country_id, currency_id,
      insured_name, insured_address, nature_of_business, fac_cob_id,
      inception_date, expiry_date, policy_period_months, uw_year,
      total_sum_insured, pd_sum_insured, bi_sum_insured,
      placement_type, cedant_retention_pct, ri_share_pct, our_share_pct,
      np_retention, np_limit, np_our_share_pct,
      deductible_amount, deductible_description,
      commission_pct, brokerage_pct, taxes_pct,
      original_premium, ri_premium, original_rate,
      pml_amount, pml_pct, mfl_amount, mfl_pct,
      created_by_user_id, assigned_to_user_id,
      linked_contract_id, underwriter_notes, status
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
      $31,$32,$33,$34,$35,$36,$37,$38,$39
    ) RETURNING *
  `, [
    b.cedant_id || null, b.broker_id || null, b.country_id || null, b.currency_id || null,
    b.insured_name || 'Untitled Risk', b.insured_address || null, b.nature_of_business || null, b.fac_cob_id || null,
    dateOrNull(b.inception_date), dateOrNull(b.expiry_date), numOrNull(b.policy_period_months) || 12, numOrNull(b.uw_year),
    numOrNull(b.total_sum_insured), numOrNull(b.pd_sum_insured), numOrNull(b.bi_sum_insured),
    b.placement_type || 'PROPORTIONAL', numOrNull(b.cedant_retention_pct), numOrNull(b.ri_share_pct), numOrNull(b.our_share_pct),
    numOrNull(b.np_retention), numOrNull(b.np_limit), numOrNull(b.np_our_share_pct),
    numOrNull(b.deductible_amount), b.deductible_description || null,
    numOrNull(b.commission_pct), numOrNull(b.brokerage_pct), numOrNull(b.taxes_pct),
    numOrNull(b.original_premium), numOrNull(b.ri_premium), numOrNull(b.original_rate),
    numOrNull(b.pml_amount), numOrNull(b.pml_pct), numOrNull(b.mfl_amount), numOrNull(b.mfl_pct),
    b.created_by_user_id || null, b.assigned_to_user_id || null,
    b.linked_contract_id || null, b.underwriter_notes || null, b.status || 'DRAFT',
  ]);
  res.status(201).json(rows[0]);
}));

// UPDATE risk
router.put('/fac/risks/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const { rows } = await pool.query(`
    UPDATE public.fac_risk SET
      cedant_id = $2, broker_id = $3, country_id = $4, currency_id = $5,
      insured_name = $6, insured_address = $7, nature_of_business = $8, fac_cob_id = $9,
      inception_date = $10, expiry_date = $11, policy_period_months = $12, uw_year = $13,
      total_sum_insured = $14, pd_sum_insured = $15, bi_sum_insured = $16,
      placement_type = $17, cedant_retention_pct = $18, ri_share_pct = $19, our_share_pct = $20,
      np_retention = $21, np_limit = $22, np_our_share_pct = $23,
      deductible_amount = $24, deductible_description = $25,
      commission_pct = $26, brokerage_pct = $27, taxes_pct = $28,
      original_premium = $29, ri_premium = $30, original_rate = $31,
      pml_amount = $32, pml_pct = $33, mfl_amount = $34, mfl_pct = $35,
      assigned_to_user_id = $36,
      linked_contract_id = $37, underwriter_notes = $38, status = $39
    WHERE fac_risk_id = $1
    RETURNING *
  `, [
    id,
    b.cedant_id || null, b.broker_id || null, b.country_id || null, b.currency_id || null,
    b.insured_name, b.insured_address || null, b.nature_of_business || null, b.fac_cob_id || null,
    dateOrNull(b.inception_date), dateOrNull(b.expiry_date), numOrNull(b.policy_period_months) || 12, numOrNull(b.uw_year),
    numOrNull(b.total_sum_insured), numOrNull(b.pd_sum_insured), numOrNull(b.bi_sum_insured),
    b.placement_type || 'PROPORTIONAL', numOrNull(b.cedant_retention_pct), numOrNull(b.ri_share_pct), numOrNull(b.our_share_pct),
    numOrNull(b.np_retention), numOrNull(b.np_limit), numOrNull(b.np_our_share_pct),
    numOrNull(b.deductible_amount), b.deductible_description || null,
    numOrNull(b.commission_pct), numOrNull(b.brokerage_pct), numOrNull(b.taxes_pct),
    numOrNull(b.original_premium), numOrNull(b.ri_premium), numOrNull(b.original_rate),
    numOrNull(b.pml_amount), numOrNull(b.pml_pct), numOrNull(b.mfl_amount), numOrNull(b.mfl_pct),
    b.assigned_to_user_id || null,
    b.linked_contract_id || null, b.underwriter_notes || null, b.status || 'DRAFT',
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Risk not found' });
  res.json(rows[0]);
}));

// DELETE risk
router.delete('/fac/risks/:id', asyncHandler(async (req, res) => {
  await pool.query(`DELETE FROM public.fac_risk WHERE fac_risk_id = $1`, [req.params.id]);
  res.json({ deleted: true });
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC LOCATIONS — per-risk location SI breakdown
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/locations', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.fac_location WHERE fac_risk_id = $1 ORDER BY sort_order, created_at`,
    [req.params.id]
  );
  res.json(rows);
}));

router.put('/fac/risks/:id/locations', asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const locations = req.body.locations || [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM public.fac_location WHERE fac_risk_id = $1`, [riskId]);
    for (let i = 0; i < locations.length; i++) {
      const l = locations[i];
      await client.query(`
        INSERT INTO public.fac_location (fac_risk_id, location_name, address, latitude, longitude,
          cresta_zone, country_id, pd_si, bi_si, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `, [
        riskId, l.location_name || null, l.address || null,
        numOrNull(l.latitude), numOrNull(l.longitude),
        l.cresta_zone || null, l.country_id || null,
        numOrNull(l.pd_si), numOrNull(l.bi_si), i
      ]);
    }
    await client.query('COMMIT');
    const { rows } = await client.query(
      `SELECT * FROM public.fac_location WHERE fac_risk_id = $1 ORDER BY sort_order`, [riskId]
    );
    res.json(rows);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC COPE — Construction, Occupation, Protection, Exposure
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/cope', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.fac_cope WHERE fac_risk_id = $1`, [req.params.id]
  );
  res.json(rows[0] || null);
}));

router.put('/fac/risks/:id/cope', asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const b = req.body;
  const { rows } = await pool.query(`
    INSERT INTO public.fac_cope (fac_risk_id,
      construction_type, construction_year, fire_walls, fire_doors,
      spatial_separation_m, roof_material, wall_material, floors, total_area_sqm,
      occupation_description, process_description, hazard_grade, operating_hours,
      sprinkler_system, sprinkler_type, fire_alarm, fire_brigade_distance_km,
      extinguishers, hydrants, cctv, security_guards,
      natcat_earthquake, natcat_flood, natcat_windstorm, natcat_other, exposure_notes,
      survey_date, survey_provider, survey_rating
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
    ON CONFLICT (fac_risk_id) DO UPDATE SET
      construction_type = EXCLUDED.construction_type,
      construction_year = EXCLUDED.construction_year,
      fire_walls = EXCLUDED.fire_walls,
      fire_doors = EXCLUDED.fire_doors,
      spatial_separation_m = EXCLUDED.spatial_separation_m,
      roof_material = EXCLUDED.roof_material,
      wall_material = EXCLUDED.wall_material,
      floors = EXCLUDED.floors,
      total_area_sqm = EXCLUDED.total_area_sqm,
      occupation_description = EXCLUDED.occupation_description,
      process_description = EXCLUDED.process_description,
      hazard_grade = EXCLUDED.hazard_grade,
      operating_hours = EXCLUDED.operating_hours,
      sprinkler_system = EXCLUDED.sprinkler_system,
      sprinkler_type = EXCLUDED.sprinkler_type,
      fire_alarm = EXCLUDED.fire_alarm,
      fire_brigade_distance_km = EXCLUDED.fire_brigade_distance_km,
      extinguishers = EXCLUDED.extinguishers,
      hydrants = EXCLUDED.hydrants,
      cctv = EXCLUDED.cctv,
      security_guards = EXCLUDED.security_guards,
      natcat_earthquake = EXCLUDED.natcat_earthquake,
      natcat_flood = EXCLUDED.natcat_flood,
      natcat_windstorm = EXCLUDED.natcat_windstorm,
      natcat_other = EXCLUDED.natcat_other,
      exposure_notes = EXCLUDED.exposure_notes,
      survey_date = EXCLUDED.survey_date,
      survey_provider = EXCLUDED.survey_provider,
      survey_rating = EXCLUDED.survey_rating,
      updated_at = now()
    RETURNING *
  `, [
    riskId,
    b.construction_type || null, numOrNull(b.construction_year), b.fire_walls ?? false, b.fire_doors ?? false,
    numOrNull(b.spatial_separation_m), b.roof_material || null, b.wall_material || null, numOrNull(b.floors), numOrNull(b.total_area_sqm),
    b.occupation_description || null, b.process_description || null, b.hazard_grade || null, b.operating_hours || null,
    b.sprinkler_system ?? false, b.sprinkler_type || null, b.fire_alarm ?? false, numOrNull(b.fire_brigade_distance_km),
    b.extinguishers ?? true, b.hydrants ?? false, b.cctv ?? false, b.security_guards ?? false,
    b.natcat_earthquake ?? false, b.natcat_flood ?? false, b.natcat_windstorm ?? false, b.natcat_other || null, b.exposure_notes || null,
    dateOrNull(b.survey_date), b.survey_provider || null, b.survey_rating || null,
  ]);
  res.json(rows[0]);
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC LOSS HISTORY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/losses', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.fac_loss_history WHERE fac_risk_id = $1 ORDER BY loss_year DESC, loss_date DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.put('/fac/risks/:id/losses', asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const losses = req.body.losses || [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM public.fac_loss_history WHERE fac_risk_id = $1`, [riskId]);
    for (const l of losses) {
      await client.query(`
        INSERT INTO public.fac_loss_history (fac_risk_id, loss_year, loss_date, loss_description,
          cause_of_loss, fgu_paid, fgu_outstanding, ri_paid, ri_outstanding,
          mitigation_measures, is_open)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        riskId, numOrNull(l.loss_year), dateOrNull(l.loss_date), l.loss_description || null,
        l.cause_of_loss || null, numOrNull(l.fgu_paid), numOrNull(l.fgu_outstanding),
        numOrNull(l.ri_paid), numOrNull(l.ri_outstanding),
        l.mitigation_measures || null, l.is_open ?? true,
      ]);
    }
    await client.query('COMMIT');
    const { rows } = await client.query(
      `SELECT * FROM public.fac_loss_history WHERE fac_risk_id = $1 ORDER BY loss_year DESC`, [riskId]
    );
    res.json(rows);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC PRICING — dual engine save/load
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/pricing', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.fac_pricing WHERE fac_risk_id = $1`, [req.params.id]
  );
  res.json(rows[0] || null);
}));

router.put('/fac/risks/:id/pricing', asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const b = req.body;
  // ui_state is JSONB for UI-only data (selected extensions, custom extensions)
  // that doesn't warrant its own typed columns.
  const uiState = (b.ui_state && typeof b.ui_state === 'object') ? b.ui_state : {};
  const { rows } = await pool.query(`
    INSERT INTO public.fac_pricing (fac_risk_id,
      market_rate_per_mille, market_premium, market_source,
      actuarial_method, actuarial_rate_per_mille, actuarial_premium,
      expected_loss_ratio, loss_cost, loading_pct,
      market_weight_pct, actuarial_weight_pct,
      blended_rate_per_mille, blended_premium,
      final_rate_per_mille, final_premium, uw_adjustment_pct, uw_adjustment_reason,
      burning_cost_ratio, avg_loss_years, ui_state
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (fac_risk_id) DO UPDATE SET
      market_rate_per_mille = EXCLUDED.market_rate_per_mille,
      market_premium = EXCLUDED.market_premium,
      market_source = EXCLUDED.market_source,
      actuarial_method = EXCLUDED.actuarial_method,
      actuarial_rate_per_mille = EXCLUDED.actuarial_rate_per_mille,
      actuarial_premium = EXCLUDED.actuarial_premium,
      expected_loss_ratio = EXCLUDED.expected_loss_ratio,
      loss_cost = EXCLUDED.loss_cost,
      loading_pct = EXCLUDED.loading_pct,
      market_weight_pct = EXCLUDED.market_weight_pct,
      actuarial_weight_pct = EXCLUDED.actuarial_weight_pct,
      blended_rate_per_mille = EXCLUDED.blended_rate_per_mille,
      blended_premium = EXCLUDED.blended_premium,
      final_rate_per_mille = EXCLUDED.final_rate_per_mille,
      final_premium = EXCLUDED.final_premium,
      uw_adjustment_pct = EXCLUDED.uw_adjustment_pct,
      uw_adjustment_reason = EXCLUDED.uw_adjustment_reason,
      burning_cost_ratio = EXCLUDED.burning_cost_ratio,
      avg_loss_years = EXCLUDED.avg_loss_years,
      ui_state = EXCLUDED.ui_state,
      updated_at = now()
    RETURNING *
  `, [
    riskId,
    numOrNull(b.market_rate_per_mille), numOrNull(b.market_premium), b.market_source || null,
    b.actuarial_method || null, numOrNull(b.actuarial_rate_per_mille), numOrNull(b.actuarial_premium),
    numOrNull(b.expected_loss_ratio), numOrNull(b.loss_cost), numOrNull(b.loading_pct),
    numOrNull(b.market_weight_pct) ?? 50, numOrNull(b.actuarial_weight_pct) ?? 50,
    numOrNull(b.blended_rate_per_mille), numOrNull(b.blended_premium),
    numOrNull(b.final_rate_per_mille), numOrNull(b.final_premium),
    numOrNull(b.uw_adjustment_pct), b.uw_adjustment_reason || null,
    numOrNull(b.burning_cost_ratio), numOrNull(b.avg_loss_years) || 5,
    JSON.stringify(uiState),
  ]);
  res.json(rows[0]);
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/documents', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.fac_document WHERE fac_risk_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

router.post('/fac/risks/:id/documents', asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const b = req.body;
  const { rows } = await pool.query(`
    INSERT INTO public.fac_document (fac_risk_id, doc_type, file_name, file_path, file_size, mime_type, uploaded_by, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [riskId, b.doc_type || 'OTHER', b.file_name || null, b.file_path || null,
      numOrNull(b.file_size), b.mime_type || null, b.uploaded_by || null, b.notes || null]);
  res.status(201).json(rows[0]);
}));

router.delete('/fac/documents/:docId', asyncHandler(async (req, res) => {
  await pool.query(`DELETE FROM public.fac_document WHERE document_id = $1`, [req.params.docId]);
  res.json({ deleted: true });
}));


// ═══════════════════════════════════════════════════════════════════════════
// FAC KPIs — summary stats for the home screen
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/kpis', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total_risks,
      COUNT(*) FILTER (WHERE status = 'BOUND')::int AS bound,
      COUNT(*) FILTER (WHERE status = 'QUOTED')::int AS quoted,
      COUNT(*) FILTER (WHERE status IN ('DRAFT','REFERRED'))::int AS in_progress,
      COUNT(*) FILTER (WHERE status = 'DECLINED')::int AS declined,
      COALESCE(SUM(ri_premium) FILTER (WHERE status = 'BOUND'), 0)::numeric AS bound_premium,
      COALESCE(SUM(total_sum_insured) FILTER (WHERE status = 'BOUND'), 0)::numeric AS bound_si
    FROM public.fac_risk
  `);
  res.json(rows[0]);
}));


// ═══════════════════════════════════════════════════════════════════════════
// LINKED TREATIES — find treaties for the same cedant
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/linked-treaties', asyncHandler(async (req, res) => {
  // First get cedant_id from fac risk
  const { rows: riskRows } = await pool.query(
    `SELECT cedant_id FROM public.fac_risk WHERE fac_risk_id = $1`, [req.params.id]
  );
  if (!riskRows.length || !riskRows[0].cedant_id) return res.json([]);

  const { rows } = await pool.query(`
    SELECT c.contract_id, c.uw_year, c.status,
           co.company_name AS cedant_name,
           tt.treaty_type_name, tt.category
    FROM public.contract c
    LEFT JOIN public.companies co ON co.company_id = c.cedant_id
    LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
    WHERE c.cedant_id = $1
    ORDER BY c.uw_year DESC, c.created_at DESC
    LIMIT 20
  `, [riskRows[0].cedant_id]);
  res.json(rows);
}));


export default router;
