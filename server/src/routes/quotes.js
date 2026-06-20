// server/src/routes/quotes.js — Quote CRUD + sub-entities, using quote_* tables
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, numOrNull, dateOrNull, boolOrDefault, safeUwYear, preserveBool, preserveNum, assertExists, isStaleSince } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { getTriangleBounds, filterTriangleCells, normalizeTriangleRequest } from '../lib/triangleBounds.js';
import { stripTriangleCells, stripFieldForType, summarizeLossPlacement, combineIncurredCells } from '../lib/triangleStripping.js';
import { suggestLossQuarters } from '../lib/lossQuarterMapper.js';
import { logAudit, resolveAuditActor } from '../services/audit.js';
import { actorFromReq } from '../middleware/requestContext.js';
import { contractContextJoins } from '../db/contractJoins.js';
import { assertEntityUnchanged, optimisticLockOverrideRequested } from '../db/optimisticLock.js';
import { buildBatchInsert } from '../db/batchInsert.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../lib/parentEntityPersistence.js';
import { validateBody } from '../lib/validate.js';
import {
  quotePutBodySchema, stripLargeCatSchema, lossesSaveSchema, cobsSaveSchema,
  riskProfileSaveSchema, claimsProfileSaveSchema, pricingOutputsSchema, pricingYearlySchema,
} from '../validation/quote.js';
import { auditMutation } from '../lib/mutationAudit.js';
import { saveCrestaSlice } from '../lib/crestaSave.js';
import { storeUploadedFile } from '../lib/uploadStorage.js';
import { crestaSaveSchema } from '../validation/cresta.js';
import { assertCanEdit } from '../services/permissions.js';
import { approveQuote, returnToUnderwriter, recallOffer, markNotTakenUp } from '../services/approvals.js';
import { declineQuoteAction, submitQuoteForApprovalAction } from '../services/quoteWorkflow.js';
import { triangleCellsSchema, devFactorPutSchema, triangleTypeSchema } from '../validation/triangle.js';
import { verifyNpPricingOutputs, summariseDrifts, isStrictMode, pricingDriftStats } from '../lib/pricingVerifier.js';
import { getWordingChecklist, runWordingChecklistAi, saveWordingChecklist } from '../services/wordingChecklist.js';
import { loadQuoteCategory, requireQuoteCategory } from '../lib/treatyCategoryGuard.js';
import multer from 'multer';
import { randomUUID } from 'node:crypto';

const router = Router();
// Category fence for the NP-only quote routes: a proportional quote has no
// quote_np_* rows, so reject (409) rather than silently returning empties.
const npQuoteGuard = [loadQuoteCategory, requireQuoteCategory('NON_PROPORTIONAL')];

