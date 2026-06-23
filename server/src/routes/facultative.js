// server/src/routes/facultative.js
// Facultative reinsurance module — CRUD for risks, locations, COPE,
// loss history, dual pricing, documents, market rates, and home listing.
import { Router } from 'express';
import multer from 'multer';
import fs, { promises as fsp } from 'fs';
import { pool } from '../db/pool.js';
import { asyncHandler, numOrNull, dateOrNull, assertExists } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../lib/parentEntityPersistence.js';
import {
  storeUploadedFile,
  deleteUploadedFile,
  isRemoteStoragePath,
  getSignedReadUrl,
  resolveLocalStoragePath,
} from '../lib/uploadStorage.js';
import { logger } from '../lib/logger.js';
import {
  facRiskSaveSchema,
  facLocationsSaveSchema,
  facPricingSaveSchema,
  facCopeSaveSchema,
  facLossesSaveSchema,
  facDocumentMetaSchema,
  facSubmitForApprovalSchema,
  facBindSchema,
  facTreatyLinkCreateSchema,
} from '../validation/facultative.js';
import { applyRecommendation } from '../lib/facRecommendationApply.js';
import { assertCanEdit, getEditPermission } from '../services/permissions.js';

const router = Router();

// Edit permission for the fac-risk editor lock (read-only; never 403s).
router.get('/fac/risks/:id/edit-permission', asyncHandler(async (req, res) => {
  res.json(await getEditPermission(req, 'FAC_RISK', req.params.id));
}));

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
    // Creator/owner come from the verified session, not the body (created_by is
    // not even in the schema). Default the assignee to the creator so the risk is
    // immediately editable by them — the edit-lock guard requires ownership, and
    // an unassigned risk would otherwise be read-only the moment it's created.
    req.user?.userId || null, b.assigned_to_user_id || req.user?.userId || null,
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
  await assertCanEdit(req, 'FAC_RISK', id);
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
    // Preserve ownership on a plain save: only the owner can reach this guarded
    // route, so default the assignee to them rather than NULLing it (which would
    // make the risk read-only and lock the owner out of their own next save).
    b.assigned_to_user_id || req.user?.userId || null,
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
    await assertExists(client, 'public.fac_risk', 'fac_risk_id', riskId, 'Risk');
    await assertParentEntityUnchanged(client, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
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
    await touchParentEntity(client, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId });
    await writeFacAuditEvent({ facRiskId: riskId, eventType: 'FAC_LOCATIONS_SAVED', actor: actorLabel(req), payload: { location_count: locations.length }, client });
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

