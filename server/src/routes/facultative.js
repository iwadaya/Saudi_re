// server/src/routes/facultative.js
// Facultative reinsurance module — CRUD for risks, locations, COPE,
// loss history, dual pricing, documents, market rates, and home listing.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler, numOrNull, dateOrNull } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import {
  facRiskSaveSchema,
  facLocationsSaveSchema,
  facPricingSaveSchema,
  facSubmitForApprovalSchema,
  facBindSchema,
} from '../validation/facultative.js';

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
router.post('/fac/risks', validateBody(facRiskSaveSchema), asyncHandler(async (req, res) => {
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
      linked_contract_id, underwriter_notes, status,
      cedant_region, renewal_or_new, expiring_reference, risk_country_zone,
      multi_location_flag, multi_occupancy_flag, risk_location_top_address,
      occupancy_code, occupancy_name, hazard_grade_override,
      hazard_category, risk_category, frequency_category
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
      $31,$32,$33,$34,$35,$36,$37,$38,$39,
      $40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52
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
    b.cedant_region || null, b.renewal_or_new || null, b.expiring_reference || null, b.risk_country_zone || null,
    b.multi_location_flag ?? false, b.multi_occupancy_flag ?? false, b.risk_location_top_address || null,
    numOrNull(b.occupancy_code), b.occupancy_name || null, numOrNull(b.hazard_grade_override),
    b.hazard_category || null, numOrNull(b.risk_category), numOrNull(b.frequency_category),
  ]);
  res.status(201).json(rows[0]);
}));