// Triangle variant (migration 116). Reads/writes default to MODIFIED so all
// pre-variant behaviour is unchanged unless ACTUAL is explicitly requested.
// Returns null for an explicitly-invalid value so the caller can 400.
const TRIANGLE_VARIANTS = new Set(['ACTUAL', 'MODIFIED']);
function resolveVariant(raw) {
  if (raw == null || raw === '') return 'MODIFIED';
  const v = String(raw).toUpperCase();
  return TRIANGLE_VARIANTS.has(v) ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function json(v) {
  return JSON.stringify(v ?? null);
}

function pctNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function layerValue(layer, keys) {
  for (const key of keys) {
    const value = layer?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normaliseFinalLayerForSnapshot(layer) {
  const l = layer || {};
  return {
    id: l.id ?? null,
    limit: l.limit ?? l.layer_limit ?? null,
    attachment: l.attachment ?? l.deductible ?? null,
    egnpi: l.egnpi ?? null,
    earnedPremium: l.earnedPremium ?? l.earned_premium ?? null,
    rate: l.rate ?? null,
    rol: l.rol ?? l.totalRol ?? null,
    risk: !!l.risk,
    cat: !!l.cat,
    pureBurn: l.pureBurn ?? null,
    pareto: l.pareto ?? null,
    exposure: l.exposure ?? null,
    wtBurn: l.wtBurn ?? null,
    wtPareto: l.wtPareto ?? null,
    loading: l.loading ?? null,
    uwPrice: l.uwPrice ?? null,
    pAttach: l.pAttach ?? null,
    pExhaust: l.pExhaust ?? null,
    riskPureBurn: l.riskPureBurn ?? null,
    riskPareto: l.riskPareto ?? null,
    riskExposure: l.riskExposure ?? null,
    riskUwPrice: l.riskUwPrice ?? null,
    catPureBurn: l.catPureBurn ?? null,
    catPareto: l.catPareto ?? null,
    catExposure: l.catExposure ?? null,
    catUwPrice: l.catUwPrice ?? null,
  };
}

function normaliseFinalPricingSnapshot(npFinalPricing = {}) {
  const scaffold = npFinalPricing?.fqScaffolding && typeof npFinalPricing.fqScaffolding === 'object'
    ? npFinalPricing.fqScaffolding
    : {};
  const clientStructures = arr(scaffold.clientStructures?.length ? scaffold.clientStructures : npFinalPricing.quoteStructures);
  return {
    layers: arr(npFinalPricing.layers).map(normaliseFinalLayerForSnapshot),
    treatyMetrics: npFinalPricing.treatyMetrics || null,
    leadSetup: arr(npFinalPricing.leadSetup),
    layerWrittenLines: npFinalPricing.layerWrittenLines || null,
    signedLinePcts: npFinalPricing.signedLinePcts || null,
    approvedStructures: arr(scaffold.approvedStructures?.length ? scaffold.approvedStructures : npFinalPricing.approvedStructures).map(Boolean),
    quotePricing: npFinalPricing.quotePricing || null,
    clientStructures: clientStructures.map((structure, idx) => ({
      id: structure?.id || `structure-${idx + 1}`,
      label: structure?.label || null,
      layers: arr(structure?.layers).map(normaliseFinalLayerForSnapshot),
    })),
    quoteCobUwLimits: scaffold.quoteCobUwLimits || {},
    cobToggles: scaffold.cobToggles || {},
    cobManual: scaffold.cobManual || {},
    expProbabilities: arr(scaffold.expProbabilities).map((row) => ({
      pAttach: row?.pAttach ?? null,
      pExhaust: row?.pExhaust ?? null,
    })),
  };
}

function changedSnapshotKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => json(before?.[key]) !== json(after?.[key]));
}

async function loadQuoteFinalWorkflowState(db, quoteId) {
  try {
    const [structureR, layerR, cobR, probabilityR] = await Promise.all([
      db.query(
        `SELECT structure_no, structure_key, structure_label, selected_for_approval,
                quote_type, lead_line_pct, follow_line_pct, raw_structure
           FROM public.quote_np_final_structure
          WHERE quote_id=$1
          ORDER BY structure_no`,
        [quoteId],
      ),
      db.query(
        `SELECT *
           FROM public.quote_np_final_structure_layer
          WHERE quote_id=$1
          ORDER BY structure_no, layer_number`,
        [quoteId],
      ),
      db.query(
        `SELECT structure_no, scope_key, class_of_business_id, limit_amount, layer_flags, manual_flags
           FROM public.quote_np_final_structure_cob
          WHERE quote_id=$1
          ORDER BY structure_no, scope_key, class_of_business_id`,
        [quoteId],
      ),
      db.query(
        `SELECT layer_number, prob_attach_pct, prob_exhaust_pct, raw_layer
           FROM public.quote_np_final_expiring_probability
          WHERE quote_id=$1
          ORDER BY layer_number`,
        [quoteId],
      ),
    ]);

    if (!structureR.rows.length && !cobR.rows.length && !probabilityR.rows.length) return null;

    const layersByStructure = new Map();
    for (const row of layerR.rows) {
      const raw = row.raw_layer && typeof row.raw_layer === 'object' ? row.raw_layer : {};
      const layer = {
        ...raw,
        id: raw.id || row.layer_key || `s${row.structure_no}-l${row.layer_number}`,
        limit: raw.limit ?? row.layer_limit ?? '',
        attachment: raw.attachment ?? raw.deductible ?? row.attachment ?? '',
        egnpi: raw.egnpi ?? row.egnpi ?? '',
        earnedPremium: raw.earnedPremium ?? row.earned_premium ?? '',
        rate: raw.rate ?? row.rate ?? '',
        rol: raw.rol ?? row.rol ?? '',
        risk: raw.risk ?? row.risk,
        cat: raw.cat ?? row.cat,
        pureBurn: raw.pureBurn ?? row.pure_burn_pct ?? '',
        pareto: raw.pareto ?? row.pareto_pct ?? '',
        exposure: raw.exposure ?? row.exposure_pct ?? '',
        wtBurn: raw.wtBurn ?? row.burn_weight_pct ?? '',
        wtPareto: raw.wtPareto ?? row.pareto_weight_pct ?? '',
        loading: raw.loading ?? row.loading_pct ?? '',
        uwPrice: raw.uwPrice ?? row.uw_price_pct ?? '',
        pAttach: raw.pAttach ?? row.risk_prob_attach_pct ?? row.cat_prob_attach_pct ?? '',
        pExhaust: raw.pExhaust ?? row.risk_prob_exhaust_pct ?? row.cat_prob_exhaust_pct ?? '',
        // MDP round-trips through raw_layer (saved as json(layer)); this table has
        // no dedicated mdp columns, so surface them explicitly from the JSONB.
        mdp: raw.mdp ?? '',
        mdpPct: raw.mdpPct ?? '',
      };
      const list = layersByStructure.get(row.structure_no) || [];
      list.push(layer);
      layersByStructure.set(row.structure_no, list);
    }

    const clientStructures = structureR.rows.map((row) => {
      const raw = row.raw_structure && typeof row.raw_structure === 'object' ? row.raw_structure : {};
      return {
        ...raw,
        id: raw.id || row.structure_key || `quote-structure-${row.structure_no}`,
        label: raw.label || row.structure_label || undefined,
        layers: layersByStructure.get(row.structure_no) || arr(raw.layers),
        // Per-structure quote type + single lead/follow line. The dedicated
        // columns are authoritative; raw_structure JSONB is the fallback.
        quoteType: row.quote_type || raw.quoteType || 'LEAD',
        leadLinePct: row.lead_line_pct != null ? String(row.lead_line_pct) : (raw.leadLinePct ?? ''),
        followLinePct: row.follow_line_pct != null ? String(row.follow_line_pct) : (raw.followLinePct ?? ''),
      };
    });

    const quoteCobUwLimits = {};
    const cobToggles = {};
    const cobManual = {};
    for (const row of cobR.rows) {
      const scope = row.scope_key || (row.structure_no === 0 ? 'exp' : `quote-structure-${row.structure_no}`);
      const cobId = String(row.class_of_business_id);
      quoteCobUwLimits[scope] = quoteCobUwLimits[scope] || {};
      cobToggles[scope] = cobToggles[scope] || {};
      cobManual[scope] = cobManual[scope] || {};
      quoteCobUwLimits[scope][cobId] = row.limit_amount == null ? '' : String(row.limit_amount);
      cobToggles[scope][cobId] = arr(row.layer_flags);
      cobManual[scope][cobId] = arr(row.manual_flags);
    }

    return {
      clientStructures,
      approvedStructures: structureR.rows.map((row) => !!row.selected_for_approval),
      quoteCobUwLimits,
      cobToggles,
      cobManual,
      expProbabilities: probabilityR.rows.map((row) => {
        const raw = row.raw_layer && typeof row.raw_layer === 'object' ? row.raw_layer : {};
        return {
          ...raw,
          pAttach: raw.pAttach ?? row.prob_attach_pct ?? '',
          pExhaust: raw.pExhaust ?? row.prob_exhaust_pct ?? '',
        };
      }),
    };
  } catch (err) {
    logger.warn('quote final workflow load skipped', { quoteId, error: err.message });
    return null;
  }
}

async function saveQuoteFinalWorkflowState(db, quoteId, npFinalPricing, req) {
  if (!npFinalPricing || typeof npFinalPricing !== 'object') return;
  const scaffold = npFinalPricing.fqScaffolding && typeof npFinalPricing.fqScaffolding === 'object'
    ? npFinalPricing.fqScaffolding
    : {};
  const clientStructures = arr(scaffold.clientStructures?.length ? scaffold.clientStructures : npFinalPricing.quoteStructures);
  const approved = arr(scaffold.approvedStructures?.length ? scaffold.approvedStructures : npFinalPricing.approvedStructures);
  const quoteCobUwLimits = scaffold.quoteCobUwLimits && typeof scaffold.quoteCobUwLimits === 'object' ? scaffold.quoteCobUwLimits : {};
  const cobToggles = scaffold.cobToggles && typeof scaffold.cobToggles === 'object' ? scaffold.cobToggles : {};
  const cobManual = scaffold.cobManual && typeof scaffold.cobManual === 'object' ? scaffold.cobManual : {};
  const expProbabilities = arr(scaffold.expProbabilities);
  const afterSnapshot = normaliseFinalPricingSnapshot(npFinalPricing);
  const { rows: finalTableRows } = await db.query(
    `SELECT
       to_regclass('public.quote_np_final_structure') IS NOT NULL
       AND to_regclass('public.quote_np_final_structure_layer') IS NOT NULL
       AND to_regclass('public.quote_np_final_structure_cob') IS NOT NULL
       AND to_regclass('public.quote_np_final_expiring_probability') IS NOT NULL
       AND to_regclass('public.quote_negotiation_event') IS NOT NULL AS ready`,
  );
  if (!finalTableRows[0]?.ready) {
    const err = new Error('quote final workflow persistence tables are not migrated');
    err.code = '42P01';
    throw err;
  }
  const { rows: latestRows } = await db.query(
    `SELECT after_snapshot
       FROM public.quote_negotiation_event
      WHERE quote_id=$1 AND event_type='QUOTE_FINAL_PRICING_SAVED'
      ORDER BY created_at DESC
      LIMIT 1`,
    [quoteId],
  ).catch(() => ({ rows: [] }));
  const beforeSnapshot = latestRows[0]?.after_snapshot || null;

  await db.query(`DELETE FROM public.quote_np_final_structure_cob WHERE quote_id=$1`, [quoteId]);
  await db.query(`DELETE FROM public.quote_np_final_expiring_probability WHERE quote_id=$1`, [quoteId]);
  await db.query(`DELETE FROM public.quote_np_final_structure WHERE quote_id=$1`, [quoteId]);

  const scopeToStructureNo = new Map([['exp', 0]]);
  for (let i = 0; i < clientStructures.length; i += 1) {
    const structure = clientStructures[i] || {};
    const structureNo = i + 1;
    const structureKey = structure.id ? String(structure.id) : `quote-structure-${structureNo}`;
    scopeToStructureNo.set(structureKey, structureNo);
    // Quote type is per structure; lead/follow line is a single value across
    // the structure (lead_line_pct for LEAD, follow_line_pct for INDICATIVE).
    const quoteType = String(structure.quoteType || 'LEAD').toUpperCase() === 'INDICATIVE' ? 'INDICATIVE' : 'LEAD';
    await db.query(
      `INSERT INTO public.quote_np_final_structure
         (quote_id, structure_no, structure_key, structure_label, selected_for_approval,
          quote_type, lead_line_pct, follow_line_pct, raw_structure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        quoteId,
        structureNo,
        structureKey,
        structure.label || null,
        !!approved[i],
        quoteType,
        pctNum(structure.leadLinePct),
        pctNum(structure.followLinePct),
        json({ ...structure, layers: arr(structure.layers).map((layer) => ({ ...layer })) }),
      ],
    );

    for (let li = 0; li < arr(structure.layers).length; li += 1) {
      const layer = structure.layers[li] || {};
      await db.query(
        `INSERT INTO public.quote_np_final_structure_layer
           (quote_id, structure_no, layer_number, layer_key,
            layer_limit, attachment, egnpi, earned_premium, rate, rol, risk, cat,
            pure_burn_pct, pareto_pct, burn_plus_pareto_pct, exposure_pct,
            burn_weight_pct, pareto_weight_pct, exposure_weight_pct, loading_pct, uw_price_pct,
            risk_pure_burn_pct, risk_pareto_pct, risk_burn_plus_pareto_pct, risk_exposure_pct,
            risk_burn_weight_pct, risk_pareto_weight_pct, risk_exposure_weight_pct, risk_loading_pct,
            risk_uw_price_pct, risk_prob_attach_pct, risk_prob_exhaust_pct,
            cat_pure_burn_pct, cat_pareto_pct, cat_burn_plus_pareto_pct, cat_exposure_pct,
            cat_burn_weight_pct, cat_pareto_weight_pct, cat_exposure_weight_pct, cat_loading_pct,
            cat_uw_price_pct, cat_prob_attach_pct, cat_prob_exhaust_pct, raw_layer)
         VALUES
           ($1,$2,$3,$4,
            $5,$6,$7,$8,$9,$10,$11,$12,
            $13,$14,$15,$16,
            $17,$18,$19,$20,$21,
            $22,$23,$24,$25,
            $26,$27,$28,$29,
            $30,$31,$32,
            $33,$34,$35,$36,
            $37,$38,$39,$40,
            $41,$42,$43,$44::jsonb)`,
        [
          quoteId, structureNo, li + 1, layer.id ? String(layer.id) : null,
          pctNum(layerValue(layer, ['limit', 'layer_limit'])),
          pctNum(layerValue(layer, ['attachment', 'deductible'])),
          pctNum(layerValue(layer, ['egnpi'])),
          pctNum(layerValue(layer, ['earnedPremium', 'earned_premium'])),
          pctNum(layerValue(layer, ['rate'])),
          pctNum(layerValue(layer, ['rol', 'totalRol'])),
          !!layer.risk,
          !!layer.cat,
          pctNum(layerValue(layer, ['pureBurn', 'pure_burning_cost'])),
          pctNum(layerValue(layer, ['pareto', 'pareto_pricing'])),
          pctNum(layerValue(layer, ['burnPlusPareto', 'burn_plus_pareto'])),
          pctNum(layerValue(layer, ['exposure', 'exposure_rating'])),
          pctNum(layerValue(layer, ['wtBurn', 'burn_weight_pct'])),
          pctNum(layerValue(layer, ['wtPareto', 'pareto_weight_pct'])),
          pctNum(layerValue(layer, ['wtExp', 'exposure_weight_pct'])),
          pctNum(layerValue(layer, ['loading', 'pricing_loading_pct'])),
          pctNum(layerValue(layer, ['uwPrice', 'uw_price'])),
          pctNum(layerValue(layer, ['riskPureBurn'])),
          pctNum(layerValue(layer, ['riskPareto'])),
          pctNum(layerValue(layer, ['riskAvgBurnPareto'])),
          pctNum(layerValue(layer, ['riskExposure'])),
          pctNum(layerValue(layer, ['riskWeightBurn', 'riskWtBurn'])),
          pctNum(layerValue(layer, ['riskWeightPareto', 'riskWtPareto'])),
          pctNum(layerValue(layer, ['riskWeightExposure'])),
          pctNum(layerValue(layer, ['riskLoading'])),
          pctNum(layerValue(layer, ['riskUwPrice', 'riskTotalPrice'])),
          pctNum(layerValue(layer, ['riskPrAttach', 'pAttach'])),
          pctNum(layerValue(layer, ['riskPrExhaust', 'pExhaust'])),
          pctNum(layerValue(layer, ['catPureBurn'])),
          pctNum(layerValue(layer, ['catPareto'])),
          pctNum(layerValue(layer, ['catAvgBurnPareto'])),
          pctNum(layerValue(layer, ['catExposure'])),
          pctNum(layerValue(layer, ['catWeightBurn', 'catWtBurn'])),
          pctNum(layerValue(layer, ['catWeightPareto', 'catWtPareto'])),
          pctNum(layerValue(layer, ['catWeightExposure'])),
          pctNum(layerValue(layer, ['catLoading'])),
          pctNum(layerValue(layer, ['catUwPrice', 'catTotalPrice'])),
          pctNum(layerValue(layer, ['catPrAttach', 'pAttach'])),
          pctNum(layerValue(layer, ['catPrExhaust', 'pExhaust'])),
          json(layer),
        ],
      );
    }
  }

  for (let i = 0; i < expProbabilities.length; i += 1) {
    const row = expProbabilities[i] || {};
    await db.query(
      `INSERT INTO public.quote_np_final_expiring_probability
         (quote_id, layer_number, prob_attach_pct, prob_exhaust_pct, raw_layer)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [quoteId, i + 1, pctNum(row.pAttach), pctNum(row.pExhaust), json(row)],
    );
  }

  for (const [scopeKey, limitsByCob] of Object.entries(quoteCobUwLimits)) {
    const structureNo = scopeToStructureNo.get(scopeKey) ?? (scopeKey === 'exp' ? 0 : null);
    if (structureNo == null) continue;
    for (const [cobId, limitAmount] of Object.entries(limitsByCob || {})) {
      if (!UUID_RE.test(String(cobId))) continue;
      await db.query(
        `INSERT INTO public.quote_np_final_structure_cob
           (quote_id, structure_no, scope_key, class_of_business_id, limit_amount, layer_flags, manual_flags)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [
          quoteId,
          structureNo,
          scopeKey,
          cobId,
          pctNum(limitAmount),
          json(cobToggles?.[scopeKey]?.[cobId] || []),
          json(cobManual?.[scopeKey]?.[cobId] || []),
        ],
      );
    }
  }

  const beforeJson = json(beforeSnapshot);
  const afterJson = json(afterSnapshot);
  if (beforeJson !== afterJson) {
    const { rows: qRows } = await db.query(
      `SELECT quote_version FROM public.quote WHERE quote_id=$1`,
      [quoteId],
    ).catch(() => ({ rows: [] }));
    const auditActor = await resolveAuditActor(req);
    await db.query(
      `INSERT INTO public.quote_negotiation_event
         (quote_id, quote_version, event_type, actor_name, actor_role, changed_keys, before_snapshot, after_snapshot)
       VALUES ($1,$2,'QUOTE_FINAL_PRICING_SAVED',$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [
        quoteId,
        qRows[0]?.quote_version || null,
        auditActor.actorName,
        auditActor.actorRole,
        changedSnapshotKeys(beforeSnapshot || {}, afterSnapshot),
        json(beforeSnapshot),
        afterJson,
      ],
    ).catch((err) => logger.warn('quote negotiation event save skipped', { quoteId, error: err.message }));
  }
}

// GET /api/quotes — list all quotes with optional status filter + pagination.
// Response shape is kept array-like for backwards compatibility, but
// pagination metadata ships in the X-Total-Count, X-Page, X-Page-Size
// response headers. Clients that want the count can read those; existing
// callers keep working.
router.get("/quotes", asyncHandler(async (req, res) => {
  const { status, cedant_id, uw_year, limit, offset, page } = req.query;
  const conditions = [];
  const params = [];
  if (status) {
    // support comma-separated status values
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length) {
      conditions.push(`q.status = ANY($${params.length + 1})`);
      params.push(statuses);
    }
  }
  if (cedant_id) { conditions.push(`q.cedant_id = $${params.length + 1}`); params.push(cedant_id); }
  const uwYearNum = numOrNull(uw_year);
  if (uwYearNum != null) { conditions.push(`q.uw_year = $${params.length + 1}`); params.push(uwYearNum); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitNum = Math.max(1, Math.min(numOrNull(limit) ?? 100, 500));
  const pageNum = Math.max(1, numOrNull(page) ?? 1);
  const offsetNum = numOrNull(offset) ?? (pageNum - 1) * limitNum;

  // Total count — cheap with indexed filters; one round-trip to give
  // clients accurate pagination UI without a second endpoint.
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM public.quote q ${where}`,
    params,
  );
  const total = countRows[0]?.total ?? 0;
  res.setHeader('X-Total-Count', String(total));
  res.setHeader('X-Page-Size', String(limitNum));
  res.setHeader('X-Page', String(pageNum));
  // Lifecycle columns (quote_ref, quote_version, parent_contract_id)
  // shipped in migration 044; production runs migrations on boot. The
  // previous try/catch fallback returned a base-columns variant if those
  // were missing — now dead code, removed.
  const joins = contractContextJoins('q');
  const { rows } = await pool.query(
    `SELECT q.quote_id AS id, q.quote_id, q.status, q.uw_year, q.updated_at, q.created_at,
            q.quote_ref, q.quote_version, q.parent_contract_id,
            ced.company_name AS name, bk.broker_name AS broker,
            cnt.country_name AS country, cnt.country_code,
            tt.treaty_type, tt.treaty_type AS treaty_type_name, tt.category AS treaty_category,
            cur.currency_code
       FROM public.quote q
       ${joins}
       ${where}
       ORDER BY q.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limitNum, offsetNum]
  );
  res.json(rows);
}));

// POST /api/quotes
router.post("/quotes", asyncHandler(async (req, res) => {
  const b = req.body || {};
  const uw_year = numOrNull(b.uw_year) || new Date().getFullYear();
  const inception_date = dateOrNull(b.inception_date);
  if (!inception_date) {
    return res.status(400).json({ error: 'inception_date is required', code: 'VALIDATION_FAILED' });
  }
  const creatorUserId = req.user?.userId || null;
  const { rows } = await pool.query(
    `INSERT INTO public.quote (uw_year,cedant_id,broker_id,currency_id,country_id,treaty_type_id,status,experience_source,renewal_date,inception_date,contract_description,created_by_user_id,assigned_to_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
    [uw_year, b.cedant_id || null, b.broker_id || null, b.currency_id || null, b.country_id || null, b.treaty_type_id || null, b.status || 'DRAFT', b.experience_source || 'TRIANGLE', dateOrNull(b.renewal_date), inception_date, b.contract_description || null, creatorUserId]
  );

  // Auto-assign human-readable quote reference: QT-YYYY-NNNN.
  // quote_ref_seq and the quote_ref column both shipped in migration 044;
  // the previous double-fallback (UUID-suffix ref + skip-the-update) is
  // dead code and has been removed.
  const newQuoteId = rows[0].quote_id;
  const { rows: seqRows } = await pool.query(`SELECT nextval('public.quote_ref_seq') AS n`);
  const qRef = `QT-${uw_year}-${String(seqRows[0].n).padStart(4, '0')}`;
  await pool.query(`UPDATE public.quote SET quote_ref=$2 WHERE quote_id=$1`, [newQuoteId, qRef]);
  rows[0].quote_ref = qRef;

  res.status(201).json({ id: newQuoteId, quote_id: newQuoteId, quote_ref: qRef, ...rows[0] });
}));

// GET /api/quotes/:id
router.get("/quotes/:id", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const {rows:mainRows}=await pool.query(
    `SELECT q.*,
            ced.company_name AS cedant_name,
            bk.broker_name,
            cnt.country_name, cnt.country_code,
            tt.treaty_type AS treaty_type_name, tt.category AS treaty_category,
            cur.currency_code
       FROM public.quote q
       ${contractContextJoins('q')}
      WHERE q.quote_id = $1`,
    [id]
  );
  if(!mainRows.length) return res.status(404).json({error:"Quote not found"});
  const q=mainRows[0];
  const [propR,commR,slidesR,lpR,cobR,epiR,uwLimR]=await Promise.all([
    pool.query(`SELECT * FROM public.quote_prop_details WHERE quote_id=$1`,[id]),
    pool.query(`SELECT * FROM public.quote_commissions WHERE quote_id=$1`,[id]),
    pool.query(`SELECT row_no,loss_ratio_pct,commission_pct FROM public.quote_commission_slides WHERE quote_id=$1 ORDER BY row_no`,[id]),
    pool.query(`SELECT * FROM public.quote_loss_participation WHERE quote_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id FROM public.quote_class_of_business WHERE quote_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id AS class_id,premium FROM public.quote_epi_split WHERE quote_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id,limit_amount,basis FROM public.quote_underwriting_limit WHERE quote_id=$1`,[id]),
  ]);
  const detail=propR.rows[0]||{};const comm=commR.rows[0]||{};const lp=lpR.rows[0]||{};
  res.json({
    contract_id:q.quote_id, quote_id:q.quote_id,
    updated_at:q.updated_at,
    created_at:q.created_at,
    quote_ref:q.quote_ref||null, quote_version:q.quote_version||1,
    quote_version_of:q.quote_version_of||null, bound_contract_id:q.bound_contract_id||null,
    class_ids:cobR.rows.map(r=>r.class_of_business_id),
    header:{cedant_id:q.cedant_id,broker_id:q.broker_id,currency_id:q.currency_id,country_id:q.country_id,
      treaty_type_id:q.treaty_type_id,uw_year:q.uw_year,status:q.status,experience_source:q.experience_source,
      cedant_name:q.cedant_name,broker_name:q.broker_name,country_name:q.country_name,country_code:q.country_code,
      treaty_type_name:q.treaty_type_name,treaty_category:q.treaty_category,currency_code:q.currency_code,
      renewal_date:q.renewal_date,inception_date:q.inception_date,contract_description:q.contract_description,
      quote_ref:q.quote_ref||null, quote_version:q.quote_version||1},
    detail:{triangulations_available:detail.triangulations_available??true,
      inception_date:q.inception_date,
      renewal_date:q.renewal_date,
      experience_start_year:detail.experience_start_year||null,
      qs_limit:detail.qs_limit,retention_pct:detail.retention_pct,retention_amt:detail.retention_amt,
      cession_pct:detail.cession_pct,cession_amt:detail.cession_amt,surplus_max_retention:detail.surplus_max_retention,
      num_lines:detail.num_lines,total_capacity:detail.total_capacity,event_limit:detail.event_limit,aal:detail.aal,
      quota_share_epi:detail.quota_share_epi,surplus_epi:detail.surplus_epi,
      brokerage_pct:detail.brokerage_pct,taxes_pct:detail.taxes_pct,loss_cap_pct:detail.loss_cap_pct,
      strip_large_cat_losses:detail.strip_large_cat_losses??false},
    commissions:{mode:comm.mode||"FIXED",fixed_commission_pct:comm.fixed_commission_pct,
      fixed_commission_qs_pct:comm.fixed_commission_qs_pct,fixed_commission_surplus_pct:comm.fixed_commission_surplus_pct,
      provisional_commission_pct:comm.provisional_commission_pct,
      sliding_min_loss_ratio:comm.sliding_min_loss_ratio,sliding_max_loss_ratio:comm.sliding_max_loss_ratio,
      sliding_min_commission:comm.sliding_min_commission,sliding_max_commission:comm.sliding_max_commission,
      mgmt_expenses_pct:comm.mgmt_expenses_pct,profit_commission_pct:comm.profit_commission_pct,sliding_table:slidesR.rows},
    lossParticipation:{enabled:lp.enabled??false,min_loss_ratio_pct:lp.min_loss_ratio_pct,
      max_loss_ratio_pct:lp.max_loss_ratio_pct,reinsurer_share_pct:lp.reinsurer_share_pct},
    epi_split:epiR.rows, underwriting_limits:uwLimR.rows,
    // Surface the renewal-pack import blob (added in migration 098) so
    // the review-import screen + "pre-filled" banner can render
    // confidence chips / warnings / unmatched CRESTA without a second
    // round-trip. NULL on quotes that weren't created from an import.
    import_metadata: q.import_metadata || null,
  });
}));

// PUT /api/quotes/:id — save quote terms (mirrors treaty PUT)
// Honours If-Unmodified-Since header for optimistic locking: clients
// that echo the quote's updated_at get 409 if another save intervened.
// Body is validated with quotePutBodySchema (passthrough mode — we
// coerce known fields and leave unknown ones alone while schemas are
// still being tightened; see validation/quote.js).
router.put("/quotes/:id", validateBody(quotePutBodySchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const {terms={}}=req.body;
  await assertCanEdit(req, 'QUOTE', id);
  const cl=await pool.connect();
  try{
  const ifUnmodifiedSince = req.headers['if-unmodified-since'];
  const staleWriteOverride = optimisticLockOverrideRequested(ifUnmodifiedSince);
  let staleWriteContext = null;
  if (staleWriteOverride) {
    const { rows: entityRows } = await cl.query(
      `SELECT updated_at FROM public.quote WHERE quote_id=$1`,
      [id],
    );
    const auditRows = await cl.query(
      `SELECT actor,event_type,created_at
         FROM public.audit_log
        WHERE entity_type='QUOTE' AND entity_id=$1
        ORDER BY created_at DESC
        LIMIT 1`,
      [id],
    ).then(r => r.rows).catch(() => []);
    staleWriteContext = {
      overwrittenUpdatedAt: entityRows[0]?.updated_at || null,
      previousActor: auditRows[0]?.actor || null,
      previousEventType: auditRows[0]?.event_type || null,
      previousEventAt: auditRows[0]?.created_at || null,
    };
  }
  await assertEntityUnchanged(cl, { table: 'public.quote', idColumn: 'quote_id', id, ifUnmodifiedSince });
  await cl.query("BEGIN");
  const h=terms.header||{};
  const d0=terms.detail||{};
  // Inception/renewal can arrive in either slice; header is source of
  // truth, detail-table date columns are deprecated. Mirror treaty PUT.
  if(Object.keys(h).length) await cl.query(`UPDATE public.quote SET cedant_id=COALESCE($2,cedant_id),broker_id=COALESCE($3,broker_id),currency_id=COALESCE($4,currency_id),country_id=COALESCE($5,country_id),treaty_type_id=COALESCE($6,treaty_type_id),uw_year=COALESCE($7,uw_year),experience_source=COALESCE($8,experience_source),renewal_date=COALESCE($9,renewal_date),contract_description=$10,inception_date=COALESCE($11,inception_date),updated_at=now() WHERE quote_id=$1`,
    [id,h.cedant_id||null,h.broker_id||null,h.currency_id||null,h.country_id||null,h.treaty_type_id||null,numOrNull(h.uw_year),h.experience_source||null,dateOrNull(d0.renewal_date??h.renewal_date),h.contract_description??null,dateOrNull(d0.inception_date??h.inception_date)]);
  // PARTIAL-SAVE SAFE: only update detail/commissions/classIds when explicitly provided
  if(terms.detail && Object.keys(terms.detail).length) {
    const d=terms.detail;
    // renewal_date lives on the quote (header) — the detail-table
    // renewal_date column is deprecated, no longer written here.
    await cl.query(`INSERT INTO public.quote_prop_details (quote_id,triangulations_available,qs_limit,retention_pct,retention_amt,cession_pct,cession_amt,surplus_max_retention,num_lines,total_capacity,event_limit,aal,quota_share_epi,surplus_epi,brokerage_pct,taxes_pct,loss_cap_pct,experience_start_year,strip_large_cat_losses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT (quote_id) DO UPDATE SET triangulations_available=EXCLUDED.triangulations_available,qs_limit=EXCLUDED.qs_limit,retention_pct=EXCLUDED.retention_pct,retention_amt=EXCLUDED.retention_amt,cession_pct=EXCLUDED.cession_pct,cession_amt=EXCLUDED.cession_amt,surplus_max_retention=EXCLUDED.surplus_max_retention,num_lines=EXCLUDED.num_lines,total_capacity=EXCLUDED.total_capacity,event_limit=EXCLUDED.event_limit,aal=EXCLUDED.aal,quota_share_epi=EXCLUDED.quota_share_epi,surplus_epi=EXCLUDED.surplus_epi,brokerage_pct=EXCLUDED.brokerage_pct,taxes_pct=EXCLUDED.taxes_pct,loss_cap_pct=EXCLUDED.loss_cap_pct,experience_start_year=EXCLUDED.experience_start_year,strip_large_cat_losses=EXCLUDED.strip_large_cat_losses,updated_at=now()`,
      [id,boolOrDefault(d.triangulations_available,true),numOrNull(d.qs_limit),numOrNull(d.retention_pct),numOrNull(d.retention_amt),numOrNull(d.cession_pct),numOrNull(d.cession_amt),numOrNull(d.surplus_max_retention),numOrNull(d.num_lines),numOrNull(d.total_capacity),numOrNull(d.event_limit),numOrNull(d.aal),numOrNull(d.quota_share_epi),numOrNull(d.surplus_epi),numOrNull(d.brokerage_pct),numOrNull(d.taxes_pct),numOrNull(d.loss_cap_pct),numOrNull(d.experience_start_year??d.experienceStartYear),boolOrDefault(d.strip_large_cat_losses??d.stripLargeCatLosses,false)]);
  }
  if(terms.commissions) {
    const cm=terms.commissions;
    await cl.query(`INSERT INTO public.quote_commissions (quote_id,mode,fixed_commission_pct,fixed_commission_qs_pct,fixed_commission_surplus_pct,sliding_min_loss_ratio,sliding_max_loss_ratio,sliding_min_commission,sliding_max_commission,provisional_commission_pct,mgmt_expenses_pct,profit_commission_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (quote_id) DO UPDATE SET mode=EXCLUDED.mode,fixed_commission_pct=EXCLUDED.fixed_commission_pct,fixed_commission_qs_pct=EXCLUDED.fixed_commission_qs_pct,fixed_commission_surplus_pct=EXCLUDED.fixed_commission_surplus_pct,sliding_min_loss_ratio=EXCLUDED.sliding_min_loss_ratio,sliding_max_loss_ratio=EXCLUDED.sliding_max_loss_ratio,sliding_min_commission=EXCLUDED.sliding_min_commission,sliding_max_commission=EXCLUDED.sliding_max_commission,provisional_commission_pct=EXCLUDED.provisional_commission_pct,mgmt_expenses_pct=EXCLUDED.mgmt_expenses_pct,profit_commission_pct=EXCLUDED.profit_commission_pct,updated_at=now()`,
      [id,(cm.mode||"FIXED").toUpperCase(),numOrNull(cm.fixed_commission_pct),numOrNull(cm.fixed_commission_qs_pct),numOrNull(cm.fixed_commission_surplus_pct),numOrNull(cm.sliding_min_loss_ratio),numOrNull(cm.sliding_max_loss_ratio),numOrNull(cm.sliding_min_commission),numOrNull(cm.sliding_max_commission),numOrNull(cm.provisional_commission_pct??cm.provisionalCommissionPct),numOrNull(cm.mgmt_expenses_pct),numOrNull(cm.profit_commission_pct)]);
  }
  // Class of business — only update when classIds/class_ids explicitly provided
  if(terms.classIds !== undefined || terms.class_ids !== undefined) {
    const classIds=terms.classIds??terms.class_ids??[];
    await cl.query(`DELETE FROM public.quote_class_of_business WHERE quote_id=$1`,[id]);
    const cobInsert = buildBatchInsert({
      table: 'public.quote_class_of_business',
      columns: ['quote_id','class_of_business_id'],
      rows: classIds.filter((cid) => cid != null).map((cid) => [cid]),
      leadingId: id,
      conflict: 'ON CONFLICT DO NOTHING',
    });
    if (cobInsert) await cl.query(cobInsert.sql, cobInsert.params);
  }
  // EPI split
  if(terms.epi_split !== undefined || terms.epiSplit !== undefined) {
    const epiSplit=terms.epi_split??terms.epiSplit??[];
    await cl.query(`DELETE FROM public.quote_epi_split WHERE quote_id=$1`,[id]);
    const epiBatch = [];
    for (const r of epiSplit) {
      const cid = r.class_id ?? r.classId ?? r.class_of_business_id;
      if (cid) epiBatch.push([cid, numOrNull(r.premium)]);
    }
    const epiInsert = buildBatchInsert({
      table: 'public.quote_epi_split',
      columns: ['quote_id','class_of_business_id','premium'],
      rows: epiBatch,
      leadingId: id,
    });
    if (epiInsert) await cl.query(epiInsert.sql, epiInsert.params);
  }
  // Loss participation
  if(terms.lossParticipation !== undefined || terms.loss_participation !== undefined) {
    const lpD=terms.lossParticipation??terms.loss_participation??{};
    await cl.query(`INSERT INTO public.quote_loss_participation (quote_id,enabled,min_loss_ratio_pct,max_loss_ratio_pct,reinsurer_share_pct) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (quote_id) DO UPDATE SET enabled=EXCLUDED.enabled,min_loss_ratio_pct=EXCLUDED.min_loss_ratio_pct,max_loss_ratio_pct=EXCLUDED.max_loss_ratio_pct,reinsurer_share_pct=EXCLUDED.reinsurer_share_pct,updated_at=now()`,
      [id,boolOrDefault(lpD.enabled,false),numOrNull(lpD.min_loss_ratio_pct??lpD.minLossRatioPct),numOrNull(lpD.max_loss_ratio_pct??lpD.maxLossRatioPct),numOrNull(lpD.reinsurer_share_pct??lpD.reinsurerSharePct)]);
  }
  const updatedR = await cl.query(
    `UPDATE public.quote SET updated_at=now() WHERE quote_id=$1 RETURNING updated_at`,
    [id],
  );
  const actor = actorFromReq(req);
  if (staleWriteOverride) {
    await logAudit(cl, {
      entityType: 'QUOTE',
      entityId: id,
      eventType: 'STALE_WRITE_OVERRIDE',
      actor,
      payload: {
        overrideHeader: 'If-Unmodified-Since: *',
        overwrittenBy: actor.id ?? actor.name ?? 'SYSTEM',
        overwrittenAt: new Date().toISOString(),
        ...staleWriteContext,
      },
    }, { critical: true });
  }
  await cl.query("COMMIT");
  res.json({ok:true,quote_id:id,updated_at:updatedR.rows[0]?.updated_at||null});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// DELETE /api/quotes/:id
router.delete("/quotes/:id", asyncHandler(async (req, res) => {
  const {rowCount}=await pool.query(`DELETE FROM public.quote WHERE quote_id=$1`,[req.params.id]);
  if(!rowCount) return res.status(404).json({error:"Quote not found"});
  res.json({ok:true,deleted:req.params.id});
}));

// ── Sub-entities (triangles, dev-factors, losses, profiles, cresta, docs, pricing, offer, NP) ──
// Each mirrors the contract variant but uses quote_* tables and quote_id

// Triangles
router.get("/quotes/:id/triangles/:type", asyncHandler(async (req, res) => {
  const variant = resolveVariant(req.query.variant);
  if (!variant) return res.status(400).json({ error: 'Invalid triangle variant', code: 'VALIDATION_FAILED' });
  const { rows } = await pool.query(
    `SELECT cell_id,origin_year,dev_months,cum_value
       FROM public.quote_triangle_cells
      WHERE quote_id=$1 AND type=$2::public.triangle_type AND variant=$3::public.triangle_variant
      ORDER BY origin_year,dev_months`,
    [req.params.id, req.params.type.toUpperCase(), variant]
  );
  res.json({ cells: rows });
}));
// Two-variant triangle (full + stripped of large/cat losses) — quote mirror
// of the treaty route. Losses live in the shared contract_* tables linked to
// the quote via quote_id on the report.
router.get("/quotes/:id/triangles/:type/with-exclusions", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  // INCURRED is not stored as its own triangle — it is paid + OS. Build the
  // combined full triangle here so the incurred loss amount can be stripped
  // directly from it (see combineIncurredCells in lib/triangleStripping.js).
  let cells;
  if (t === 'INCURRED') {
    const [{ rows: paidCells }, { rows: osCells }] = await Promise.all([
      pool.query(`SELECT origin_year,dev_months,cum_value FROM public.quote_triangle_cells WHERE quote_id=$1 AND type='CLAIMS_PAID'::public.triangle_type AND variant='MODIFIED'::public.triangle_variant ORDER BY origin_year,dev_months`, [id]),
      pool.query(`SELECT origin_year,dev_months,cum_value FROM public.quote_triangle_cells WHERE quote_id=$1 AND type='CLAIMS_OS'::public.triangle_type AND variant='MODIFIED'::public.triangle_variant ORDER BY origin_year,dev_months`, [id]),
    ]);
    cells = combineIncurredCells(paidCells, osCells);
  } else {
    const { rows } = await pool.query(
      `SELECT cell_id,origin_year,dev_months,cum_value FROM public.quote_triangle_cells WHERE quote_id=$1 AND type=$2::public.triangle_type AND variant='MODIFIED'::public.triangle_variant ORDER BY origin_year,dev_months`,
      [id, t]
    );
    cells = rows;
  }
  const { rows: largeLosses } = await pool.query(
    `SELECT ll.uw_year, ll.date_of_loss, ll.actuarial_reported_date, ll.paid, ll.os, ll.incurred
       FROM public.contract_large_losses ll
       JOIN public.contract_large_loss_report r ON r.report_id = ll.report_id
      WHERE r.quote_id = $1`, [id]
  );
  const { rows: catLosses } = await pool.query(
    `SELECT cl.uw_year, cl.date_of_loss, cl.actuarial_reported_date, cl.paid, cl.os, cl.incurred
       FROM public.contract_cat_losses cl
       JOIN public.contract_cat_loss_report r ON r.report_id = cl.report_id
      WHERE r.quote_id = $1`, [id]
  );
  const { rows: pd } = await pool.query(`SELECT strip_large_cat_losses FROM public.quote_prop_details WHERE quote_id=$1`, [id]);
  const stripEnabled = pd[0]?.strip_large_cat_losses === true; // default false
  const field = stripEnabled ? stripFieldForType(t) : null;
  const allLosses = field ? [...largeLosses, ...catLosses] : [];
  const stripped = stripTriangleCells(cells, allLosses, field);
  const placement = summarizeLossPlacement(cells, allLosses, field);
  res.json({
    full: { cells },
    stripped: { cells: stripped },
    exclusions: {
      largeLossCount: largeLosses.length, catLossCount: catLosses.length, applies: !!field,
      proxyPlaced: placement.proxy, reportedPlaced: placement.reported,
    },
  });
}));
// Per-quote choice of whether large + cat losses are stripped from the triangle.
router.put("/quotes/:id/strip-large-cat", validateBody(stripLargeCatSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const strip = (req.body?.strip_large_cat_losses ?? req.body?.stripLargeCatLosses) === true;
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    // Opt-in optimistic lock inside the txn (see large-losses).
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    // Upsert so the toggle persists even if Dev Factors is reached before the
    // detail screen has created the prop-details row (no silent no-op).
    await cl.query(
      `INSERT INTO public.quote_prop_details (quote_id, strip_large_cat_losses)
         VALUES ($1, $2)
       ON CONFLICT (quote_id) DO UPDATE
         SET strip_large_cat_losses=EXCLUDED.strip_large_cat_losses, updated_at=now()`,
      [id, strip]
    );
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'STRIP_LARGE_CAT_SAVED', payload: { strip_large_cat_losses: strip } });
    await cl.query("COMMIT");
    res.json({ ok: true, strip_large_cat_losses: strip, updated_at: updatedAt });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; } finally { cl.release(); }
}));
// Loss-selection staleness — quote mirror of the treaty route (see treatyData.js).
router.get("/quotes/:id/losses/staleness", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [lossRes, detRes] = await Promise.all([
    pool.query(
      `SELECT GREATEST(
         (SELECT MAX(l.updated_at) FROM public.contract_large_losses l
            JOIN public.contract_large_loss_report r ON r.report_id=l.report_id WHERE r.quote_id=$1),
         (SELECT MAX(l.updated_at) FROM public.contract_cat_losses l
            JOIN public.contract_cat_loss_report r ON r.report_id=l.report_id WHERE r.quote_id=$1)
       ) AS ts`,
      [id]
    ),
    pool.query(
      `SELECT loss_selection_saved_at AS ts FROM public.quote_prop_details WHERE quote_id=$1`,
      [id]
    ),
  ]);
  const lossesUpdatedAt = lossRes.rows[0]?.ts || null;
  const selectionSavedAt = detRes.rows[0]?.ts || null;
  res.json({ lossesUpdatedAt, selectionSavedAt, stale: isStaleSince(lossesUpdatedAt, selectionSavedAt) });
}));
router.post("/quotes/:id/triangles/:type", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  // Same defence as the treaty route — normalise the body shape, then
  // validate per-cell, then drop anything outside the quote's upper
  // triangle.
  const variant = resolveVariant(req.body?.variant);
  if (!variant) return res.status(400).json({ error: 'Invalid triangle variant', code: 'VALIDATION_FAILED' });
  const rawCells = normalizeTriangleRequest(req.body);
  const cellsParse = triangleCellsSchema.safeParse(rawCells);
  if (!cellsParse.success) {
    return res.status(400).json({
      error: 'Invalid triangle payload', code: 'VALIDATION_FAILED',
      fields: cellsParse.error.issues.map(i => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    });
  }
  const bounds = await getTriangleBounds('quote', id);
  const cells = filterTriangleCells(bounds, cellsParse.data);
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    // Opt-in optimistic lock inside the txn (see large-losses).
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    // Scope the delete to this variant — saving one variant must never wipe
    // the other's cells.
    await cl.query(
      `DELETE FROM public.quote_triangle_cells WHERE quote_id=$1 AND type=$2::public.triangle_type AND variant=$3::public.triangle_variant`,
      [id, t, variant]
    );
    if (cells.length) {
      await cl.query(
        `INSERT INTO public.quote_triangle_cells (quote_id, type, variant, origin_year, dev_months, cum_value)
         SELECT $1, $2::public.triangle_type, $3::public.triangle_variant, oy, dm, cv
           FROM unnest($4::int[], $5::int[], $6::numeric[]) AS u(oy, dm, cv)`,
        [
          id, t, variant,
          cells.map(c => c.origin_year),
          cells.map(c => c.dev_months),
          cells.map(c => numOrNull(c.cum_value) ?? 0),
        ]
      );
    }
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    // Quote audit falls through to the generic audit_log table since
    // logAudit only routes CONTRACT entityType to contract_audit_event.
    await auditMutation(cl, req, {
      entityType: 'QUOTE', entityId: id, eventType: 'TRIANGLE_SAVED',
      payload: { triangle_type: t, variant, saved: cells.length, dropped: rawCells.length - cells.length },
    });
    await cl.query("COMMIT");
    res.json({ ok: true, saved: cells.length, dropped: rawCells.length - cells.length, updated_at: updatedAt });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; } finally { cl.release(); }
}));

// Dev factors
router.get("/quotes/:id/dev-factors/:type", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.quote_dev_factor
      WHERE quote_id=$1 AND triangle_type=$2::public.triangle_type
      ORDER BY dev_month`,
    [req.params.id, req.params.type.toUpperCase()]
  );
  res.json(rows);
}));
// Quote mirror of the treaty dev-factor staleness check (see treatyData.js).
router.get("/quotes/:id/dev-factors/:type/staleness", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  const sourceTypes = t === 'INCURRED' ? ['CLAIMS_PAID', 'CLAIMS_OS'] : [t];
  const [triRes, dfRes] = await Promise.all([
    pool.query(
      `SELECT MAX(updated_at) AS ts FROM public.quote_triangle_cells
        WHERE quote_id=$1 AND type = ANY($2::public.triangle_type[]) AND variant='MODIFIED'::public.triangle_variant`,
      [id, sourceTypes]
    ),
    pool.query(
      `SELECT MAX(saved_at) AS ts FROM public.quote_dev_factor
        WHERE quote_id=$1 AND triangle_type=$2::public.triangle_type`,
      [id, t]
    ),
  ]);
  const triangleUpdatedAt = triRes.rows[0]?.ts || null;
  const factorsSavedAt = dfRes.rows[0]?.ts || null;
  const stale = !!(triangleUpdatedAt && factorsSavedAt && new Date(triangleUpdatedAt) > new Date(factorsSavedAt));
  res.json({ triangleUpdatedAt, factorsSavedAt, stale });
}));
router.put("/quotes/:id/dev-factors/:type", validateBody(devFactorPutSchema), asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  const factors = req.body.factors ?? [];
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    // Opt-in optimistic lock inside the txn (see large-losses).
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(
      `DELETE FROM public.quote_dev_factor WHERE quote_id=$1 AND triangle_type=$2::public.triangle_type`,
      [id, t]
    );
    if (factors.length) {
      // Two leading params: quote_id ($1) and triangle_type ($2).
      // buildBatchInsert binds a single leading param, so the type
      // cast is the second column and we emit it inline as $2 across
      // every row tuple. We do that by hand here rather than extending
      // the helper.
      const cols = ['quote_id','triangle_type','dev_month','selected_ldf','selected_cdf','actual_ldf','actual_cdf','param_ldf','param_cdf','chosen_source','chosen_ldf','chosen_cdf','overridden','parametrized_ldf','parametrized_cdf'];
      const params = [id, t];
      const tuples = [];
      let p = 3;
      for (const f of factors) {
        tuples.push(`($1,$2::public.triangle_type,$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        params.push(
          f.dev_month,
          numOrNull(f.selected_ldf), numOrNull(f.selected_cdf),
          numOrNull(f.actual_ldf),   numOrNull(f.actual_cdf),
          numOrNull(f.param_ldf),    numOrNull(f.param_cdf),
          f.chosen_source || null,
          numOrNull(f.chosen_ldf),   numOrNull(f.chosen_cdf),
          f.overridden ?? false,
          numOrNull(f.parametrized_ldf), numOrNull(f.parametrized_cdf),
        );
      }
      await cl.query(
        `INSERT INTO public.quote_dev_factor (${cols.join(',')}) VALUES ${tuples.join(',')}`,
        params,
      );
    }
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    await auditMutation(cl, req, {
      entityType: 'QUOTE', entityId: id, eventType: 'DEV_FACTORS_SAVED',
      payload: { triangle_type: t, count: factors.length, method: req.body?.method || null, basis: req.body?.basis || null },
    });
    await cl.query("COMMIT");
    res.json({ ok: true, updated_at: updatedAt });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; } finally { cl.release(); }
}));

// Losses (shared tables via quote_id FK)
router.get("/quotes/:id/large-losses", asyncHandler(async (req, res) => {
  const {rows:rr}=await pool.query(`SELECT * FROM public.contract_large_loss_report WHERE quote_id=$1`,[req.params.id]);
  if(!rr.length) return res.json({report:null,losses:[]});
  const {rows:losses}=await pool.query(`SELECT * FROM public.contract_large_losses WHERE report_id=$1 ORDER BY uw_year`,[rr[0].report_id]);
  res.json({report:rr[0],losses});
}));
router.put("/quotes/:id/large-losses", validateBody(lossesSaveSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const {report_date,losses=[]}=req.body;const cl=await pool.connect();
  try{await cl.query("BEGIN");
  await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
  // Opt-in optimistic lock (inside the txn): only enforced when the client
  // sends If-Unmodified-Since; a concurrent parent edit → 409 STALE_WRITE.
  await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
  // No UNIQUE(quote_id) on contract_large_loss_report, so check existence first
  const {rows:existing}=await cl.query(`SELECT report_id FROM public.contract_large_loss_report WHERE quote_id=$1`,[id]);
  let rid;
  if(existing.length){rid=existing[0].report_id;await cl.query(`UPDATE public.contract_large_loss_report SET report_date=$2,updated_at=now() WHERE report_id=$1`,[rid,dateOrNull(report_date)]);
  }else{const {rows:rr}=await cl.query(`INSERT INTO public.contract_large_loss_report (quote_id,report_date) VALUES ($1,$2) RETURNING report_id`,[id,dateOrNull(report_date)]);rid=rr[0].report_id;}
  const {rows:prev}=await cl.query(`SELECT loss_id,reported_date,is_selected,inflation_factor FROM public.contract_large_losses WHERE report_id=$1`,[rid]);
  const prevReported=new Map(prev.map(r=>[String(r.loss_id),r.reported_date]));
  const prevSelected=new Map(prev.map(r=>[String(r.loss_id),r.is_selected]));
  const prevInfl=new Map(prev.map(r=>[String(r.loss_id),r.inflation_factor]));
  await cl.query(`DELETE FROM public.contract_large_losses WHERE report_id=$1`,[rid]);
  const today=new Date().toISOString().slice(0,10);
  const reportSaved=dateOrNull(report_date)||today;
  const savedLosses = [];
  for(const l of losses) {
    const key=l.loss_id?String(l.loss_id):null;
    const existedReported=key?prevReported.get(key):null;
    // "Saved in Universe": report date of the cycle the loss first entered,
    // preserved across saves for year-over-year comparison (new rows take the
    // current report date). Actuarial date is the user-entered booking date
    // that drives stripping (nullable).
    const reported=existedReported||reportSaved;
    const actuarial=dateOrNull(l.actuarial_reported_date);
    const pinc=dateOrNull(l.policy_inception_date);
    // NaN-guarded underwriting year (see treaty handler).
    const uwy=safeUwYear(l);
    // Preserve selection + inflation when the save omits them.
    const selected=preserveBool(l.is_selected, key?prevSelected.get(key):undefined);
    const infl=preserveNum(l.inflation_factor, key?prevInfl.get(key):undefined, 1);
    const {rows:ins}=await cl.query(`INSERT INTO public.contract_large_losses (report_id,loss_id,uw_year,insured_name,loss_name,date_of_loss,class_of_business,paid,os,incurred,is_selected,inflation_factor,reported_date,actuarial_reported_date,policy_inception_date) VALUES ($1,COALESCE($2,gen_random_uuid()),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING loss_id`,
    [rid,l.loss_id||null,uwy,l.insured_name,l.loss_name,dateOrNull(l.date_of_loss),l.class_of_business,numOrNull(l.paid),numOrNull(l.os),numOrNull(l.incurred),selected,infl,reported,actuarial,pinc]);
    savedLosses.push(ins[0]?.loss_id);
  }
  const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
  await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'LARGE_LOSSES_SAVED', payload: { report_id: rid, loss_count: savedLosses.length } });
  await cl.query("COMMIT");res.json({ok:true,report_id:rid,loss_ids:savedLosses,updated_at:updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// COBs, profiles, cresta, pricing, offer, NP — abbreviated for core patterns
router.get("/quotes/:id/cobs", asyncHandler(async (req, res) => {
  try {
    // Introspect class_of_business column names (live DB schema may differ from dump)
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='class_of_business' ORDER BY ordinal_position`
    );
    const cols = colRes.rows.map(r => r.column_name);
    const idCol   = cols.find(c => c === 'class_of_business_id') || cols.find(c => c === 'class_id') || cols.find(c => c.endsWith('_id')) || cols[0];
    const nameCol = cols.find(c => c === 'class_of_business') || cols.find(c => c === 'class_name') || cols.find(c => c.includes('name')) || cols[1] || cols[0];
    const codeCol = cols.find(c => c === 'code') || cols.find(c => c === 'class_code') || null;
    const selectCode = codeCol ? `, cob.${codeCol} AS code` : ``;
    const {rows}=await pool.query(
      `SELECT qcb.class_of_business_id AS id, qcb.class_of_business_id, cob.${nameCol} AS name${selectCode}
         FROM public.quote_class_of_business qcb
         JOIN public.class_of_business cob ON cob.${idCol}=qcb.class_of_business_id
        WHERE qcb.quote_id=$1`,
      [req.params.id]
    );
    res.json(rows);
  } catch(e) {
    logger.warn('[GET /quotes/:id/cobs] primary query failed, falling back', { error: e.message });
    try {
      const {rows}=await pool.query(
        `SELECT class_of_business_id AS id, class_of_business_id, '' AS name, '' AS code
           FROM public.quote_class_of_business WHERE quote_id=$1`,
        [req.params.id]
      );
      res.json(rows);
    } catch { res.json([]); }
  }
}));

// Pricing
router.get("/quotes/:id/pricing", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [o,y]=await Promise.all([pool.query(`SELECT * FROM public.quote_pricing_outputs WHERE quote_id=$1`,[id]),pool.query(`SELECT * FROM public.quote_pricing_yearly WHERE quote_id=$1 ORDER BY uw_year`,[id])]);
  res.json({outputs:o.rows[0]||null,yearly:y.rows});
}));
router.get("/quotes/:id/pricing-outputs", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.quote_pricing_outputs WHERE quote_id=$1`,[req.params.id]);
  res.json(rows[0]||null);
}));
router.get("/quotes/:id/pricing-yearly", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.quote_pricing_yearly WHERE quote_id=$1 ORDER BY uw_year`,[req.params.id]);
  res.json(rows);
}));