router.put('/fac/risks/:id/cope', validateBody(facCopeSaveSchema), asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const b = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertExists(cl, 'public.fac_risk', 'fac_risk_id', riskId, 'Risk');
    await assertParentEntityUnchanged(cl, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    const { rows } = await cl.query(`
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
    await touchParentEntity(cl, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId });
    await writeFacAuditEvent({ facRiskId: riskId, eventType: 'FAC_COPE_SAVED', actor: actorLabel(req), payload: { survey_date: b.survey_date || null }, client: cl });
    await cl.query('COMMIT');
    res.json(rows[0]);
  } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
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

router.put('/fac/risks/:id/losses', validateBody(facLossesSaveSchema), asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const losses = req.body.losses || [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertExists(client, 'public.fac_risk', 'fac_risk_id', riskId, 'Risk');
    await assertParentEntityUnchanged(client, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
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
    await touchParentEntity(client, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId });
    await writeFacAuditEvent({ facRiskId: riskId, eventType: 'FAC_LOSSES_SAVED', actor: actorLabel(req), payload: { loss_count: losses.length }, client });
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
  await assertCanEdit(req, 'FAC_RISK', riskId);
  const b = req.body;
  // ui_state is JSONB for UI-only data (selected extensions, custom extensions)
  // that doesn't warrant its own typed columns.
  const uiState = (b.ui_state && typeof b.ui_state === 'object') ? b.ui_state : {};
  const extraLoadings = Array.isArray(b.extra_cover_loadings) ? b.extra_cover_loadings : [];
  const engineWarnings = Array.isArray(b.engine_warnings) ? b.engine_warnings : [];
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertExists(cl, 'public.fac_risk', 'fac_risk_id', riskId, 'Risk');
    await assertParentEntityUnchanged(cl, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    const { rows } = await cl.query(`
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
    await touchParentEntity(cl, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id: riskId });
    await writeFacAuditEvent({ facRiskId: riskId, eventType: 'FAC_PRICING_SAVED', actor: actorLabel(req), payload: { underwriting_score: numOrNull(b.underwriting_score), capacity_grade: b.capacity_grade || null }, client: cl });
    await cl.query('COMMIT');
    res.json(rows[0]);
  } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
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

router.post('/fac/risks/:id/documents', validateBody(facDocumentMetaSchema), asyncHandler(async (req, res) => {
  const riskId = req.params.id;
  const b = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertExists(cl, 'public.fac_risk', 'fac_risk_id', riskId, 'Risk');
    const { rows } = await cl.query(`
      INSERT INTO public.fac_document (fac_risk_id, doc_type, file_name, file_path, file_size, mime_type, uploaded_by, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [riskId, b.doc_type || 'OTHER', b.file_name || null, b.file_path || null,
        numOrNull(b.file_size), b.mime_type || null, b.uploaded_by || null, b.notes || null]);
    await writeFacAuditEvent({ facRiskId: riskId, eventType: 'FAC_DOCUMENT_ADDED', actor: actorLabel(req), payload: { document_id: rows[0].document_id, doc_type: rows[0].doc_type, file_name: rows[0].file_name }, client: cl });
    await cl.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
}));

router.delete('/fac/documents/:docId', asyncHandler(async (req, res) => {
  // Capture the storage location before the row goes, so we can clean up the
  // file afterwards (best-effort — the DB row is the source of truth).
  const { rows } = await pool.query(
    `DELETE FROM public.fac_document WHERE document_id = $1
       RETURNING storage_key, file_path`,
    [req.params.docId],
  );
  const sp = rows[0]?.storage_key || rows[0]?.file_path || '';
  if (sp) {
    deleteUploadedFile(sp).catch((err) => {
      logger.warn('[fac/doc/delete] storage cleanup failed', { storagePath: sp, error: err?.message });
    });
  }
  res.json({ deleted: true });
}));

// ── Multipart upload (the AI analyse flow reads the bytes back) ──
//
// The legacy JSON POST above only stores metadata. The AI runner
// needs real bytes, so we add a separate route that accepts a
// multipart 'file' field + document_kind. 20MB cap matches the
// client-side guard; storage strategy lives in lib/uploadStorage.js.
const _facDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.post(
  '/fac/risks/:id/documents/upload',
  _facDocUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const riskId = req.params.id;
    const kind = req.body?.document_kind || 'OTHER';
    // Treaty-style metadata captured on the upload form. doc_type tracks the
    // AI document_kind unless the form sends an explicit override.
    const docType = req.body?.doc_type || kind;
    const title = req.body?.title || null;
    const description = req.body?.description || null;

    let storageKey;
    try {
      storageKey = await storeUploadedFile({ folder: `fac/${riskId}`, file });
    } catch (e) {
      return res.status(502).json({ error: `Upload storage failed: ${e?.message || e}` });
    }

    const { rows } = await pool.query(`
      INSERT INTO public.fac_document
        (fac_risk_id, doc_type, document_kind, file_name, file_path,
         storage_key, file_size, byte_size, mime_type, title, description,
         uploaded_at, uploaded_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12)
      RETURNING *
    `, [
      riskId, docType, kind,
      file.originalname, storageKey, storageKey,
      file.size, file.size, file.mimetype || null,
      title, description,
      actorUserUuid(req),
    ]);
    res.status(201).json(rows[0]);
  }),
);

// ── File view / download ──
// Mirrors the treaty document serve path (treatyData.js serveDoc): mints a
// short-lived signed URL for remote (Cloudinary) assets, streams local-disk
// files directly. `view` serves inline; `download` keeps the same inline
// disposition so the browser can preview PDFs/images in a new tab.
async function serveFacDoc(req, res) {
  const { rows } = await pool.query(
    `SELECT file_name, mime_type, byte_size, file_size, storage_key, file_path
       FROM public.fac_document WHERE document_id = $1`,
    [req.params.docId],
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const sp = doc.storage_key || doc.file_path || '';
  if (!sp) return res.status(404).json({ error: 'Document has no stored file' });

  if (isRemoteStoragePath(sp)) {
    const signedUrl = await getSignedReadUrl(sp);
    if (!signedUrl) return res.status(502).json({ error: 'Document storage temporarily unavailable' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.redirect(signedUrl);
  }
  const fp = resolveLocalStoragePath(sp);
  let stat;
  try {
    stat = await fsp.stat(fp);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found on disk' });
    throw err;
  }
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.file_name || 'document')}"`);
  res.setHeader('Content-Length', doc.byte_size || doc.file_size || stat.size);
  fs.createReadStream(fp).pipe(res);
}

router.get('/fac/documents/:docId/view',     asyncHandler((req, res) => serveFacDoc(req, res)));
router.get('/fac/documents/:docId/download',  asyncHandler((req, res) => serveFacDoc(req, res)));


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
           tt.treaty_type AS treaty_type_name, tt.category
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

  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertParentEntityUnchanged(cl, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    const { rows } = await cl.query(`
      INSERT INTO public.fac_underwriting_factors (fac_risk_id, selections, notes)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (fac_risk_id) DO UPDATE
        SET selections = EXCLUDED.selections,
            notes      = EXCLUDED.notes
      RETURNING selections, notes, updated_at
    `, [id, JSON.stringify(selections), notes]);
    await touchParentEntity(cl, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id });
    await writeFacAuditEvent({ facRiskId: id, eventType: 'FAC_UW_FACTORS_SAVED', actor: actorLabel(req), payload: { factor_count: Object.keys(selections).length }, client: cl });
    await cl.query('COMMIT');
    res.json(rows[0]);
  } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; } finally { cl.release(); }
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
    await assertParentEntityUnchanged(client, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    for (const it of items) {
      await client.query(`
        INSERT INTO public.fac_clauses_checklist (fac_risk_id, clause_code, is_checked, comments)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (fac_risk_id, clause_code) DO UPDATE
          SET is_checked = EXCLUDED.is_checked,
              comments   = EXCLUDED.comments
      `, [id, it.clause_code, Boolean(it.is_checked), it.comments || null]);
    }
    await touchParentEntity(client, { parentTable: 'fac_risk', idColumn: 'fac_risk_id', id });
    await writeFacAuditEvent({ facRiskId: id, eventType: 'FAC_CLAUSES_SAVED', actor: actorLabel(req), payload: { item_count: items.length }, client });
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
  return 'unknown';
}

// req.user.userId comes from the x-user-id header which may carry a
// free-form login slug in dev (e.g. "test-user") rather than a UUID.
// Only forward it to columns typed as uuid when it parses as one;
// otherwise persist NULL.
const _UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function actorUserUuid(req) {
  const id = req.user?.userId || null;
  return id && _UUID_RE.test(id) ? id : null;
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

async function writeFacAuditEvent({ facRiskId, eventType, actor, payload, client }) {
  // contract_audit_event lost its FK in migration 071, so reusing it for
  // fac events avoids a brand-new audit table. event_type is prefixed
  // with FAC_ so downstream consumers can filter cleanly.
  //
  // Pass `client` to write the audit on the SAME transaction as the mutation
  // it records (so a rolled-back save leaves no phantom event); omit it for the
  // single-statement status routes that run on the pool.
  await (client || pool).query(
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

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT AI — accept / reject recommendations
//
// Accept runs the apply-dispatch (see lib/facRecommendationApply.js)
// inside a transaction that also marks the recommendation ACCEPTED,
// supersedes other PENDING recs on the same field, and writes a
// FAC_AI_ACCEPTED audit row. Reject is pure status / audit; no data
// change.
// ═══════════════════════════════════════════════════════════════════════════

router.post('/fac/recommendation/:recId/accept', asyncHandler(async (req, res) => {
  const { recId } = req.params;
  const override = req.body?.override_value;

  // Load the recommendation up-front so we know the risk / field even
  // if the apply step needs a different table.
  const { rows: recRows } = await pool.query(
    `SELECT * FROM public.fac_ai_recommendation WHERE recommendation_id = $1`,
    [recId],
  );
  if (!recRows.length) return res.status(404).json({ error: 'Recommendation not found' });
  const rec = recRows[0];
  if (rec.status !== 'PENDING') {
    return res.status(409).json({
      error: `Recommendation is ${rec.status}; only PENDING recommendations can be accepted.`,
      code: 'INVALID_STATE',
    });
  }
  const value = override !== undefined ? override : rec.suggested_value;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let applyResult;
    try {
      applyResult = await applyRecommendation({
        client, riskId: rec.fac_risk_id, targetField: rec.target_field, value,
      });
    } catch (applyErr) {
      await client.query('ROLLBACK');
      // Surface a 400 for "unknown target_field" — anything else escalates.
      if (applyErr.status === 400) {
        return res.status(400).json({ error: applyErr.message, code: 'UNKNOWN_TARGET_FIELD' });
      }
      throw applyErr;
    }

    // Update the accepted rec.
    await client.query(
      `UPDATE public.fac_ai_recommendation
          SET status='ACCEPTED',
              acted_at = now(),
              acted_by_user_id = $2
        WHERE recommendation_id = $1`,
      [recId, actorUserUuid(req)],
    );
    // Supersede every other PENDING rec targeting the same field on
    // the same risk — accepting one effectively answers the others.
    await client.query(
      `UPDATE public.fac_ai_recommendation
          SET status='SUPERSEDED', acted_at = now()
        WHERE fac_risk_id = $1
          AND target_field = $2
          AND status = 'PENDING'
          AND recommendation_id <> $3`,
      [rec.fac_risk_id, rec.target_field, recId],
    );
    // Audit row — same contract_audit_event table used by the
    // submit/decline/bind flow.
    await client.query(
      `INSERT INTO public.contract_audit_event (contract_id, event_type, actor, payload)
       VALUES ($1, 'FAC_AI_ACCEPTED', $2, $3::jsonb)`,
      [rec.fac_risk_id, actorLabel(req), JSON.stringify({
        recommendation_id: recId,
        target_field: rec.target_field,
        before: applyResult?.beforeValue ?? null,
        after:  applyResult?.afterValue ?? null,
        no_op:  Boolean(applyResult?.noOp),
      })],
    );
    await client.query('COMMIT');
    res.json({
      recommendation_id: recId,
      status: 'ACCEPTED',
      target_field: rec.target_field,
      before: applyResult?.beforeValue ?? null,
      after:  applyResult?.afterValue ?? null,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}));

router.post('/fac/recommendation/:recId/reject', asyncHandler(async (req, res) => {
  const { recId } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
  const { rows } = await pool.query(
    `UPDATE public.fac_ai_recommendation
        SET status='REJECTED',
            acted_at = now(),
            acted_by_user_id = $2
      WHERE recommendation_id = $1 AND status = 'PENDING'
      RETURNING *`,
    [recId, actorUserUuid(req)],
  );
  if (!rows.length) {
    const { rows: existing } = await pool.query(
      `SELECT status FROM public.fac_ai_recommendation WHERE recommendation_id = $1`, [recId],
    );
    if (!existing.length) return res.status(404).json({ error: 'Recommendation not found' });
    return res.status(409).json({
      error: `Recommendation is ${existing[0].status}; only PENDING recommendations can be rejected.`,
      code: 'INVALID_STATE',
    });
  }
  await pool.query(
    `INSERT INTO public.contract_audit_event (contract_id, event_type, actor, payload)
     VALUES ($1, 'FAC_AI_REJECTED', $2, $3::jsonb)`,
    [rows[0].fac_risk_id, actorLabel(req), JSON.stringify({
      recommendation_id: recId, target_field: rows[0].target_field, reason,
    })],
  );
  res.json({ recommendation_id: recId, status: 'REJECTED' });
}));


// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT AI — list + detail
//
// Tenancy: this codebase doesn't model tenants — every authenticated
// user has access to every fac_risk. The 403 path below covers the
// shape needed once a tenant scope is added; for now it never fires.
// ═══════════════════════════════════════════════════════════════════════════

router.get('/fac/risks/:id/analyses', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.analysis_id,
           a.document_id,
           d.file_name           AS document_filename,
           a.analysis_kind       AS document_kind,
           a.status,
           a.summary,
           a.created_at,
           (SELECT count(*)::int FROM public.fac_ai_recommendation r
              WHERE r.analysis_id = a.analysis_id)                       AS recommendation_count,
           (SELECT count(*)::int FROM public.fac_ai_recommendation r
              WHERE r.analysis_id = a.analysis_id AND r.status = 'PENDING') AS pending_count
      FROM public.fac_document_analysis a
      LEFT JOIN public.fac_document d ON d.document_id = a.document_id
     WHERE a.fac_risk_id = $1
     ORDER BY a.created_at DESC
  `, [req.params.id]);
  res.json({ analyses: rows });
}));

router.get('/fac/analysis/:analysisId', asyncHandler(async (req, res) => {
  const { analysisId } = req.params;
  const { rows: aRows } = await pool.query(`
    SELECT a.*, d.file_name AS document_filename
      FROM public.fac_document_analysis a
      LEFT JOIN public.fac_document d ON d.document_id = a.document_id
     WHERE a.analysis_id = $1
  `, [analysisId]);
  if (!aRows.length) return res.status(404).json({ error: 'Analysis not found' });

  // Hook for future tenant isolation. The current auth model gives
  // every authenticated user access — so this 403 path is dead code
  // right now but keeps the response shape stable for later.
  // if (!userCanAccessRisk(req.user, aRows[0].fac_risk_id))
  //   return res.status(403).json({ error: 'Forbidden' });

  const { rows: rRows } = await pool.query(`
    SELECT *
      FROM public.fac_ai_recommendation
     WHERE analysis_id = $1
     ORDER BY (status = 'PENDING') DESC, created_at DESC
  `, [analysisId]);

  res.json({ analysis: aRows[0], recommendations: rRows });
}));


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


// ═══════════════════════════════════════════════════════════════════════════
// TREATY LINKING — fac_treaty_link + eligibility
//
// Eligibility query: same-cedant treaties whose COB overlaps with the
// fac risk (via fac_to_treaty_cob_map), are in an active status, and
// whose policy window contains the fac inception date ±30 days. The
// 30-day padding lets treaties whose effective date is close to the
// fac inception still appear; without it, a treaty inception of
// 1 Jan 2026 vs fac inception 28 Dec 2025 would silently drop.
// ═══════════════════════════════════════════════════════════════════════════

const _LINKABLE_CONTRACT_STATUSES = ['BOUND', 'SIGNED', 'RENEWED'];

router.get('/fac/risks/:id/eligible-treaties', asyncHandler(async (req, res) => {
  const riskId = req.params.id;

  // Pull the fac risk's cedant + COB + inception once; we'll reuse for
  // the eligibility filter and the 30-day window. We also fetch the
  // mapped class_of_business_id — if no map exists yet the eligible
  // list is empty, which is correct.
  const { rows: riskRows } = await pool.query(`
    SELECT r.cedant_id, r.inception_date, r.fac_cob_id,
           m.class_of_business_id
      FROM public.fac_risk r
      LEFT JOIN public.fac_to_treaty_cob_map m ON m.fac_cob_id = r.fac_cob_id
     WHERE r.fac_risk_id = $1
  `, [riskId]);
  if (!riskRows.length) return res.status(404).json({ error: 'Risk not found' });
  const r = riskRows[0];
  if (!r.cedant_id || !r.class_of_business_id) return res.json({ treaties: [] });

  // policy_inception defaults to the risk's inception_date; if blank,
  // we centre on today so the screen still surfaces eligible treaties
  // for an in-flight quote.
  const inception = r.inception_date || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(`
    SELECT c.contract_id,
           c.uw_year, c.status, c.inception_date, c.renewal_date,
           tt.treaty_type AS treaty_type_name,
           co.company_name AS cedant_name,
           (
             SELECT json_agg(cob.class_of_business)
               FROM public.contract_class_of_business ccob
               JOIN public.class_of_business cob
                 ON cob.class_of_business_id = ccob.class_of_business_id
              WHERE ccob.contract_id = c.contract_id
           ) AS classes_of_business
      FROM public.contract c
      LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN public.companies co   ON co.company_id     = c.cedant_id
     WHERE c.cedant_id = $1
       AND c.status::text = ANY($2)
       AND EXISTS (
         SELECT 1 FROM public.contract_class_of_business ccob
          WHERE ccob.contract_id = c.contract_id
            AND ccob.class_of_business_id = $3
       )
       AND ($4::date BETWEEN COALESCE(c.inception_date, '-infinity') - INTERVAL '30 days'
                          AND COALESCE(c.renewal_date,   'infinity')  + INTERVAL '30 days')
     ORDER BY c.inception_date DESC NULLS LAST
  `, [r.cedant_id, _LINKABLE_CONTRACT_STATUSES, r.class_of_business_id, inception]);

  // Compose a human-readable label the UI can drop straight into a
  // dropdown. Falls back gracefully if any sub-piece is missing.
  const treaties = rows.map((c) => ({
    contract_id:        c.contract_id,
    label:              [
      c.cedant_name || '—',
      c.uw_year || '',
      c.treaty_type_name || 'Treaty',
    ].filter(Boolean).join(' · ').trim(),
    status:             c.status,
    inception_date:     c.inception_date,
    renewal_date:       c.renewal_date,
    treaty_type:        c.treaty_type_name,
    classes_of_business: c.classes_of_business || [],
    uw_year:            c.uw_year,
  }));
  res.json({ treaties });
}));

// Reuse for both /eligible-treaties and the POST validator below so
// the eligibility rule lives in exactly one place.
async function isContractEligibleForFacRisk(riskId, contractId) {
  const { rows: riskRows } = await pool.query(`
    SELECT r.cedant_id, r.inception_date, m.class_of_business_id
      FROM public.fac_risk r
      LEFT JOIN public.fac_to_treaty_cob_map m ON m.fac_cob_id = r.fac_cob_id
     WHERE r.fac_risk_id = $1
  `, [riskId]);
  if (!riskRows.length) return { ok: false, reason: 'risk_not_found' };
  const r = riskRows[0];
  if (!r.cedant_id || !r.class_of_business_id) {
    return { ok: false, reason: 'risk_missing_cedant_or_cob' };
  }
  const inception = r.inception_date || new Date().toISOString().slice(0, 10);
  const { rowCount } = await pool.query(`
    SELECT 1
      FROM public.contract c
     WHERE c.contract_id = $1
       AND c.cedant_id = $2
       AND c.status::text = ANY($3)
       AND EXISTS (
         SELECT 1 FROM public.contract_class_of_business ccob
          WHERE ccob.contract_id = c.contract_id
            AND ccob.class_of_business_id = $4
       )
       AND ($5::date BETWEEN COALESCE(c.inception_date, '-infinity') - INTERVAL '30 days'
                          AND COALESCE(c.renewal_date,   'infinity')  + INTERVAL '30 days')
  `, [contractId, r.cedant_id, _LINKABLE_CONTRACT_STATUSES, r.class_of_business_id, inception]);
  return { ok: rowCount > 0, reason: rowCount > 0 ? null : 'not_eligible' };
}

router.get('/fac/risks/:id/treaty-links', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT l.link_id, l.contract_id, l.link_type, l.capacity_used,
           l.notes, l.created_at,
           c.uw_year, c.status::text AS contract_status,
           tt.treaty_type AS treaty_type_name,
           co.company_name AS cedant_name
      FROM public.fac_treaty_link l
      JOIN public.contract c       ON c.contract_id = l.contract_id
      LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN public.companies   co ON co.company_id     = c.cedant_id
     WHERE l.fac_risk_id = $1
     ORDER BY l.created_at DESC
  `, [req.params.id]);
  const links = rows.map((row) => ({
    link_id:        row.link_id,
    contract_id:    row.contract_id,
    contract_label: [row.cedant_name || '—', row.uw_year || '', row.treaty_type_name || 'Treaty']
                      .filter(Boolean).join(' · ').trim(),
    contract_status: row.contract_status,
    link_type:      row.link_type,
    capacity_used:  row.capacity_used,
    notes:          row.notes,
    created_at:     row.created_at,
  }));
  res.json({ links });
}));

router.post(
  '/fac/risks/:id/treaty-links',
  validateBody(facTreatyLinkCreateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { contract_id, link_type, capacity_used, notes } = req.body;

    const eligibility = await isContractEligibleForFacRisk(id, contract_id);
    if (!eligibility.ok) {
      return res.status(422).json({
        error: 'Contract is not eligible for this fac risk.',
        code: 'NOT_ELIGIBLE',
        reason: eligibility.reason,
      });
    }

    try {
      const { rows } = await pool.query(`
        INSERT INTO public.fac_treaty_link
          (fac_risk_id, contract_id, link_type, capacity_used, notes, created_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [id, contract_id, link_type, capacity_used ?? null, notes || null, actorUserUuid(req)]);
      return res.status(201).json(rows[0]);
    } catch (e) {
      // Surface the UNIQUE (fac_risk_id, contract_id) violation as a
      // 409 with a clean error code so the client can show a friendly
      // toast instead of a generic 500.
      if (e?.code === '23505') {
        return res.status(409).json({
          error: 'This treaty is already linked to the risk.',
          code: 'DUPLICATE_LINK',
        });
      }
      throw e;
    }
  }),
);

router.delete('/fac/risks/:id/treaty-links/:linkId', asyncHandler(async (req, res) => {
  const { id, linkId } = req.params;
  const { rowCount } = await pool.query(
    `DELETE FROM public.fac_treaty_link WHERE link_id = $1 AND fac_risk_id = $2`,
    [linkId, id],
  );
  if (!rowCount) return res.status(404).json({ error: 'Link not found' });
  res.json({ deleted: true });
}));


export default router;