// UPDATE risk
router.put('/fac/risks/:id', validateBody(facRiskSaveSchema), asyncHandler(async (req, res) => {
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
      linked_contract_id = $37, underwriter_notes = $38, status = $39,
      cedant_region = $40, renewal_or_new = $41, expiring_reference = $42,
      risk_country_zone = $43, multi_location_flag = $44, multi_occupancy_flag = $45,
      risk_location_top_address = $46, occupancy_code = $47, occupancy_name = $48,
      hazard_grade_override = $49, hazard_category = $50, risk_category = $51,
      frequency_category = $52
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
    b.cedant_region || null, b.renewal_or_new || null, b.expiring_reference || null,
    b.risk_country_zone || null, b.multi_location_flag ?? false, b.multi_occupancy_flag ?? false,
    b.risk_location_top_address || null, numOrNull(b.occupancy_code), b.occupancy_name || null,
    numOrNull(b.hazard_grade_override), b.hazard_category || null, numOrNull(b.risk_category),
    numOrNull(b.frequency_category),
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

router.put('/fac/risks/:id/locations', validateBody(facLocationsSaveSchema), asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const locations = req.body.locations || [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM public.fac_location WHERE fac_risk_id = $1`, [riskId]);
    for (let i = 0; i < locations.length; i++) {
      const l = locations[i];
      await client.query(`
        INSERT INTO public.fac_location (
          fac_risk_id, location_name, address, latitude, longitude,
          cresta_zone, country_id, pd_si, bi_si, sort_order,
          occupancy_code, pd_pml_pct, bi_pml_pct,
          original_ccy, original_pd_si, original_bi_si, fx_to_sar,
          carrier_pd_share_pct, carrier_bi_share_pct
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      `, [
        riskId, l.location_name || null, l.address || null,
        numOrNull(l.latitude), numOrNull(l.longitude),
        l.cresta_zone || null, l.country_id || null,
        numOrNull(l.pd_si), numOrNull(l.bi_si), i,
        numOrNull(l.occupancy_code), numOrNull(l.pd_pml_pct), numOrNull(l.bi_pml_pct),
        l.original_ccy || null, numOrNull(l.original_pd_si), numOrNull(l.original_bi_si), numOrNull(l.fx_to_sar),
        numOrNull(l.carrier_pd_share_pct), numOrNull(l.carrier_bi_share_pct),
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

router.put('/fac/risks/:id/pricing', validateBody(facPricingSaveSchema), asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const b = req.body;
  // ui_state is JSONB for UI-only data (selected extensions, custom extensions)
  // that doesn't warrant its own typed columns.
  const uiState = (b.ui_state && typeof b.ui_state === 'object') ? b.ui_state : {};
  const extraLoadings = Array.isArray(b.extra_cover_loadings) ? b.extra_cover_loadings : [];
  const engineWarnings = Array.isArray(b.engine_warnings) ? b.engine_warnings : [];
  const { rows } = await pool.query(`
    INSERT INTO public.fac_pricing (fac_risk_id,
      market_rate_per_mille, market_premium, market_source,
      actuarial_method, actuarial_rate_per_mille, actuarial_premium,
      expected_loss_ratio, loss_cost, loading_pct,
      market_weight_pct, actuarial_weight_pct,
      blended_rate_per_mille, blended_premium,
      final_rate_per_mille, final_premium, uw_adjustment_pct, uw_adjustment_reason,
      burning_cost_ratio, avg_loss_years, ui_state,
      indemnity_months, commission_pct, margin_pct, other_expenses_pct,
      extra_cover_loadings, market_rate_pm,
      technical_rate_pm, total_rate_pm, bi_rate_pm, net_rate_pm,
      final_net_rate_pm, final_gross_rate_pm,
      technical_premium, expected_premium,
      underwriting_score, capacity_grade, uw_action,
      max_capacity_pct, max_capacity_sar,
      market_vs_tech_pct, market_vs_tech_band,
      engine_version, engine_warnings,
      capacity_proposed_pct, accepted_rate_pm, uw_note
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
      $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,
      $36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47)
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
      indemnity_months = EXCLUDED.indemnity_months,
      commission_pct = EXCLUDED.commission_pct,
      margin_pct = EXCLUDED.margin_pct,
      other_expenses_pct = EXCLUDED.other_expenses_pct,
      extra_cover_loadings = EXCLUDED.extra_cover_loadings,
      market_rate_pm = EXCLUDED.market_rate_pm,
      technical_rate_pm = EXCLUDED.technical_rate_pm,
      total_rate_pm = EXCLUDED.total_rate_pm,
      bi_rate_pm = EXCLUDED.bi_rate_pm,
      net_rate_pm = EXCLUDED.net_rate_pm,
      final_net_rate_pm = EXCLUDED.final_net_rate_pm,
      final_gross_rate_pm = EXCLUDED.final_gross_rate_pm,
      technical_premium = EXCLUDED.technical_premium,
      expected_premium = EXCLUDED.expected_premium,
      underwriting_score = EXCLUDED.underwriting_score,
      capacity_grade = EXCLUDED.capacity_grade,
      uw_action = EXCLUDED.uw_action,
      max_capacity_pct = EXCLUDED.max_capacity_pct,
      max_capacity_sar = EXCLUDED.max_capacity_sar,
      market_vs_tech_pct = EXCLUDED.market_vs_tech_pct,
      market_vs_tech_band = EXCLUDED.market_vs_tech_band,
      engine_version = EXCLUDED.engine_version,
      engine_warnings = EXCLUDED.engine_warnings,
      capacity_proposed_pct = EXCLUDED.capacity_proposed_pct,
      accepted_rate_pm = EXCLUDED.accepted_rate_pm,
      uw_note = EXCLUDED.uw_note,
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
    // Engine inputs
    numOrNull(b.indemnity_months), numOrNull(b.commission_pct),
    numOrNull(b.margin_pct), numOrNull(b.other_expenses_pct),
    JSON.stringify(extraLoadings), numOrNull(b.market_rate_pm),
    // Engine outputs — rate path
    numOrNull(b.technical_rate_pm), numOrNull(b.total_rate_pm),
    numOrNull(b.bi_rate_pm), numOrNull(b.net_rate_pm),
    numOrNull(b.final_net_rate_pm), numOrNull(b.final_gross_rate_pm),
    numOrNull(b.technical_premium), numOrNull(b.expected_premium),
    // Engine outputs — score + decision
    numOrNull(b.underwriting_score), b.capacity_grade || null, b.uw_action || null,
    numOrNull(b.max_capacity_pct), numOrNull(b.max_capacity_sar),
    numOrNull(b.market_vs_tech_pct), b.market_vs_tech_band || null,
    // Provenance
    b.engine_version || null, JSON.stringify(engineWarnings),
    // Summary-screen edits (migration 084)
    numOrNull(b.capacity_proposed_pct), numOrNull(b.accepted_rate_pm), b.uw_note || null,
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


// ═══════════════════════════════════════════════════════════════════════════
// UNDERWRITING FACTORS — per-risk selections (18-factor questionnaire)
//
// Selections are validated against the live reference set
// (fac_factor_master + fac_factor_option) rather than a static Zod enum:
// the master list is owned by the seed migration, not the route, and a
// stale enum here would silently reject newly-added factors. The check
// runs in the same handler so we only fetch the reference once per save.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/uw-factors', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT selections, notes, updated_at
       FROM public.fac_underwriting_factors
      WHERE fac_risk_id = $1`,
    [req.params.id],
  );
  if (!rows.length) return res.json({ selections: {}, notes: null, updated_at: null });
  res.json(rows[0]);
}));

router.post('/fac/risks/:id/uw-factors', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const raw = req.body || {};
  const selections = (raw.selections && typeof raw.selections === 'object' && !Array.isArray(raw.selections))
    ? raw.selections : null;
  if (!selections) {
    return res.status(400).json({
      error: 'Request body failed validation',
      code: 'VALIDATION_FAILED',
      fields: [{ path: 'selections', message: 'must be an object mapping factor_code → option_label', code: 'invalid_type' }],
    });
  }
  const notes = typeof raw.notes === 'string' ? raw.notes : null;

  // Pull every factor + its allowed options in a single query, then
  // validate each entry in `selections`. Any unknown factor or option
  // earns a 422 with the offending paths called out.
  const { rows: refRows } = await pool.query(`
    SELECT fm.factor_code, COALESCE(json_agg(fo.option_label) FILTER (WHERE fo.option_label IS NOT NULL), '[]') AS options
      FROM public.fac_factor_master fm
      LEFT JOIN public.fac_factor_option fo ON fo.factor_code = fm.factor_code
     GROUP BY fm.factor_code
  `);
  const allowedByFactor = new Map();
  for (const r of refRows) allowedByFactor.set(r.factor_code, new Set(r.options || []));

  const issues = [];
  for (const [code, label] of Object.entries(selections)) {
    if (!allowedByFactor.has(code)) {
      issues.push({ path: `selections.${code}`, message: `unknown factor_code "${code}"`, code: 'unknown_factor' });
      continue;
    }
    if (label == null || label === '') continue; // blank == "no selection"
    const allowed = allowedByFactor.get(code);
    if (allowed.size === 0) continue; // factors like HAZARD_GRADE have no factor_option rows
    if (!allowed.has(label)) {
      issues.push({
        path: `selections.${code}`,
        message: `option "${label}" is not a valid choice for factor ${code}`,
        code: 'unknown_option',
      });
    }
  }
  if (issues.length) {
    return res.status(422).json({
      error: 'Request body failed validation',
      code: 'VALIDATION_FAILED',
      fields: issues,
    });
  }

  // Confirm the risk exists before writing — keeps the response shape
  // honest if a stale UI saves against a deleted risk.
  const { rowCount: riskExists } = await pool.query(
    `SELECT 1 FROM public.fac_risk WHERE fac_risk_id = $1`, [id]
  );
  if (!riskExists) return res.status(404).json({ error: 'Risk not found' });

  const { rows } = await pool.query(`
    INSERT INTO public.fac_underwriting_factors (fac_risk_id, selections, notes)
    VALUES ($1, $2::jsonb, $3)
    ON CONFLICT (fac_risk_id) DO UPDATE
      SET selections = EXCLUDED.selections,
          notes      = EXCLUDED.notes
    RETURNING selections, notes, updated_at
  `, [id, JSON.stringify(selections), notes]);
  res.json(rows[0]);
}));


// ═══════════════════════════════════════════════════════════════════════════
// CLAUSES & EXCLUSIONS CHECKLIST — per-risk LM7 / ABI / LMA 3100 / etc.
//
// The master list lives in fac_clause_master; this set of endpoints just
// stores the underwriter's tick + free-text comment. GET left-joins the
// master so every clause appears even before the underwriter has touched
// the form, and POST bulk-upserts whatever the screen sends.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/clauses-checklist', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT cm.clause_code, cm.clause_name, cm.clause_category, cm.is_mandatory, cm.sort_order,
           COALESCE(cl.is_checked, false) AS is_checked,
           cl.comments,
           cl.updated_at
      FROM public.fac_clause_master cm
      LEFT JOIN public.fac_clauses_checklist cl
        ON cl.clause_code = cm.clause_code AND cl.fac_risk_id = $1
     ORDER BY cm.sort_order
  `, [req.params.id]);
  res.json({ items: rows });
}));

router.post('/fac/risks/:id/clauses-checklist', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) {
    return res.status(400).json({
      error: 'Request body failed validation',
      code: 'VALIDATION_FAILED',
      fields: [{ path: 'items', message: 'must be an array of { clause_code, is_checked, comments }', code: 'invalid_type' }],
    });
  }

  // Validate each clause_code against the master before any write so we
  // either persist the whole batch or reject it cleanly.
  const { rows: codeRows } = await pool.query(
    `SELECT clause_code FROM public.fac_clause_master`
  );
  const allowed = new Set(codeRows.map((r) => r.clause_code));
  const issues = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') {
      issues.push({ path: 'items', message: 'each item must be an object', code: 'invalid_type' });
      break;
    }
    if (!allowed.has(it.clause_code)) {
      issues.push({
        path: `items[${it.clause_code}]`,
        message: `unknown clause_code "${it.clause_code}"`,
        code: 'unknown_clause',
      });
    }
  }
  if (issues.length) {
    return res.status(422).json({
      error: 'Request body failed validation',
      code: 'VALIDATION_FAILED',
      fields: issues,
    });
  }

  // Confirm the risk exists — keeps the response shape honest if a stale
  // UI saves against a deleted risk.
  const { rowCount: riskExists } = await pool.query(
    `SELECT 1 FROM public.fac_risk WHERE fac_risk_id = $1`, [id]
  );
  if (!riskExists) return res.status(404).json({ error: 'Risk not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items) {
      await client.query(`
        INSERT INTO public.fac_clauses_checklist (fac_risk_id, clause_code, is_checked, comments)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (fac_risk_id, clause_code) DO UPDATE
          SET is_checked = EXCLUDED.is_checked,
              comments   = EXCLUDED.comments
      `, [id, it.clause_code, Boolean(it.is_checked), it.comments || null]);
    }
    await client.query('COMMIT');
    const { rows } = await client.query(`
      SELECT cm.clause_code, cm.clause_name, cm.clause_category, cm.is_mandatory, cm.sort_order,
             COALESCE(cl.is_checked, false) AS is_checked,
             cl.comments,
             cl.updated_at
        FROM public.fac_clause_master cm
        LEFT JOIN public.fac_clauses_checklist cl
          ON cl.clause_code = cm.clause_code AND cl.fac_risk_id = $1
       ORDER BY cm.sort_order
    `, [id]);
    res.json({ items: rows });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));


// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY & APPROVAL — submit / decline / bind
//
// The existing approvals service in services/approvals.js is built around
// contract_offer.contract_id (NOT NULL + FK), so we don't go through it
// here. The fac workflow keeps its approval state on fac_risk.status
// (the fac_status enum already includes DRAFT / QUOTED / REFERRED /
// BOUND / DECLINED) and writes "FAC_*" rows into contract_audit_event
// (no FK after migration 071) so the same audit-log machinery picks
// them up. A proper fac_approval table can be added later if the
// workflow grows peer / arbiter steps; right now status + audit is the
// whole state machine.
// ═══════════════════════════════════════════════════════════════════════════

function actorLabel(req) {
  const u = req.user || {};
  if (u.displayName) return u.displayName;
  if (u.userId) return u.userId;
  return req.headers['x-user-id'] || 'unknown';
}

router.get('/fac/risks/:id/audit-events', asyncHandler(async (req, res) => {
  // Surfaces the FAC_* rows the workflow endpoints write into
  // contract_audit_event. Used by the Summary screen to populate the
  // underwriter / senior signature slots.
  const { rows } = await pool.query(
    `SELECT event_id, event_type, actor, payload, created_at
       FROM public.contract_audit_event
      WHERE contract_id = $1
        AND event_type LIKE 'FAC\\_%' ESCAPE '\\'
      ORDER BY created_at DESC`,
    [req.params.id],
  );
  res.json({ events: rows });
}));