// NP
router.get("/quotes/:id/non-prop", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [dR,lR,tR,uwR,qR,offerR]=await Promise.all([
    pool.query(`SELECT * FROM public.quote_np_details WHERE quote_id=$1`,[id]),
    pool.query(`SELECT * FROM public.quote_np_layers WHERE quote_id=$1 ORDER BY layer_number`,[id]),
    pool.query(`SELECT * FROM public.quote_np_terms WHERE quote_id=$1`,[id]),
    pool.query(`SELECT class_of_business_id, limit_amount FROM public.quote_underwriting_limit WHERE quote_id=$1`,[id]),
    pool.query(`SELECT q.status, q.updated_at, q.uw_year, q.inception_date, q.renewal_date, q.country_id, cnt.country_name
                  FROM public.quote q LEFT JOIN public.country cnt ON cnt.country_id = q.country_id
                  WHERE q.quote_id=$1`,[id]),
    pool.query(`SELECT status, written_line_pct, next_approver FROM public.quote_offer WHERE quote_id=$1 ORDER BY updated_at DESC LIMIT 1`,[id]).catch(()=>({rows:[]})),
  ]);
  const liveStatus  = qR.rows[0]?.status || null;
  const offerStatus = offerR.rows[0]?.status || null;
  const rawTerms = tR.rows[0]?.terms || {};
  const finalWorkflowState = await loadQuoteFinalWorkflowState(pool, id);
  const terms = finalWorkflowState
    ? {
        ...rawTerms,
        np_final_pricing: {
          ...(rawTerms.np_final_pricing || {}),
          quoteStructures: finalWorkflowState.clientStructures.length
            ? finalWorkflowState.clientStructures
            : rawTerms.np_final_pricing?.quoteStructures,
          approvedStructures: finalWorkflowState.approvedStructures.length
            ? finalWorkflowState.approvedStructures
            : rawTerms.np_final_pricing?.approvedStructures,
          fqScaffolding: {
            ...(rawTerms.np_final_pricing?.fqScaffolding || {}),
            ...finalWorkflowState,
          },
        },
      }
    : rawTerms;
  res.json({
    detail:dR.rows[0]||null,
    layers:lR.rows,
    terms,
    cob_underwriting_limits: uwR.rows.map(r=>({cob_id:String(r.class_of_business_id),limit_amount:r.limit_amount})),
    // Live statuses — offer_status drives approval workflow display in NpFinalPricing
    uw_status:    liveStatus,
    status:       liveStatus,
    offer_status: offerStatus || liveStatus,
    offer_approver: offerR.rows[0]?.next_approver || null,
    updated_at: qR.rows[0]?.updated_at || null,
    // Authoritative quote header (uw year range + country) so the premiums/
    // inflation screen can resolve its UW-year range and country directly from
    // this payload, without depending on a separate getContract call succeeding.
    contract_header: qR.rows[0]
      ? {
          uw_year: qR.rows[0].uw_year,
          inception_date: qR.rows[0].inception_date,
          renewal_date: qR.rows[0].renewal_date,
          country_id: qR.rows[0].country_id,
          country_name: qR.rows[0].country_name,
        }
      : null,
  });
}));
router.get("/quotes/:id/np-pricing", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [i,li,o]=await Promise.all([pool.query(`SELECT * FROM public.quote_np_pricing_inputs WHERE quote_id=$1`,[id]),pool.query(`SELECT * FROM public.quote_np_pricing_layer_inputs WHERE quote_id=$1 ORDER BY layer_number`,[id]),pool.query(`SELECT * FROM public.quote_np_pricing_outputs WHERE quote_id=$1 ORDER BY layer_number,section`,[id])]);
  res.json({inputs:i.rows[0]||null,layer_inputs:li.rows,outputs:o.rows});
}));

// GET /quotes/:id/offer/eligible-approvers — same logic as treaties
router.get("/quotes/:id/offer/eligible-approvers", asyncHandler(async (req, res) => {
  const submitterUserId = req.user?.userId;
  const { breach_type, epi_usd } = req.query;
  const { getEligibleApprovers } = await import('../services/approvals.js');
  const approvers = await getEligibleApprovers({ submitterUserId, breachType: breach_type, epiUsd: epi_usd });
  res.json(approvers);
}));

// Offer
router.get("/quotes/:id/offer", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.quote_offer WHERE quote_id=$1`,[req.params.id]);
  res.json(rows[0]||null);
}));

// Documents (shared table)
router.get("/quotes/:id/documents", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT document_id,file_name,mime_type,size_bytes,description,doc_type,title,storage_path,uploaded_at FROM public.contract_document WHERE quote_id=$1 ORDER BY uploaded_at DESC`,[req.params.id]);
  res.json(rows);
}));

router.get("/quotes/:id/wording-checklist", asyncHandler(async (req, res) => {
  const payload = await getWordingChecklist(pool, { type: 'quote', id: req.params.id });
  res.json(payload);
}));

router.put("/quotes/:id/wording-checklist", asyncHandler(async (req, res) => {
  const payload = await saveWordingChecklist(
    pool,
    { type: 'quote', id: req.params.id },
    req.body?.items || [],
    { actorUserId: req.user?.userId || null },
  );
  res.json(payload);
}));