async function writeFacAuditEvent({ facRiskId, eventType, actor, payload }) {
  // contract_audit_event lost its FK in migration 071, so reusing it for
  // fac events avoids a brand-new audit table. event_type is prefixed
  // with FAC_ so downstream consumers can filter cleanly.
  await pool.query(
    `INSERT INTO public.contract_audit_event (contract_id, event_type, actor, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [facRiskId, eventType, actor || null, JSON.stringify(payload || {})],
  );
}

router.post(
  '/fac/risks/:id/submit-for-approval',
  validateBody(facSubmitForApprovalSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Risk must exist.
    const { rows: riskRows } = await pool.query(
      `SELECT fac_risk_id, status FROM public.fac_risk WHERE fac_risk_id = $1`,
      [id],
    );
    if (!riskRows.length) return res.status(404).json({ error: 'Risk not found' });

    // Pricing must exist with a non-null underwriting_score.
    const { rows: priceRows } = await pool.query(
      `SELECT underwriting_score, capacity_grade, final_gross_rate_pm
         FROM public.fac_pricing
        WHERE fac_risk_id = $1`,
      [id],
    );
    if (!priceRows.length || priceRows[0].underwriting_score == null) {
      return res.status(422).json({
        error: 'Pricing incomplete — underwriting_score must be computed before submission.',
        code: 'PRICING_INCOMPLETE',
      });
    }
    const grade = priceRows[0].capacity_grade || null;
    const senior = grade ? grade >= 'H' : false; // 'H','I','J','K' route to senior
    const nextStatus = senior ? 'REFERRED' : 'QUOTED';

    const actor = actorLabel(req);
    const { rows: updated } = await pool.query(
      `UPDATE public.fac_risk
          SET status = $2::public.fac_status,
              updated_at = now()
        WHERE fac_risk_id = $1
        RETURNING *`,
      [id, nextStatus],
    );
    await writeFacAuditEvent({
      facRiskId: id,
      eventType: 'FAC_SUBMITTED',
      actor,
      payload: {
        previous_status: riskRows[0].status,
        new_status: nextStatus,
        capacity_grade: grade,
        underwriting_score: priceRows[0].underwriting_score,
        comment: req.body?.comment || null,
        routed_to_senior: senior,
      },
    });
    res.json({
      risk: updated[0],
      status: nextStatus,
      capacity_grade: grade,
      routed_to_senior: senior,
    });
  }),
);

router.post(
  '/fac/risks/:id/decline',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    // Inline validation so we can return 422 (semantic) rather than 400
    // (malformed) for a missing/short reason — per the workflow spec.
    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 5) {
      return res.status(422).json({
        error: 'Request body failed validation',
        code: 'VALIDATION_FAILED',
        fields: [{ path: 'reason', message: 'reason must be at least 5 characters', code: 'too_small' }],
      });
    }

    const { rowCount: exists } = await pool.query(
      `SELECT 1 FROM public.fac_risk WHERE fac_risk_id = $1`, [id],
    );
    if (!exists) return res.status(404).json({ error: 'Risk not found' });

    const actor = actorLabel(req);
    const { rows: updated } = await pool.query(
      `UPDATE public.fac_risk
          SET status = 'DECLINED'::public.fac_status,
              decline_reason = $2,
              updated_at = now()
        WHERE fac_risk_id = $1
        RETURNING *`,
      [id, reason],
    );
    await writeFacAuditEvent({
      facRiskId: id,
      eventType: 'FAC_DECLINED',
      actor,
      payload: { reason },
    });
    res.json({ risk: updated[0], status: 'DECLINED' });
  }),
);

router.post(
  '/fac/risks/:id/bind',
  validateBody(facBindSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows: riskRows } = await pool.query(
      `SELECT fac_risk_id, status, bound_reference, uw_year, inception_date
         FROM public.fac_risk WHERE fac_risk_id = $1`,
      [id],
    );
    if (!riskRows.length) return res.status(404).json({ error: 'Risk not found' });

    // Only QUOTED / APPROVED risks may be bound. The fac_status enum
    // doesn't carry APPROVED, so we treat QUOTED as the only ready
    // state right now — when the workflow grows peer/arbiter steps a
    // dedicated APPROVED row will get added.
    const currentStatus = riskRows[0].status;
    if (currentStatus !== 'QUOTED') {
      return res.status(409).json({
        error: `Cannot bind from status "${currentStatus}". Risk must be QUOTED first.`,
        code: 'INVALID_STATE',
      });
    }

    // Generate FAC-YYYY-NNNNN. Year prefers explicit effective_date,
    // falls back to inception_date, then today.
    const effective = req.body?.effective_date || riskRows[0].inception_date;
    const year = effective
      ? new Date(effective).getFullYear()
      : (riskRows[0].uw_year || new Date().getFullYear());
    const { rows: seqRows } = await pool.query(
      `SELECT nextval('public.fac_bound_reference_seq') AS n`,
    );
    const padded = String(seqRows[0].n).padStart(5, '0');
    const boundReference = riskRows[0].bound_reference || `FAC-${year}-${padded}`;

    const actor = actorLabel(req);
    const { rows: updated } = await pool.query(
      `UPDATE public.fac_risk
          SET status = 'BOUND'::public.fac_status,
              bound_reference = COALESCE(bound_reference, $2),
              updated_at = now()
        WHERE fac_risk_id = $1
        RETURNING *`,
      [id, boundReference],
    );
    await writeFacAuditEvent({
      facRiskId: id,
      eventType: 'FAC_BOUND',
      actor,
      payload: { bound_reference: updated[0].bound_reference, effective_date: effective || null },
    });
    res.json({ risk: updated[0], status: 'BOUND', bound_reference: updated[0].bound_reference });
  }),
);


export default router;