router.post("/quotes/:id/wording-checklist/ai-check", asyncHandler(async (req, res) => {
  const payload = await runWordingChecklistAi(
    pool,
    { type: 'quote', id: req.params.id },
    { actorUserId: req.user?.userId || null },
  );
  res.json(payload);
}));

// POST /quotes/:id/documents — upload document to quote
const _multerQ = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
router.post("/quotes/:id/documents", _multerQ.single('file'), asyncHandler(async (req, res) => {
  const file = req.file; const b = req.body || {};
  if (!file) return res.status(400).json({ error: 'No file provided' });
  let storagePath;
  try {
    storagePath = await storeUploadedFile({ folder: `quotes/${req.params.id}`, file });
  } catch (e) {
    return res.status(502).json({ error: `Upload storage failed: ${e?.message || e}` });
  }
  const {rows}=await pool.query(
    `INSERT INTO public.contract_document (quote_id,file_name,mime_type,size_bytes,storage_path,description,doc_type,title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.id,file.originalname,file.mimetype,file.size,storagePath,b.description||null,b.doc_type||null,b.title||null]);
  res.status(201).json(rows[0]);
}));
// export moved to end of file

// ── Additional quote sub-entities needed by frontend ──

// Cat losses
router.get("/quotes/:id/cat-losses", asyncHandler(async (req, res) => {
  const {rows:rr}=await pool.query(`SELECT * FROM public.contract_cat_loss_report WHERE quote_id=$1`,[req.params.id]);
  if(!rr.length) return res.json({report:null,losses:[]});
  const {rows:losses}=await pool.query(`SELECT * FROM public.contract_cat_losses WHERE report_id=$1 ORDER BY uw_year`,[rr[0].report_id]);
  res.json({report:rr[0],losses});
}));

// Risk profiles
router.get("/quotes/:id/risk-profiles/:cobId", asyncHandler(async (req, res) => {
  const {rows:pr}=await pool.query(`SELECT * FROM public.quote_risk_profile WHERE quote_id=$1 AND class_of_business_id=$2`,[req.params.id,req.params.cobId]);
  if(!pr.length) return res.json({profile:null,bands:[]});
  const {rows:bands}=await pool.query(`SELECT * FROM public.quote_risk_profile_band WHERE profile_id=$1 ORDER BY from_amt`,[pr[0].profile_id]);
  res.json({profile:pr[0],bands});
}));

// Claims profiles
router.get("/quotes/:id/claims-profiles/:cobId", asyncHandler(async (req, res) => {
  const {rows:pr}=await pool.query(`SELECT * FROM public.quote_claims_profile WHERE quote_id=$1 AND class_of_business_id=$2`,[req.params.id,req.params.cobId]);
  if(!pr.length) return res.json({profile:null,bands:[]});
  const {rows:bands}=await pool.query(`SELECT * FROM public.quote_claims_profile_band WHERE profile_id=$1 ORDER BY from_amt`,[pr[0].profile_id]);
  res.json({profile:pr[0],bands});
}));

// Cresta
router.get("/quotes/:id/cresta", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.quote_cresta_data WHERE quote_id=$1 ORDER BY treaty_type,cob_id,country_id,zone_id`,[req.params.id]);
  res.json(rows);
}));

// Cedant exposure
router.get("/quotes/:id/cedant-exposure", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT COALESCE(exposure_json,'{}') AS exposure_json FROM public.quote_cedant_exposure WHERE quote_id=$1`,[req.params.id]);
  res.json(rows[0]||{exposure_json:{}});
}));

// Renew
router.post("/quotes/:id/renew", asyncHandler(async (req, res) => {
  const {id}=req.params;const b=req.body||{};
  const creatorUserId = req.user?.userId || null;
  const {rows:orig}=await pool.query(`SELECT * FROM public.quote WHERE quote_id=$1`,[id]);
  if(!orig.length) return res.status(404).json({error:"Quote not found"});
  const o=orig[0];
  // Roll the policy period forward like the contract-renew path: the new
  // inception is last term's renewal date when present, else a caller-
  // supplied inception, else the original inception (NOT NULL since
  // migration 104, so this is never null). Renewal rolls to inception+1yr
  // and the year derives from the new inception unless the caller overrides.
  const newInception = dateOrNull(o.renewal_date) || dateOrNull(b.inception_date) || dateOrNull(o.inception_date);
  const newRenewal = newInception
    ? new Date(new Date(newInception).setFullYear(new Date(newInception).getFullYear() + 1)).toISOString().slice(0, 10)
    : null;
  const newYear = numOrNull(b.uw_year) || (newInception ? new Date(newInception).getFullYear() : o.uw_year + 1);
  const {rows}=await pool.query(
    `INSERT INTO public.quote (cedant_id,broker_id,country_id,currency_id,treaty_type_id,uw_year,status,experience_source,inception_date,renewal_date,parent_contract_id,created_by_user_id,assigned_to_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8,$9,$10,$11,$11) RETURNING *`,
    [o.cedant_id,o.broker_id,o.country_id,o.currency_id,o.treaty_type_id,newYear,o.experience_source,newInception,newRenewal,id,creatorUserId]);
  res.status(201).json({id:rows[0].quote_id,quote_id:rows[0].quote_id,is_np:true,...rows[0]});
}));

// NP save — writes all layer columns, COB UW limits, and JSONB terms
router.post("/quotes/:id/non-prop/save", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;
  const {detail={}, layers=[], terms={}, cob_underwriting_limits=[]} = req.body;
  const cl=await pool.connect();
  // Helper: "UNLIMITED" stays null in numeric columns; store it in JSONB terms instead
  const reinstatInt = v => { if(String(v||'').trim().toUpperCase()==='UNLIMITED') return null; return numOrNull(v); };
  try{
    await cl.query("BEGIN");
    await assertParentEntityUnchanged(cl, {
      parentTable: 'quote',
      idColumn: 'quote_id',
      id,
      ifUnmodifiedSince: req.headers['if-unmodified-since'],
    });
    // The parent quote must already exist. A non-prop save against a missing
    // quote is a client bug — fabricating a stub (quote_id,status) row would
    // violate the NOT NULL identifying columns (migration 104), so 404.
    const {rows:parentRows}=await cl.query(`SELECT 1 FROM public.quote WHERE quote_id=$1`,[id]);
    if(!parentRows.length){
      await cl.query("ROLLBACK");
      return res.status(404).json({error:"Quote not found"});
    }

    // ── Upsert NP details ──
    if(detail && Object.keys(detail).length>0){
      const quoteStructuresCount = detail.structures_to_quote
        ?? detail.quote_structures_count
        ?? terms?.treaty_detail?.quoteStructuresCount
        ?? terms?.np_terms?.quote?.structures_count
        ?? null;
      await cl.query(
        `INSERT INTO public.quote_np_details
           (quote_id,number_of_layers,expiring_number_of_layers,deductible,max_retention,accounting_method,xl_type,accounts,
            brokerage_pct,taxes_pct,no_claims_bonus_pct,profit_commission_pct,est_gnpi,experience_start_year,structures_to_quote)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (quote_id) DO UPDATE SET
           number_of_layers=COALESCE(EXCLUDED.number_of_layers,quote_np_details.number_of_layers),
           expiring_number_of_layers=COALESCE(EXCLUDED.expiring_number_of_layers,quote_np_details.expiring_number_of_layers),
           deductible=COALESCE(EXCLUDED.deductible,quote_np_details.deductible),
           max_retention=COALESCE(EXCLUDED.max_retention,quote_np_details.max_retention),
           accounting_method=COALESCE(EXCLUDED.accounting_method,quote_np_details.accounting_method),
           xl_type=COALESCE(EXCLUDED.xl_type,quote_np_details.xl_type),
           accounts=COALESCE(EXCLUDED.accounts,quote_np_details.accounts),
           brokerage_pct=COALESCE(EXCLUDED.brokerage_pct,quote_np_details.brokerage_pct),
           taxes_pct=COALESCE(EXCLUDED.taxes_pct,quote_np_details.taxes_pct),
           no_claims_bonus_pct=COALESCE(EXCLUDED.no_claims_bonus_pct,quote_np_details.no_claims_bonus_pct),
           profit_commission_pct=COALESCE(EXCLUDED.profit_commission_pct,quote_np_details.profit_commission_pct),
           est_gnpi=COALESCE(EXCLUDED.est_gnpi,quote_np_details.est_gnpi),
           experience_start_year=COALESCE(EXCLUDED.experience_start_year,quote_np_details.experience_start_year),
           structures_to_quote=COALESCE(EXCLUDED.structures_to_quote,quote_np_details.structures_to_quote),
           updated_at=now()`,
        [id,numOrNull(detail.number_of_layers)??1,numOrNull(detail.expiring_number_of_layers),
         numOrNull(detail.deductible),numOrNull(detail.max_retention),
         detail.accounting_method||null,detail.xl_type||null,detail.accounts||null,
         numOrNull(detail.brokerage_pct),numOrNull(detail.taxes_pct),
         numOrNull(detail.no_claims_bonus_pct),numOrNull(detail.profit_commission_pct),
         numOrNull(detail.est_gnpi),numOrNull(detail.experience_start_year),numOrNull(quoteStructuresCount)]
      );
    }

    // ── Replace all layer rows (full columns) ──
    if(Array.isArray(layers) && layers.length>0){
      await cl.query(`DELETE FROM public.quote_np_layers WHERE quote_id=$1`,[id]);
      const layersInsert = buildBatchInsert({
        table: 'public.quote_np_layers',
        columns: [
          'quote_id','layer_number','attachment','layer_limit','aggregate_limit','egnpi','earned_premium',
          'rate','rol','num_reinstatements','reinstatement_pct','annual_agg_deductible','peril_scope','mdp','mdp_pct',
          'hist_margin','modelled_margin','tech_ratio','uw_price','expiring_price','lead_price',
        ],
        rows: layers.map((l) => [
          l.layer_number,
          numOrNull(l.attachment), numOrNull(l.layer_limit), numOrNull(l.aggregate_limit),
          numOrNull(l.egnpi), numOrNull(l.earned_premium),
          numOrNull(l.rate), numOrNull(l.rol),
          reinstatInt(l.num_reinstatements), numOrNull(l.reinstatement_pct),
          numOrNull(l.annual_agg_deductible),
          l.peril_scope || 'BOTH',
          numOrNull(l.mdp), numOrNull(l.mdp_pct),
          numOrNull(l.hist_margin), numOrNull(l.modelled_margin), numOrNull(l.tech_ratio),
          numOrNull(l.uw_price), numOrNull(l.expiring_price), numOrNull(l.lead_price),
        ]),
        leadingId: id,
      });
      if (layersInsert) await cl.query(layersInsert.sql, layersInsert.params);
    }

    // ── COB underwriting limits ──
    if(Array.isArray(cob_underwriting_limits) && cob_underwriting_limits.length>0){
      await cl.query(`DELETE FROM public.quote_underwriting_limit WHERE quote_id=$1`,[id]);
      const uwLimitInsert = buildBatchInsert({
        table: 'public.quote_underwriting_limit',
        columns: ['quote_id','class_of_business_id','limit_amount','basis'],
        rows: cob_underwriting_limits
          .filter((r) => r.cob_id)
          .map((r) => [r.cob_id, numOrNull(r.limit_amount) ?? 0, 'COMBINED']),
        leadingId: id,
        conflict: 'ON CONFLICT (quote_id,class_of_business_id) DO UPDATE SET limit_amount=EXCLUDED.limit_amount,updated_at=now()',
      });
      if (uwLimitInsert) await cl.query(uwLimitInsert.sql, uwLimitInsert.params);
    }

    // ── Merge JSONB terms ──
    if(terms && Object.keys(terms).length>0){
      await cl.query(
        `INSERT INTO public.quote_np_terms (quote_id,terms) VALUES ($1,$2::jsonb)
         ON CONFLICT (quote_id) DO UPDATE SET terms=quote_np_terms.terms || EXCLUDED.terms,updated_at=now()`,
        [id,JSON.stringify(terms)]
      );
      if (terms.np_final_pricing && typeof terms.np_final_pricing === 'object') {
        await saveQuoteFinalWorkflowState(cl, id, terms.np_final_pricing, req).catch((err) => {
          if (err?.code === '42P01') {
            logger.warn('quote final workflow persistence tables missing; JSONB save still completed', { quoteId: id, error: err.message });
            return;
          }
          throw err;
        });
      }
    }

    const updatedAt = await touchParentEntity(cl, {
      parentTable: 'quote',
      idColumn: 'quote_id',
      id,
    });
    await cl.query("COMMIT");
    res.json({ok:true, updated_at: updatedAt});
  }catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// NP EGNPI year
router.get("/quotes/:id/np/egnpi-year", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.quote_np_egnpi_year WHERE quote_id=$1 ORDER BY uw_year`,[req.params.id]);
  res.json(rows);
}));
router.put("/quotes/:id/np/egnpi-year", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;const inputRows=req.body.rows??[];const cl=await pool.connect();
  try{await cl.query("BEGIN");await cl.query(`DELETE FROM public.quote_np_egnpi_year WHERE quote_id=$1`,[id]);
  const egnpiInsert = buildBatchInsert({
    table: 'public.quote_np_egnpi_year',
    columns: ['quote_id','uw_year','egnpi','inflation_pct','rate_change_pct'],
    rows: inputRows
      .filter((r) => r && r.uw_year != null)
      .map((r) => [r.uw_year, numOrNull(r.egnpi), numOrNull(r.inflation_pct), numOrNull(r.rate_change_pct)]),
    leadingId: id,
    conflict: 'ON CONFLICT (quote_id,uw_year) DO UPDATE SET egnpi=EXCLUDED.egnpi,inflation_pct=EXCLUDED.inflation_pct,rate_change_pct=EXCLUDED.rate_change_pct,updated_at=now()',
  });
  if (egnpiInsert) await cl.query(egnpiInsert.sql, egnpiInsert.params);
  // Propagate latest year's EGNPI to est_gnpi on quote_np_details
  const sortedRows=[...inputRows].filter(r=>r.egnpi!=null).sort((a,b)=>(b.uw_year||0)-(a.uw_year||0));
  if(sortedRows.length>0){
    await cl.query(
      `INSERT INTO public.quote_np_details (quote_id,number_of_layers,est_gnpi) VALUES ($1,1,$2)
       ON CONFLICT (quote_id) DO UPDATE SET est_gnpi=EXCLUDED.est_gnpi,updated_at=now()`,
      [id,numOrNull(sortedRows[0].egnpi)]
    );
  }
  await cl.query("COMMIT");res.json({ok:true});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// NP pricing save
router.put("/quotes/:id/np-pricing", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;
  await assertCanEdit(req, 'QUOTE', id);
  const {inputs, layer_inputs=[], outputs=[], layer_margins=[]} = req.body;

  // Mirror contract NP pricing verification for quote-mode pricing.
  // Warn-only mode records drift but still saves; PRICING_STRICT=1 rejects.
  const drifts = verifyNpPricingOutputs(outputs);
  res.setHeader('X-Pricing-Drift-Count', String(drifts.length));
  const driftStats = pricingDriftStats(drifts);
  const driftLog = {
    requestId: res.locals.requestId || req.id || null,
    endpoint: 'quote_pricing',
    route: 'PUT /api/quotes/:id/np-pricing',
    parentType: 'quote',
    quoteId: id,
    ...driftStats,
    summary: summariseDrifts(drifts),
    ...(drifts.length > 0 ? { drifts: drifts.slice(0, 10) } : {}),
  };
  if (drifts.length > 0) {
    logger.warn('pricing drift check', driftLog);
    if (isStrictMode()) {
      return res.status(422).json({
        error: 'Pricing outputs failed server-side spot check',
        code: 'PRICING_DRIFT',
        requestId: res.locals.requestId || req.id || null,
        drifts,
      });
    }
  } else {
    logger.info('pricing drift check', driftLog);
  }

  const cl=await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertParentEntityUnchanged(cl, {
      parentTable: 'quote',
      idColumn: 'quote_id',
      id,
      ifUnmodifiedSince: req.headers['if-unmodified-since'],
    });
    if(inputs) await cl.query(
      `INSERT INTO public.quote_np_pricing_inputs (quote_id,burn_weight_pct,exposure_weight_pct,pareto_weight_pct,pricing_loading_pct,swiss_re_curve_name)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (quote_id) DO UPDATE SET
         burn_weight_pct=EXCLUDED.burn_weight_pct,exposure_weight_pct=EXCLUDED.exposure_weight_pct,
         pareto_weight_pct=EXCLUDED.pareto_weight_pct,
         pricing_loading_pct=EXCLUDED.pricing_loading_pct,swiss_re_curve_name=EXCLUDED.swiss_re_curve_name,updated_at=now()`,
      [id,numOrNull(inputs.burn_weight_pct),numOrNull(inputs.exposure_weight_pct),numOrNull(inputs.pareto_weight_pct),numOrNull(inputs.pricing_loading_pct),inputs.swiss_re_curve_name||null]);
    await cl.query(`DELETE FROM public.quote_np_pricing_layer_inputs WHERE quote_id=$1`,[id]);
    const layerInputsInsert = buildBatchInsert({
      table: 'public.quote_np_pricing_layer_inputs',
      columns: ['quote_id','layer_number','expiring_pricing_pct'],
      rows: layer_inputs.map((li) => [li.layer_number, numOrNull(li.expiring_pricing_pct)]),
      leadingId: id,
    });
    if (layerInputsInsert) await cl.query(layerInputsInsert.sql, layerInputsInsert.params);
    await cl.query(`DELETE FROM public.quote_np_pricing_outputs WHERE quote_id=$1`,[id]);
    const pricingOutputsInsert = buildBatchInsert({
      table: 'public.quote_np_pricing_outputs',
      columns: ['quote_id','layer_number','section','pure_burning_cost','pareto_pricing','burn_plus_pareto','exposure_rating','burn_weight_pct','exposure_weight_pct','pareto_weight_pct','pricing_loading_pct','total_price','prob_attach','prob_exhaust'],
      rows: outputs.map((o) => [
        o.layer_number, o.section,
        numOrNull(o.pure_burning_cost), numOrNull(o.pareto_pricing),
        numOrNull(o.burn_plus_pareto), numOrNull(o.exposure_rating),
        numOrNull(o.burn_weight_pct), numOrNull(o.exposure_weight_pct),
        numOrNull(o.pareto_weight_pct), numOrNull(o.pricing_loading_pct),
        numOrNull(o.total_price), numOrNull(o.prob_attach), numOrNull(o.prob_exhaust),
      ]),
      leadingId: id,
    });
    if (pricingOutputsInsert) await cl.query(pricingOutputsInsert.sql, pricingOutputsInsert.params);
    // Direct assignment, not COALESCE: NpFinalPricing sends every row
    // with every field, so a NULL here means the user cleared the cell
    // and the DB should clear it too. COALESCE used to silently drop
    // deletions because NULL on the wire was treated as "preserve".
    for(const m of layer_margins) {
      await cl.query(
        `UPDATE public.quote_np_layers
            SET hist_margin     = $3,
                modelled_margin = $4,
                tech_ratio      = $5,
                uw_price        = $6,
                expiring_price  = $7,
                lead_price      = $8,
                updated_at      = now()
          WHERE quote_id = $1 AND layer_number = $2`,
        [id, m.layer_number,
         numOrNull(m.hist_margin), numOrNull(m.modelled_margin), numOrNull(m.tech_ratio),
         numOrNull(m.uw_price), numOrNull(m.expiring_price), numOrNull(m.lead_price)]
      ).catch(() => {});
    }
    const updatedAt = await touchParentEntity(cl, {
      parentTable: 'quote',
      idColumn: 'quote_id',
      id,
    });
    await cl.query("COMMIT");
    res.json({ok:true, updated_at: updatedAt});
  } catch(e) { await cl.query("ROLLBACK").catch(()=>{}); throw e; }
  finally { cl.release(); }
}));

// Offer workflow (decline, submit, approve, sign, NTU, return-to-UW)
router.post("/quotes/:id/decline", asyncHandler(async (req, res) => {
  // Parity with treaty decline: one transaction (status + quote_offer + event +
  // critical audit), legal-transition guard (422 on a terminal pre-state),
  // authority via assertCanEdit. Actor identity is the verified req.user.
  const { id } = req.params;
  await assertCanEdit(req, 'QUOTE', id);
  const actor = await resolveAuditActor(req);
  const result = await declineQuoteAction(id, actor, req.body?.reason);
  res.json({ ok: true, ...result });
}));
router.post("/quotes/:id/offer/submit-for-approval", asyncHandler(async (req, res) => {
  // Parity with treaty submit: one transaction (quote status + quote_offer +
  // event + critical audit), legal-transition guard (422 unless DRAFT/re-submit).
  const { id } = req.params;
  await assertCanEdit(req, 'QUOTE', id);
  const actor = await resolveAuditActor(req);
  const result = await submitQuoteForApprovalAction(id, actor, req.body || {});
  res.json({ ok: true, ...result });
}));

router.post("/quotes/:id/offer/mark-approved", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body;
  // Route through the approval service: enforces four-eyes + approver authority
  // and the approved-state write goes through the assertWorkflowTransition gate.
  // Actor identity is the verified req.user (DB-resolved) — never client headers/body.
  const actor = await resolveAuditActor(req);
  const result = await approveQuote({
    quoteId: id,
    actorUserId: actor.actorUserId,
    actorName: actor.actorName,
    actorRole: actor.actorRole,
    comment: comment || null,
  });
  res.json({ ok: true, ...result });
}));

router.post("/quotes/:id/offer/return-to-underwriter", asyncHandler(async (req, res) => {
  // Authority (eligible approver / senior) + legal prior state are enforced by
  // the RETURN action inside the approval service; the DRAFT write + event live
  // there. Actor identity is the verified req.user (DB-resolved), never client input.
  const { id } = req.params;
  const { reason } = req.body;
  const actor = await resolveAuditActor(req);
  const result = await returnToUnderwriter({ quoteId: id, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
  res.json({ ok: true, ...result });
}));

// POST /quotes/:id/offer/recall — underwriter recalls submission before CU decides
router.post("/quotes/:id/offer/recall", asyncHandler(async (req, res) => {
  // Only the originator may recall, and only while still pending — enforced by
  // the RECALL action inside the approval service, which also logs the event.
  const { id } = req.params;
  const { reason } = req.body;
  const actor = await resolveAuditActor(req);
  const result = await recallOffer({ quoteId: id, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
  res.json({ ok: true, ...result });
}));

router.post("/quotes/:id/offer/mark-signed", asyncHandler(async (req, res) => {
  // Quote → SIGNED is intentionally disabled while quotes run as a
  // standalone artefact. The previous implementation (UPDATE quote
  // SET status='SIGNED', insert offer_approval_event, upsert quote_offer)
  // is preserved in git history for re-enablement.
  return res.status(410).json({
    error: 'Quote sign-off is disabled in this build.',
    code: 'QUOTE_SIGN_DISABLED',
    detail: 'Quotes run standalone — they do not advance to SIGNED. This endpoint will be re-wired in a later release.',
  });
}));

router.post("/quotes/:id/offer/ntu", asyncHandler(async (req, res) => {
  // NTU funnels through the approval engine: assignee / eligible-senior authority
  // + legal prior state, with the NTU write + immutable event in one place.
  const { id } = req.params;
  const { reason } = req.body;
  const actor = await resolveAuditActor(req);
  const result = await markNotTakenUp({ quoteId: id, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
  res.json({ ok: true, ...result });
}));
// Approval trail for quotes (mirrors contracts endpoint)
router.get("/quotes/:id/approval-trail", asyncHandler(async (req, res) => {
  const id = req.params.id;
  // Try offer_approval_event first (same table used by treaties)
  try {
    const { rows: events } = await pool.query(
      `SELECT * FROM public.offer_approval_event WHERE quote_id=$1 ORDER BY created_at ASC`, [id]
    );
    if (events.length) return res.json(events.map(e => ({ ...e, actor: e.actor_name })));
  } catch {}
  // Fallback: synthetic trail from quote status
  const { rows } = await pool.query(`SELECT status, updated_at FROM public.quote WHERE quote_id=$1`, [id]);
  if (!rows.length) return res.json([]);
  const statusToEvent = {
    AWAITING_APPROVAL: 'SUBMITTED_FOR_APPROVAL', AWAITING_SIGNED_LINE: 'APPROVED',
    SIGNED: 'SIGNED', NTU: 'NTU', DECLINED: 'DECLINED',
  };
  const ev = statusToEvent[rows[0].status];
  if (!ev) return res.json([]);
  res.json([{ event_type: ev, actor_name: 'System', actor: 'System', payload: {}, created_at: rows[0].updated_at }]);
}));

// GET /quotes/:id/negotiation-history
// Combines amendment versions with quote-specific pricing/structure change
// snapshots so underwriters can see how terms moved during negotiation.
router.get("/quotes/:id/negotiation-history", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows: selfRows } = await pool.query(
    `SELECT quote_id, quote_version_of FROM public.quote WHERE quote_id=$1`,
    [id],
  );
  if (!selfRows.length) return res.status(404).json({ error: 'Quote not found' });
  const rootId = selfRows[0].quote_version_of || id;
  const [versionR, eventR, approvalR] = await Promise.all([
    pool.query(
      `SELECT quote_id, quote_ref, quote_version, quote_version_of, status,
              amendment_reason, amended_at, created_at, updated_at
         FROM public.quote
        WHERE quote_id=$1 OR quote_version_of=$1
        ORDER BY quote_version ASC, created_at ASC`,
      [rootId],
    ),
    pool.query(
      `SELECT event_id, quote_id, quote_version, event_type, actor_name, actor_role,
              reason, changed_keys, before_snapshot, after_snapshot, created_at
         FROM public.quote_negotiation_event
        WHERE quote_id=$1 OR quote_id IN (SELECT quote_id FROM public.quote WHERE quote_version_of=$1)
        ORDER BY created_at ASC`,
      [rootId],
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT event_id, quote_id, event_type, actor_name, actor_role, comment AS reason, payload, created_at
         FROM public.offer_approval_event
        WHERE quote_id=$1 OR quote_id IN (SELECT quote_id FROM public.quote WHERE quote_version_of=$1)
        ORDER BY created_at ASC`,
      [rootId],
    ).catch(() => ({ rows: [] })),
  ]);
  res.json({
    root_id: rootId,
    versions: versionR.rows,
    events: eventR.rows,
    approval_events: approvalR.rows,
  });
}));

// ── Missing save routes (mirrors treatyData.js PUT routes) ──

// PUT /quotes/:id/cat-losses
router.put("/quotes/:id/cat-losses", validateBody(lossesSaveSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const {report_date,losses=[]}=req.body;const cl=await pool.connect();
  const reportDateNorm=report_date?new Date(report_date).toISOString().slice(0,10):null;
  try{await cl.query("BEGIN");
  await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
  // Opt-in optimistic lock (inside the txn) — see large-losses.
  await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
  const {rows:existing}=await cl.query(`SELECT report_id FROM public.contract_cat_loss_report WHERE quote_id=$1`,[id]);
  let rid;
  if(existing.length){rid=existing[0].report_id;await cl.query(`UPDATE public.contract_cat_loss_report SET report_date=$2,updated_at=now() WHERE report_id=$1`,[rid,reportDateNorm]);
  }else{const {rows:rr}=await cl.query(`INSERT INTO public.contract_cat_loss_report (quote_id,report_date) VALUES ($1,$2) RETURNING report_id`,[id,reportDateNorm]);rid=rr[0].report_id;}
  const {rows:prev}=await cl.query(`SELECT loss_id,reported_date,is_selected,inflation_factor FROM public.contract_cat_losses WHERE report_id=$1`,[rid]);
  const prevReported=new Map(prev.map(r=>[String(r.loss_id),r.reported_date]));
  const prevSelected=new Map(prev.map(r=>[String(r.loss_id),r.is_selected]));
  const prevInfl=new Map(prev.map(r=>[String(r.loss_id),r.inflation_factor]));
  await cl.query(`DELETE FROM public.contract_cat_losses WHERE report_id=$1`,[rid]);
  const today=new Date().toISOString().slice(0,10);
  const reportSaved=reportDateNorm||today;
  // Assign loss IDs up-front so we can batch the INSERT and still
  // return the same loss_ids array we used to one-row-at-a-time.
  const lossesWithIds = losses.map((l) => {
    const key = l.loss_id ? String(l.loss_id) : null;
    const existedReported = key ? prevReported.get(key) : null;
    return {
      ...l,
      _loss_id: l.loss_id || randomUUID(),
      // "Saved in Universe": report date of the cycle the loss first entered,
      // preserved across saves for year-over-year comparison. New rows take
      // the current report date.
      _reported: existedReported || reportSaved,
      // Actuarial reporting date — user-entered, nullable, drives stripping.
      _actuarial: l.actuarial_reported_date ? new Date(l.actuarial_reported_date).toISOString().slice(0,10) : null,
      _dol: l.date_of_loss ? new Date(l.date_of_loss).toISOString().slice(0,10) : null,
      _pinc: l.policy_inception_date ? new Date(l.policy_inception_date).toISOString().slice(0,10) : null,
      // NaN-guarded underwriting year (see treaty handler).
      _uwy: safeUwYear(l),
      // Preserve selection + inflation when the save omits them.
      _selected: preserveBool(l.is_selected, key ? prevSelected.get(key) : undefined),
      _infl: preserveNum(l.inflation_factor, key ? prevInfl.get(key) : undefined, 1),
    };
  });
  const lossesInsert = buildBatchInsert({
    table: 'public.contract_cat_losses',
    columns: ['report_id','loss_id','uw_year','insured_name','loss_name','date_of_loss','class_of_business','paid','os','incurred','is_selected','inflation_factor','reported_date','actuarial_reported_date','policy_inception_date'],
    rows: lossesWithIds.map((l) => [
      l._loss_id, l._uwy, l.insured_name, l.loss_name, l._dol,
      l.class_of_business, numOrNull(l.paid), numOrNull(l.os), numOrNull(l.incurred),
      l._selected, l._infl, l._reported, l._actuarial, l._pinc,
    ]),
    leadingId: rid,
  });
  if (lossesInsert) await cl.query(lossesInsert.sql, lossesInsert.params);
  const savedLosses = lossesWithIds.map((l) => l._loss_id);
  const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
  await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'CAT_LOSSES_SAVED', payload: { report_id: rid, loss_count: savedLosses.length } });
  await cl.query("COMMIT");res.json({ok:true,report_id:rid,loss_ids:savedLosses,updated_at:updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// POST /quotes/:id/losses/suggest-quarters — AI loss-to-quarter mapping
// (quote mirror of the treaty route). Advisory: returns suggestions only.
router.post("/quotes/:id/losses/suggest-quarters", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows: incurredCells } = await pool.query(
    `SELECT origin_year, dev_months, SUM(cum_value) AS cum_value
       FROM public.quote_triangle_cells
      WHERE quote_id=$1 AND type IN ('CLAIMS_PAID','CLAIMS_OS') AND variant='MODIFIED'::public.triangle_variant
      GROUP BY origin_year, dev_months
      ORDER BY origin_year, dev_months`, [id]
  );
  const { rows: largeLosses } = await pool.query(
    `SELECT ll.loss_id, ll.uw_year, ll.date_of_loss, ll.actuarial_reported_date, ll.paid, ll.os, ll.incurred
       FROM public.contract_large_losses ll
       JOIN public.contract_large_loss_report r ON r.report_id = ll.report_id
      WHERE r.quote_id = $1`, [id]
  );
  const { rows: catLosses } = await pool.query(
    `SELECT cl.loss_id, cl.uw_year, cl.date_of_loss, cl.actuarial_reported_date, cl.paid, cl.os, cl.incurred
       FROM public.contract_cat_losses cl
       JOIN public.contract_cat_loss_report r ON r.report_id = cl.report_id
      WHERE r.quote_id = $1`, [id]
  );
  const losses = [...largeLosses, ...catLosses];
  if (!losses.length) return res.json({ suggestions: [], provider: null });
  try {
    const out = await suggestLossQuarters({ losses, triangleCells: incurredCells, triangleType: 'INCURRED' });
    res.json(out);
  } catch (e) {
    const msg = e?.message || 'AI mapping failed';
    const noProvider = /No LLM provider configured/i.test(msg);
    logger.error('[quotes losses/suggest-quarters] failed', { error: msg });
    return res.status(noProvider ? 503 : 502).json({ error: msg });
  }
}));

// PUT /quotes/:id/cobs
router.put("/quotes/:id/cobs", validateBody(cobsSaveSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const {class_ids=[],classIds=[]}=req.body;const ids=classIds.length?classIds:class_ids;
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    // Opt-in optimistic lock inside the txn (see large-losses).
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(`DELETE FROM public.quote_class_of_business WHERE quote_id=$1`,[id]);
    const cobInsert = buildBatchInsert({
      table: 'public.quote_class_of_business',
      columns: ['quote_id','class_of_business_id'],
      rows: ids.filter((cid) => cid != null).map((cid) => [cid]),
      leadingId: id,
      conflict: 'ON CONFLICT DO NOTHING',
    });
    if (cobInsert) await cl.query(cobInsert.sql, cobInsert.params);
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'COBS_SAVED', payload: { count: ids.filter((c) => c != null).length } });
    await cl.query("COMMIT");
    res.json({ok:true,updated_at:updatedAt});
  } catch (e) {
    await cl.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    cl.release();
  }
}));

// PUT /quotes/:id/risk-profiles/:cobId
// Body shape matches treaty PUT: { c_value, pml_percentage, selected_curve, custom_b, custom_g, gross_loss_ratio, bands }
router.put("/quotes/:id/risk-profiles/:cobId", validateBody(riskProfileSaveSchema), asyncHandler(async (req, res) => {
  const {id,cobId}=req.params;
  const {c_value,pml_percentage,selected_curve,custom_b,custom_g,gross_loss_ratio,bands=[]}=req.body;
  const cl=await pool.connect();
  try{await cl.query("BEGIN");
  await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
  // Opt-in optimistic lock inside the txn (see large-losses).
  await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
  const {rows}=await cl.query(`INSERT INTO public.quote_risk_profile (quote_id,class_of_business_id,c_value,pml_percentage,selected_curve,custom_b,custom_g,gross_loss_ratio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (quote_id,class_of_business_id) DO UPDATE SET c_value=EXCLUDED.c_value,pml_percentage=EXCLUDED.pml_percentage,selected_curve=EXCLUDED.selected_curve,custom_b=EXCLUDED.custom_b,custom_g=EXCLUDED.custom_g,gross_loss_ratio=EXCLUDED.gross_loss_ratio RETURNING profile_id`,
    [id,cobId,numOrNull(c_value)??0,numOrNull(pml_percentage)??100,selected_curve||null,numOrNull(custom_b),numOrNull(custom_g),numOrNull(gross_loss_ratio)]);
  const pid=rows[0].profile_id;await cl.query(`DELETE FROM public.quote_risk_profile_band WHERE profile_id=$1`,[pid]);
  const riskBandsInsert = buildBatchInsert({
    table: 'public.quote_risk_profile_band',
    columns: ['profile_id','from_amt','to_amt','no_of_risks','total_sum_insured','gross_premium'],
    rows: bands.map((b) => [numOrNull(b.from_amt),numOrNull(b.to_amt),numOrNull(b.no_of_risks),numOrNull(b.total_sum_insured),numOrNull(b.gross_premium)]),
    leadingId: pid,
  });
  if (riskBandsInsert) await cl.query(riskBandsInsert.sql, riskBandsInsert.params);
  const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
  await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'RISK_PROFILE_SAVED', payload: { class_of_business_id: cobId, profile_id: pid, band_count: bands.length } });
  await cl.query("COMMIT");res.json({ok:true,profile_id:pid,updated_at:updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// PUT /quotes/:id/claims-profiles/:cobId
// Body shape matches treaty PUT: { selected_curve, custom_b, custom_g, bands }
// Bands include no_of_claims + aggregate_incurred (the actual claims payload).
router.put("/quotes/:id/claims-profiles/:cobId", validateBody(claimsProfileSaveSchema), asyncHandler(async (req, res) => {
  const {id,cobId}=req.params;
  const {selected_curve,custom_b,custom_g,bands=[]}=req.body;
  const cl=await pool.connect();
  try{await cl.query("BEGIN");
  await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
  // Opt-in optimistic lock inside the txn (see large-losses).
  await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
  const {rows}=await cl.query(`INSERT INTO public.quote_claims_profile (quote_id,class_of_business_id,selected_curve,custom_b,custom_g) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (quote_id,class_of_business_id) DO UPDATE SET selected_curve=EXCLUDED.selected_curve,custom_b=EXCLUDED.custom_b,custom_g=EXCLUDED.custom_g RETURNING profile_id`,
    [id,cobId,selected_curve||null,numOrNull(custom_b),numOrNull(custom_g)]);
  const pid=rows[0].profile_id;await cl.query(`DELETE FROM public.quote_claims_profile_band WHERE profile_id=$1`,[pid]);
  const claimsBandsInsert = buildBatchInsert({
    table: 'public.quote_claims_profile_band',
    columns: ['profile_id','from_amt','to_amt','no_of_claims','aggregate_incurred','no_of_risks','total_sum_insured','gross_premium'],
    rows: bands.map((b) => [numOrNull(b.from_amt),numOrNull(b.to_amt),numOrNull(b.no_of_claims),numOrNull(b.aggregate_incurred),numOrNull(b.no_of_risks),numOrNull(b.total_sum_insured),numOrNull(b.gross_premium)]),
    leadingId: pid,
  });
  if (claimsBandsInsert) await cl.query(claimsBandsInsert.sql, claimsBandsInsert.params);
  const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
  await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'CLAIMS_PROFILE_SAVED', payload: { class_of_business_id: cobId, profile_id: pid, band_count: bands.length } });
  await cl.query("COMMIT");res.json({ok:true,profile_id:pid,updated_at:updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// PUT /quotes/:id/cresta
router.put("/quotes/:id/cresta", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const parsed = crestaSaveSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid CRESTA payload', details: parsed.error.issues });
  const { rows: cRows, treaty_type, cob_id: cobId, cob_name: cobName, country_id: countryId } = parsed.data;
  // Default 'Both' matches the treaty route — earlier 'PROP' default
  // produced quote rows the UI couldn't read back because the slice key
  // didn't match anything inferred from the treaty type name.
  const treatyType = treaty_type || 'Both';
  await saveCrestaSlice({ kind: 'quote', id, rows: cRows, treatyType, cobId: cobId || null, cobName: cobName || null, countryId: countryId || null });
  res.json({ ok: true });
}));

// PUT /quotes/:id/pricing-outputs
router.put("/quotes/:id/pricing-outputs", validateBody(pricingOutputsSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const d=req.body||{};
  const cl=await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    // Opt-in optimistic lock (inside the txn) — see large-losses.
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(
      `INSERT INTO public.quote_pricing_outputs
         (quote_id,epi,attritional_ratio,large_loss_load,cat_loss_load,
          commission_ratio,brokerage_ratio,tax_ratio,technical_result,max_commission,target_margin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (quote_id) DO UPDATE SET
         epi=EXCLUDED.epi, attritional_ratio=EXCLUDED.attritional_ratio,
         large_loss_load=EXCLUDED.large_loss_load, cat_loss_load=EXCLUDED.cat_loss_load,
         commission_ratio=EXCLUDED.commission_ratio, brokerage_ratio=EXCLUDED.brokerage_ratio,
         tax_ratio=EXCLUDED.tax_ratio, technical_result=EXCLUDED.technical_result,
         max_commission=EXCLUDED.max_commission, target_margin=EXCLUDED.target_margin,
         updated_at=now()`,
      [id,numOrNull(d.epi),numOrNull(d.attritional_ratio),numOrNull(d.large_loss_load),
       numOrNull(d.cat_loss_load),numOrNull(d.commission_ratio),numOrNull(d.brokerage_ratio),
       numOrNull(d.tax_ratio),numOrNull(d.technical_result),numOrNull(d.max_commission),numOrNull(d.target_margin)]);
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'PRICING_OUTPUTS_SAVED', payload: { epi: numOrNull(d.epi) } });
    await cl.query("COMMIT");
    res.json({ok:true, updated_at: updatedAt});
  } catch(e) {
    await cl.query("ROLLBACK").catch(()=>{});
    throw e;
  } finally {
    cl.release();
  }
}));

// PUT /quotes/:id/pricing-yearly
router.put("/quotes/:id/pricing-yearly", validateBody(pricingYearlySchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const rows=req.body.rows??req.body??[];const cl=await pool.connect();
  try{
    await cl.query("BEGIN");
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    // Opt-in optimistic lock (inside the txn) — see large-losses.
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(`DELETE FROM public.quote_pricing_yearly WHERE quote_id=$1`,[id]);
    const yearlyInsert = buildBatchInsert({
      table: 'public.quote_pricing_yearly',
      columns: ['quote_id','uw_year','premium','paid_claims','os_claims','incurred_claims','loss_ratio','commission','brokerage','net_result'],
      rows: rows.map((r) => [
        r.uw_year,
        numOrNull(r.premium), numOrNull(r.paid_claims), numOrNull(r.os_claims), numOrNull(r.incurred_claims),
        numOrNull(r.loss_ratio), numOrNull(r.commission), numOrNull(r.brokerage), numOrNull(r.net_result),
      ]),
      leadingId: id,
    });
    if (yearlyInsert) await cl.query(yearlyInsert.sql, yearlyInsert.params);
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'PRICING_YEARLY_SAVED', payload: { row_count: rows.length } });
    await cl.query("COMMIT");
    res.json({ok:true, updated_at: updatedAt});
  } catch(e) {
    await cl.query("ROLLBACK").catch(()=>{});
    throw e;
  } finally {
    cl.release();
  }
}));

// GET /quotes/:id/loss-selection/:lossType/latest
router.get("/quotes/:id/loss-selection/:lossType/latest", asyncHandler(async (req, res) => {
  const {id,lossType}=req.params;
  const _lt = String(lossType||'').toUpperCase();
  const normLt = (_lt==='LARGE'||_lt==='CAT') ? _lt
               : (_lt==='LARGE_LOSS'||_lt==='LL') ? 'LARGE'
               : (_lt==='CAT_LOSS'||_lt==='CL')   ? 'CAT'
               : _lt.toLowerCase()==='large' ? 'LARGE' : 'CAT';
  const {rows:snaps}=await pool.query(
    `SELECT * FROM public.contract_loss_selection_snapshot WHERE quote_id=$1 AND loss_type=$2 ORDER BY created_at DESC LIMIT 1`,
    [id, normLt]);
  if(!snaps.length) return res.json({snapshot:null, items:[]});
  const snap=snaps[0];
  const {rows:items}=await pool.query(
    `SELECT * FROM public.contract_loss_selection_snapshot_item WHERE snapshot_id=$1 ORDER BY uw_year`,
    [snap.snapshot_id]);
  // Must match treaty format: { snapshot, items } — client reads snapshotData.snapshot
  res.json({snapshot:snap, items});
}));

// PUT /quotes/:id/loss-selection/:lossType/snapshot
// Mirrors treaty version exactly — stores full Pareto analysis fields
router.put("/quotes/:id/loss-selection/:lossType/snapshot", asyncHandler(async (req, res) => {
  const {id,lossType}=req.params;
  // Normalise to enum values stored in DB: 'LARGE' or 'CAT'
  const _u = String(lossType||'').toUpperCase();
  const lt = (_u==='LARGE'||_u==='CAT') ? _u
           : (_u==='LARGE_LOSS'||_u==='LL'||_u==='L') ? 'LARGE'
           : (_u==='CAT_LOSS'||_u==='CL'||_u==='C') ? 'CAT'
           : _u.toLowerCase()==='large' ? 'LARGE' : _u.toLowerCase()==='cat' ? 'CAT' : 'LARGE';
  const body=req.body||{};
  const selected_losses=Array.isArray(body.selected_losses)?body.selected_losses:[];
  const cl=await pool.connect();
  try{await cl.query("BEGIN");
  const {rows}=await cl.query(
    `INSERT INTO public.contract_loss_selection_snapshot
      (quote_id,loss_type,
       inflation_mode,inflation_index,inflation_rate_pct,inflation_base_year,inflation_to_year,
       threshold,global_factor,selected_count,
       loadings,total_loading_pct,
       distribution_fits,active_distribution,
       pareto_xm,pareto_alpha,pareto_limit,observation_years,
       return_period_curve,return_period_key_points,assumptions_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING snapshot_id`,
    [id,lt,
     body.inflation_mode||null,body.inflation_index||null,
     numOrNull(body.inflation_rate_pct),numOrNull(body.inflation_base_year),numOrNull(body.inflation_to_year),
     numOrNull(body.threshold),numOrNull(body.global_factor),
     selected_losses.length||body.selected_count||null,
     body.loadings?JSON.stringify(body.loadings):null,numOrNull(body.total_loading_pct),
     body.distribution_fits?JSON.stringify(body.distribution_fits):null,body.active_distribution||null,
     numOrNull(body.pareto_xm),numOrNull(body.pareto_alpha),numOrNull(body.pareto_limit),
     numOrNull(body.observation_years),
     body.return_period_curve?JSON.stringify(body.return_period_curve):null,
     body.return_period_key_points?JSON.stringify(body.return_period_key_points):null,
     body.assumptions_hash||null]);
  const sid=rows[0].snapshot_id;
  const snapItemInsert = buildBatchInsert({
    table: 'public.contract_loss_selection_snapshot_item',
    columns: ['snapshot_id','uw_year','source_loss_id','insured_name','loss_name','date_of_loss','class_of_business','paid','os','incurred','inflation_factor','inflated_incurred'],
    rows: selected_losses.map((l) => [
      l.uw_year||null,
      l.loss_id||null,
      l.insured_name||null,
      l.loss_name||null,
      l.date_of_loss||null,
      l.class_of_business||null,
      numOrNull(l.paid),
      numOrNull(l.os),
      numOrNull(l.incurred),
      numOrNull(l.inflation_factor)??1,
      numOrNull(l.inflated||l.inflated_incurred),
    ]),
    leadingId: sid,
  });
  if (snapItemInsert) await cl.query(snapItemInsert.sql, snapItemInsert.params);
  // Mark the selection as saved now. Upsert so it persists even if Loss
  // Selection is reached before the detail screen created the row.
  await cl.query(
    `INSERT INTO public.quote_prop_details (quote_id, loss_selection_saved_at)
       VALUES ($1, now())
     ON CONFLICT (quote_id) DO UPDATE SET loss_selection_saved_at=now(), updated_at=now()`,
    [id]
  );
  await cl.query("COMMIT");res.json({ok:true,snapshot_id:sid});
  }catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

export default router;
