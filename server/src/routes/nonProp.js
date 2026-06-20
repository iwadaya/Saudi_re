// server/src/routes/nonProp.js — Non-proportional treaty endpoints (PARTIAL-SAVE SAFE)
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, numOrNull, assertExists } from '../helpers.js';
import { entityContext } from '../lib/entityContext.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../lib/parentEntityPersistence.js';
import { validateBody } from '../lib/validate.js';
import { auditMutation } from '../lib/mutationAudit.js';
import {
  npSaveSchema,
  egnpiYearPutSchema,
  npPricingPutSchema,
  npExpiringPutSchema,
  excessLdfsPutSchema,
  lossLdfsPutSchema,
  historicalPerfPutSchema,
  stopLossPricingPutSchema,
} from '../validation/nonProp.js';
import { verifyNpPricingOutputs, summariseDrifts, isStrictMode, pricingDriftStats } from '../lib/pricingVerifier.js';
import { recordPricingDrift } from '../observability/businessMetrics.js';
import { logger } from '../lib/logger.js';
import { buildBatchInsert } from '../db/batchInsert.js';
import {
  loadTreatyCategory,
  requireTreatyCategory,
  loadQuoteCategory,
  requireQuoteCategory,
} from '../lib/treatyCategoryGuard.js';
const router = Router();
// Category fences for the NP-only routes below: reject (409) a request that
// targets a proportional treaty/quote before the handler reads empty NP tables.
const npTreatyGuard = [loadTreatyCategory, requireTreatyCategory('NON_PROPORTIONAL')];
const npQuoteGuard = [loadQuoteCategory, requireQuoteCategory('NON_PROPORTIONAL')];
// "UNLIMITED" reinstatements stays null in numeric column; preserved in JSONB
function reinstatInt(v){if(String(v||'').trim().toUpperCase()==='UNLIMITED')return null;return numOrNull(v);}

// ── GET /api/treaties/:id/non-prop ──
// Returns: detail row, layers (each with their COB ids), cob UW limits, JSONB terms,
//          uw_status + offer_status from live DB (authoritative for approval workflow)
router.get("/treaties/:id/non-prop", ...npTreatyGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [detailR, layersR, termsR, cobLimitsR, contractR, offerR] = await Promise.all([
    pool.query(`SELECT * FROM public.contract_np_details WHERE contract_id=$1`, [id]),
    pool.query(`SELECT * FROM public.contract_np_layers WHERE contract_id=$1 ORDER BY layer_number`, [id]),
    pool.query(`SELECT * FROM public.contract_np_terms WHERE contract_id=$1`, [id]),
    pool.query(`SELECT class_of_business_id, limit_amount FROM public.contract_underwriting_limit WHERE contract_id=$1`, [id]),
    pool.query(`SELECT c.uw_status, c.status, c.updated_at, c.uw_year, c.inception_date, c.renewal_date, c.country_id, cnt.country_name
                  FROM public.contract c LEFT JOIN public.country cnt ON cnt.country_id = c.country_id
                  WHERE c.contract_id=$1`, [id]),
    pool.query(`SELECT status AS offer_status, next_approver FROM public.contract_offer WHERE contract_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]),
  ]);

  // For each layer, load its participating COBs from the junction table
  const layers = layersR.rows;
  if (layers.length > 0) {
    const layerIds = layers.map(l => l.layer_id);
    const cobR = await pool.query(
      `SELECT layer_id, class_of_business_id FROM public.contract_np_layer_class_of_business WHERE layer_id = ANY($1)`,
      [layerIds]
    );
    // Group cob ids by layer_id
    const cobsByLayer = {};
    for (const row of cobR.rows) {
      const lid = row.layer_id;
      if (!cobsByLayer[lid]) cobsByLayer[lid] = [];
      cobsByLayer[lid].push(String(row.class_of_business_id));
    }
    for (const l of layers) {
      l.class_of_business_ids = cobsByLayer[l.layer_id] || [];
    }
  }

  res.json({
    detail: detailR.rows[0] || null,
    layers,
    terms: termsR.rows[0]?.terms || {},
    cob_underwriting_limits: cobLimitsR.rows.map(r => ({
      cob_id: String(r.class_of_business_id),
      limit_amount: r.limit_amount,
    })),
    // Authoritative live status — always drives the approval workflow, never from JSONB
    uw_status: contractR.rows[0]?.uw_status || contractR.rows[0]?.status || null,
    offer_status: offerR.rows[0]?.offer_status || null,
    offer_approver: offerR.rows[0]?.next_approver || null,
    updated_at: contractR.rows[0]?.updated_at || null,
    // Authoritative contract header (uw year range + country) so the premiums/
    // inflation screen can resolve its UW-year range and country directly from
    // this payload, without depending on a separate getContract call succeeding.
    contract_header: contractR.rows[0]
      ? {
          uw_year: contractR.rows[0].uw_year,
          inception_date: contractR.rows[0].inception_date,
          renewal_date: contractR.rows[0].renewal_date,
          country_id: contractR.rows[0].country_id,
          country_name: contractR.rows[0].country_name,
        }
      : null,
  });
}));

// ── POST /api/treaties/:id/non-prop/save ──
// PARTIAL-SAVE SAFE: only updates sections that are explicitly provided.
// Now also saves:
//   - contract_np_layer_class_of_business  (COB participation per layer)
//   - contract_underwriting_limit           (UW limit per COB)
router.post("/treaties/:id/non-prop/save", ...npTreatyGuard, validateBody(npSaveSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;
  const {detail, layers, terms, cob_underwriting_limits} = req.body;
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertParentEntityUnchanged(cl, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id,
      ifUnmodifiedSince: req.headers['if-unmodified-since'],
    });

    // ── Upsert NP details ──
    if (detail && Object.keys(detail).length > 0) {
      await cl.query(
        `INSERT INTO public.contract_np_details
           (contract_id,number_of_layers,expiring_number_of_layers,deductible,max_retention,accounting_method,xl_type,accounts,
            brokerage_pct,taxes_pct,no_claims_bonus_pct,profit_commission_pct,est_gnpi,adjustment_rate,deposit_premium,experience_start_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (contract_id) DO UPDATE SET
           number_of_layers=COALESCE(EXCLUDED.number_of_layers,contract_np_details.number_of_layers),
           expiring_number_of_layers=COALESCE(EXCLUDED.expiring_number_of_layers,contract_np_details.expiring_number_of_layers),
           deductible=COALESCE(EXCLUDED.deductible,contract_np_details.deductible),
           max_retention=COALESCE(EXCLUDED.max_retention,contract_np_details.max_retention),
           accounting_method=COALESCE(EXCLUDED.accounting_method,contract_np_details.accounting_method),
           xl_type=COALESCE(EXCLUDED.xl_type,contract_np_details.xl_type),
           accounts=COALESCE(EXCLUDED.accounts,contract_np_details.accounts),
           brokerage_pct=COALESCE(EXCLUDED.brokerage_pct,contract_np_details.brokerage_pct),
           taxes_pct=COALESCE(EXCLUDED.taxes_pct,contract_np_details.taxes_pct),
           no_claims_bonus_pct=COALESCE(EXCLUDED.no_claims_bonus_pct,contract_np_details.no_claims_bonus_pct),
           profit_commission_pct=COALESCE(EXCLUDED.profit_commission_pct,contract_np_details.profit_commission_pct),
           est_gnpi=COALESCE(EXCLUDED.est_gnpi,contract_np_details.est_gnpi),
           adjustment_rate=COALESCE(EXCLUDED.adjustment_rate,contract_np_details.adjustment_rate),
           deposit_premium=COALESCE(EXCLUDED.deposit_premium,contract_np_details.deposit_premium),
           experience_start_year=COALESCE(EXCLUDED.experience_start_year,contract_np_details.experience_start_year),
           updated_at=now()`,
        [id, numOrNull(detail.number_of_layers)||1, numOrNull(detail.expiring_number_of_layers),
         numOrNull(detail.deductible), numOrNull(detail.max_retention),
         detail.accounting_method||null, detail.xl_type||null, detail.accounts||null,
         numOrNull(detail.brokerage_pct), numOrNull(detail.taxes_pct),
         numOrNull(detail.no_claims_bonus_pct), numOrNull(detail.profit_commission_pct),
         numOrNull(detail.est_gnpi), numOrNull(detail.adjustment_rate), numOrNull(detail.deposit_premium),
         numOrNull(detail.experience_start_year??detail.experienceStartYear)]
      );
    }

    // ── Replace layers + their COB participation ──
    if (Array.isArray(layers) && layers.length > 0) {
      // Delete old layer COB links first (FK cascade would handle this, but be explicit)
      const oldLayersR = await cl.query(
        `SELECT layer_id FROM public.contract_np_layers WHERE contract_id=$1`, [id]
      );
      if (oldLayersR.rows.length > 0) {
        const oldIds = oldLayersR.rows.map(r => r.layer_id);
        await cl.query(
          `DELETE FROM public.contract_np_layer_class_of_business WHERE layer_id = ANY($1)`, [oldIds]
        );
      }
      await cl.query(`DELETE FROM public.contract_np_layers WHERE contract_id=$1`, [id]);

      for (const l of layers) {
        // Insert layer, get back its layer_id
        const ins = await cl.query(
          `INSERT INTO public.contract_np_layers
             (contract_id,layer_number,attachment,layer_limit,aggregate_limit,egnpi,earned_premium,
              rate,rol,num_reinstatements,reinstatement_pct,annual_agg_deductible,peril_scope,mdp,mdp_pct,
              hist_margin,modelled_margin,tech_ratio,uw_price,expiring_price,lead_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING layer_id`,
          [id, l.layer_number,
           numOrNull(l.attachment), numOrNull(l.layer_limit), numOrNull(l.aggregate_limit),
           numOrNull(l.egnpi), numOrNull(l.earned_premium),
           numOrNull(l.rate), numOrNull(l.rol),
           reinstatInt(l.num_reinstatements), numOrNull(l.reinstatement_pct),
           numOrNull(l.annual_agg_deductible),
           l.peril_scope || 'BOTH',
           numOrNull(l.mdp), numOrNull(l.mdp_pct),
           numOrNull(l.hist_margin), numOrNull(l.modelled_margin), numOrNull(l.tech_ratio),
           numOrNull(l.uw_price), numOrNull(l.expiring_price), numOrNull(l.lead_price)]
        );
        const layerId = ins.rows[0].layer_id;

        // Insert COB participation for this layer
        const cobIds = Array.isArray(l.class_of_business_ids) ? l.class_of_business_ids : [];
        for (const cobId of cobIds) {
          if (cobId) {
            await cl.query(
              `INSERT INTO public.contract_np_layer_class_of_business (layer_id, class_of_business_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [layerId, cobId]
            );
          }
        }
      }
    }

    // ── Save COB underwriting limits ──
    // These go into contract_underwriting_limit (shared with Prop but keyed to contract_id + cob)
    if (Array.isArray(cob_underwriting_limits) && cob_underwriting_limits.length > 0) {
      await cl.query(`DELETE FROM public.contract_underwriting_limit WHERE contract_id=$1`, [id]);
      for (const r of cob_underwriting_limits) {
        if (!r.cob_id) continue;
        await cl.query(
          `INSERT INTO public.contract_underwriting_limit (contract_id, class_of_business_id, limit_amount, basis)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (contract_id, class_of_business_id) DO UPDATE
             SET limit_amount=EXCLUDED.limit_amount, updated_at=now()`,
          [id, r.cob_id, numOrNull(r.limit_amount) ?? 0, 'COMBINED']
        );
      }
    }

    // ── MERGE terms JSONB ──
    if (terms && Object.keys(terms).length > 0) {
      await cl.query(
        `INSERT INTO public.contract_np_terms (contract_id, terms) VALUES ($1, $2::jsonb)
         ON CONFLICT (contract_id) DO UPDATE
           SET terms=contract_np_terms.terms || $2::jsonb, updated_at=now()`,
        [id, JSON.stringify(terms)]
      );
    }

    const updatedAt = await touchParentEntity(cl, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id,
    });
    await auditMutation(cl, req, { entityType: 'CONTRACT', entityId: id, eventType: 'NP_SAVED', payload: { layer_count: Array.isArray(layers) ? layers.length : 0 } });
    await cl.query("COMMIT");
    res.json({ok: true, updated_at: updatedAt});
  } catch(e) {
    await cl.query("ROLLBACK").catch(()=>{});
    throw e;
  } finally {
    cl.release();
  }
}));

// ── EGNPI Year ──
router.get("/treaties/:id/np/egnpi-year", ...npTreatyGuard, asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.contract_np_egnpi_year WHERE contract_id=$1 ORDER BY uw_year`,[req.params.id]);
  res.json(rows);
}));
router.put("/treaties/:id/np/egnpi-year", ...npTreatyGuard, validateBody(egnpiYearPutSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const inputRows=req.body.rows??[];const cl=await pool.connect();
  try{await cl.query("BEGIN");
  await assertExists(cl, 'public.contract', 'contract_id', id, 'Contract');
  await assertParentEntityUnchanged(cl, { parentTable: 'contract', idColumn: 'contract_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
  await cl.query(`DELETE FROM public.contract_np_egnpi_year WHERE contract_id=$1`,[id]);
  const egnpiInsert = buildBatchInsert({
    table: 'public.contract_np_egnpi_year',
    columns: ['contract_id','uw_year','egnpi','inflation_pct','rate_change_pct'],
    rows: inputRows.map((r) => [r.uw_year, numOrNull(r.egnpi), numOrNull(r.inflation_pct), numOrNull(r.rate_change_pct)]),
    leadingId: id,
  });
  if (egnpiInsert) await cl.query(egnpiInsert.sql, egnpiInsert.params);
  // Propagate latest year's EGNPI as est_gnpi on contract_np_details (used for region premium aggregation)
  const sortedRows = [...inputRows].filter(r => r.egnpi != null).sort((a,b) => (b.uw_year||0)-(a.uw_year||0));
  if (sortedRows.length > 0) {
    await cl.query(
      `INSERT INTO public.contract_np_details (contract_id, number_of_layers, est_gnpi)
       VALUES ($1, 1, $2)
       ON CONFLICT (contract_id) DO UPDATE SET est_gnpi=EXCLUDED.est_gnpi, updated_at=now()`,
      [id, numOrNull(sortedRows[0].egnpi)]
    );
  }
  const updatedAt = await touchParentEntity(cl, { parentTable: 'contract', idColumn: 'contract_id', id });
  await auditMutation(cl, req, { entityType: 'CONTRACT', entityId: id, eventType: 'NP_EGNPI_SAVED', payload: { row_count: Array.isArray(inputRows) ? inputRows.length : 0 } });
  await cl.query("COMMIT");res.json({ok:true, updated_at: updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── NP Pricing ──
router.get("/treaties/:id/np-pricing", ...npTreatyGuard, asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [inputsR,layerInputsR,outputsR]=await Promise.all([
    pool.query(`SELECT * FROM public.contract_np_pricing_inputs WHERE contract_id=$1`,[id]),
    pool.query(`SELECT * FROM public.contract_np_pricing_layer_inputs WHERE contract_id=$1 ORDER BY layer_number`,[id]),
    pool.query(`SELECT * FROM public.contract_np_pricing_outputs WHERE contract_id=$1 ORDER BY layer_number,section`,[id]),
  ]);
  res.json({inputs:inputsR.rows[0]||null,layer_inputs:layerInputsR.rows,outputs:outputsR.rows});
}));
router.put("/treaties/:id/np-pricing", ...npTreatyGuard, validateBody(npPricingPutSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;
  const {inputs, layer_inputs=[], outputs=[], layer_margins=[]} = req.body;

  // Spot-check client-submitted outputs against the canonical shared math.
  // Always adds an X-Pricing-Drift-Count header so dashboards can graph
  // drift rate over time; strict mode rejects the save with 422.
  const drifts = verifyNpPricingOutputs(outputs);
  res.setHeader('X-Pricing-Drift-Count', String(drifts.length));
  const driftStats = pricingDriftStats(drifts);
  recordPricingDrift({ endpoint: 'np_layer_pricing', stats: driftStats, strict: isStrictMode() });
  const driftLog = {
    requestId: res.locals.requestId || req.id || null,
    endpoint: 'np_layer_pricing',
    route: 'PUT /api/treaties/:id/np-pricing',
    parentType: 'contract',
    contractId: id,
    ...driftStats,
    summary: summariseDrifts(drifts),
    ...(drifts.length > 0 ? { drifts: drifts.slice(0, 10) } : {}),
  };
  if (drifts.length > 0) {
    logger.warn('pricing drift check', driftLog);
    if (isStrictMode()) {
      return res.status(422).json({
        error: 'Pricing outputs failed server-side spot check',
        code:  'PRICING_DRIFT',
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
      parentTable: 'contract',
      idColumn: 'contract_id',
      id,
      ifUnmodifiedSince: req.headers['if-unmodified-since'],
    });
    if(inputs) await cl.query(
      `INSERT INTO public.contract_np_pricing_inputs (contract_id,burn_weight_pct,exposure_weight_pct,pareto_weight_pct,pricing_loading_pct,swiss_re_curve_name)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contract_id) DO UPDATE SET
         burn_weight_pct=EXCLUDED.burn_weight_pct,exposure_weight_pct=EXCLUDED.exposure_weight_pct,
         pareto_weight_pct=EXCLUDED.pareto_weight_pct,
         pricing_loading_pct=EXCLUDED.pricing_loading_pct,swiss_re_curve_name=EXCLUDED.swiss_re_curve_name,updated_at=now()`,
      [id,numOrNull(inputs.burn_weight_pct),numOrNull(inputs.exposure_weight_pct),numOrNull(inputs.pareto_weight_pct),numOrNull(inputs.pricing_loading_pct),inputs.swiss_re_curve_name||null]);
    await cl.query(`DELETE FROM public.contract_np_pricing_layer_inputs WHERE contract_id=$1`,[id]);
    const layerInputsInsert = buildBatchInsert({
      table: 'public.contract_np_pricing_layer_inputs',
      columns: ['contract_id','layer_number','expiring_pricing_pct'],
      rows: layer_inputs.map((li) => [li.layer_number, numOrNull(li.expiring_pricing_pct)]),
      leadingId: id,
    });
    if (layerInputsInsert) await cl.query(layerInputsInsert.sql, layerInputsInsert.params);
    await cl.query(`DELETE FROM public.contract_np_pricing_outputs WHERE contract_id=$1`,[id]);
    const outputsInsert = buildBatchInsert({
      table: 'public.contract_np_pricing_outputs',
      columns: ['contract_id','layer_number','section','pure_burning_cost','pareto_pricing','burn_plus_pareto','exposure_rating','burn_weight_pct','exposure_weight_pct','pareto_weight_pct','pricing_loading_pct','total_price','prob_attach','prob_exhaust'],
      rows: outputs.map((o) => [o.layer_number, o.section, numOrNull(o.pure_burning_cost), numOrNull(o.pareto_pricing), numOrNull(o.burn_plus_pareto), numOrNull(o.exposure_rating), numOrNull(o.burn_weight_pct), numOrNull(o.exposure_weight_pct), numOrNull(o.pareto_weight_pct), numOrNull(o.pricing_loading_pct), numOrNull(o.total_price), numOrNull(o.prob_attach), numOrNull(o.prob_exhaust)]),
      leadingId: id,
    });
    if (outputsInsert) await cl.query(outputsInsert.sql, outputsInsert.params);
    // ── Update per-layer margin columns on contract_np_layers (safe: no-op if columns absent)
    // hist_margin     = HIST. MARGIN (actual/historical) → actual_margin in cedant summary
    // modelled_margin = MARGIN (modelled: (expiring-reinsurer)/expiring) → actuarial_margin
    // SUMPRODUCT(ep * hist_margin) / SUM(ep)     = weighted actual_margin
    // SUMPRODUCT(ep * modelled_margin) / SUM(ep) = weighted actuarial_margin
    // Direct assignment, not COALESCE: NpFinalPricing sends every row
    // with every field, so a NULL here means the user cleared the cell
    // and the DB should clear it too. COALESCE used to silently drop
    // deletions because NULL on the wire was treated as "preserve".
    for(const m of layer_margins) {
      await cl.query(
        `UPDATE public.contract_np_layers
            SET hist_margin     = $3,
                modelled_margin = $4,
                tech_ratio      = $5,
                uw_price        = $6,
                expiring_price  = $7,
                lead_price      = $8,
                updated_at      = now()
          WHERE contract_id = $1 AND layer_number = $2`,
        [id, m.layer_number,
         numOrNull(m.hist_margin), numOrNull(m.modelled_margin), numOrNull(m.tech_ratio),
         numOrNull(m.uw_price), numOrNull(m.expiring_price), numOrNull(m.lead_price)]
      ).catch(() => {}); // silent — columns may not exist pre-migration 052
    }
    const updatedAt = await touchParentEntity(cl, {
      parentTable: 'contract',
      idColumn: 'contract_id',
      id,
    });
    await auditMutation(cl, req, { entityType: 'CONTRACT', entityId: id, eventType: 'NP_PRICING_SAVED', payload: { output_count: Array.isArray(outputs) ? outputs.length : 0, drift_count: drifts.length } });
    await cl.query("COMMIT");
    res.json({ok:true, updated_at: updatedAt});
  } catch(e) { await cl.query("ROLLBACK").catch(()=>{}); throw e; }
  finally { cl.release(); }
}));

// ── NP Expiring Structure ──
// Quote aliases — same handler, isQuote forced true
router.get("/quotes/:id/np/expiring",  ...npQuoteGuard, asyncHandler(async (req, res) => { req.query.quote = 'true'; req.params = { id: req.params.id }; return npExpiringGet(req, res); }));
router.put("/quotes/:id/np/expiring",   ...npQuoteGuard, validateBody(npExpiringPutSchema), asyncHandler(async (req, res) => { req.query.quote = 'true'; return npExpiringPut(req, res); }));
router.get("/treaties/:id/np/expiring", ...npTreatyGuard, asyncHandler(async (req, res) => { return npExpiringGet(req, res); }));
router.put("/treaties/:id/np/expiring", ...npTreatyGuard, validateBody(npExpiringPutSchema), asyncHandler(async (req, res) => { return npExpiringPut(req, res); }));

async function npExpiringGet(req, res) {
  const { id } = req.params;
  const ctx = entityContext(req);
  const tbl = ctx.npTable('expiring');        // quote_np_expiring or contract_np_expiring
  const col = ctx.idColumn;                   // quote_id or contract_id

  // Renewal auto-populate is a soft enhancement — if the parent_contract_id
  // lookup fails (e.g. legacy row without the column), treat as non-renewal
  // and continue. We do NOT wrap the saved-data load in a catch: if THAT
  // fails the client must see a 5xx so it can refuse to clobber with an
  // empty save, otherwise transient errors would silently wipe the row.
  let parentContractId = null;
  // Parent table's updated_at drives optimistic locking on the save
  // endpoint (touchParentEntity returns it; NpExpiringStructure uses it
  // as the If-Unmodified-Since baseline). Fetch it alongside the
  // renewal seed so a single round-trip covers both.
  let parentUpdatedAt = null;
  try {
    const contractRow = await pool.query(
      `SELECT parent_contract_id, updated_at FROM public.${ctx.parentTable} WHERE ${ctx.idColumn} = $1`,
      [id],
    );
    parentContractId = contractRow.rows[0]?.parent_contract_id || null;
    parentUpdatedAt = contractRow.rows[0]?.updated_at || null;
  } catch (err) {
    logger.warn('np expiring: parent lookup failed; continuing without renewal seed', {
      id, err: err.message,
    });
  }

  // Load saved expiring data (may be empty for a brand-new renewal)
  const [layersR, termsR] = await Promise.all([
    pool.query(`SELECT * FROM public.${tbl}_layers WHERE ${col}=$1 ORDER BY layer_number`, [id]),
    pool.query(`SELECT * FROM public.${tbl}_terms  WHERE ${col}=$1`, [id]),
  ]);

  // Filter out null-only rows (created by accidental empty saves) — treat as no data
  let layers = layersR.rows.filter(l =>
    l.layer_limit != null || l.attachment != null || l.egnpi != null ||
    l.rate != null || l.earned_premium != null
  );
  let terms  = termsR.rows[0] || null;
  let autoPopulated = false;

  // If renewal AND no saved expiring data yet → pull from parent contract's live NP structure
  if (parentContractId && layers.length === 0 && !terms) {
    const [parentLayersR, parentDetailR, parentTermsR] = await Promise.all([
      pool.query(
        `SELECT * FROM public.contract_np_layers WHERE contract_id=$1 ORDER BY layer_number`,
        [parentContractId]
      ),
      pool.query(
        `SELECT * FROM public.contract_np_details WHERE contract_id=$1`,
        [parentContractId]
      ),
      pool.query(
        `SELECT * FROM public.contract_np_terms WHERE contract_id=$1`,
        [parentContractId]
      ),
    ]);
    layers = parentLayersR.rows.map(l => ({
      layer_number:         l.layer_number,
      attachment:           l.attachment,
      layer_limit:          l.layer_limit,
      aggregate_limit:      l.aggregate_limit,
      egnpi:                l.egnpi,
      earned_premium:       l.earned_premium,
      rate:                 l.rate,
      rol:                  l.rol,
      num_reinstatements:   l.num_reinstatements,
      reinstatement_pct:    l.reinstatement_pct,
      annual_agg_deductible:l.annual_agg_deductible,
      peril_scope:          l.peril_scope || 'BOTH',
      mdp:                  l.mdp,
      mdp_pct:              l.mdp_pct,
      _auto: true,
    }));
    const pd = parentDetailR.rows[0] || {};
    const pt = parentTermsR.rows[0]?.terms?.treaty_detail || {};
    terms = {
      egnpi:                  pd.est_gnpi   || pt.estGnpi   || null,
      deductible:             pd.deductible || pt.deductible || null,
      risk_limit: layers.filter(l => l.peril_scope === 'RISK' || l.peril_scope === 'BOTH')
                        .reduce((s, l) => s + (parseFloat(l.layer_limit) || 0), 0) || null,
      cat_limit:  layers.filter(l => l.peril_scope === 'CAT' || l.peril_scope === 'BOTH')
                        .reduce((s, l) => s + (parseFloat(l.layer_limit) || 0), 0) || null,
      brokerage_pct:           pd.brokerage_pct           || null,
      no_claims_bonus_pct:     pd.no_claims_bonus_pct     || null,
      profit_commission_pct:   pd.profit_commission_pct   || null,
      _auto: true,
    };
    autoPopulated = true;
  }

  res.json({ layers, terms, coveredProps: termsR.rows[0]?.covered_props || [], autoPopulated, isRenewal: !!parentContractId, parentContractId, updated_at: parentUpdatedAt });
}

async function npExpiringPut(req, res) {
  const { id } = req.params;
  const ctx = entityContext(req);
  const tbl = ctx.npTable('expiring');
  const col = ctx.idColumn;
  const { layers = [], terms = {}, coveredProps } = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertParentEntityUnchanged(cl, {
      parentTable: ctx.parentTable,
      idColumn: ctx.idColumn,
      id,
      ifUnmodifiedSince: req.headers['if-unmodified-since'],
    });
    // Layers — upsert each
    await cl.query(`DELETE FROM public.${tbl}_layers WHERE ${col}=$1`, [id]);
    for (const l of layers) {
      await cl.query(
        `INSERT INTO public.${tbl}_layers
          (${col},layer_number,attachment,layer_limit,aggregate_limit,egnpi,earned_premium,
           rate,rol,num_reinstatements,reinstatement_pct,annual_agg_deductible,peril_scope,mdp,mdp_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (${col},layer_number) DO UPDATE SET
           attachment=EXCLUDED.attachment, layer_limit=EXCLUDED.layer_limit,
           aggregate_limit=EXCLUDED.aggregate_limit, egnpi=EXCLUDED.egnpi,
           earned_premium=EXCLUDED.earned_premium, rate=EXCLUDED.rate, rol=EXCLUDED.rol,
           num_reinstatements=EXCLUDED.num_reinstatements, reinstatement_pct=EXCLUDED.reinstatement_pct,
           annual_agg_deductible=EXCLUDED.annual_agg_deductible, peril_scope=EXCLUDED.peril_scope,
           mdp=EXCLUDED.mdp, mdp_pct=EXCLUDED.mdp_pct, updated_at=now()`,
        [id, l.layer_number,
         numOrNull(l.attachment), numOrNull(l.layer_limit), numOrNull(l.aggregate_limit),
         numOrNull(l.egnpi), numOrNull(l.earned_premium), numOrNull(l.rate), numOrNull(l.rol),
         l.num_reinstatements ? parseInt(l.num_reinstatements) : null,
         numOrNull(l.reinstatement_pct), numOrNull(l.annual_agg_deductible),
         l.peril_scope || 'BOTH', numOrNull(l.mdp), numOrNull(l.mdp_pct)]
      );
    }
    // Terms — upsert.
    // covered_props is owned by NpStructure / NpExpiringStructure; other
    // savers (e.g. NpFinalPricing) omit it. Treat key absence as
    // "preserve" — pass NULL and COALESCE with the existing row on
    // conflict — so absence doesn't wipe the column. An explicit `[]`
    // in the body still clears it (the JSON.stringify is non-null).
    const coveredPropsParam = 'coveredProps' in req.body ? JSON.stringify(coveredProps) : null;
    await cl.query(
      `INSERT INTO public.${tbl}_terms
        (${col},egnpi,deductible,risk_limit,cat_limit,brokerage_pct,no_claims_bonus_pct,profit_commission_pct,notes,covered_props)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (${col}) DO UPDATE SET
         egnpi=EXCLUDED.egnpi, deductible=EXCLUDED.deductible, risk_limit=EXCLUDED.risk_limit,
         cat_limit=EXCLUDED.cat_limit, brokerage_pct=EXCLUDED.brokerage_pct,
         no_claims_bonus_pct=EXCLUDED.no_claims_bonus_pct, profit_commission_pct=EXCLUDED.profit_commission_pct,
         notes=EXCLUDED.notes,
         covered_props=COALESCE(EXCLUDED.covered_props, ${tbl}_terms.covered_props),
         updated_at=now()`,
      [id, numOrNull(terms.egnpi), numOrNull(terms.deductible),
       numOrNull(terms.risk_limit), numOrNull(terms.cat_limit),
       numOrNull(terms.brokerage_pct), numOrNull(terms.no_claims_bonus_pct),
       numOrNull(terms.profit_commission_pct), terms.notes || null,
       coveredPropsParam]
    );
    const updatedAt = await touchParentEntity(cl, {
      parentTable: ctx.parentTable,
      idColumn: ctx.idColumn,
      id,
    });
    await auditMutation(cl, req, { entityType: ctx.isQuote ? 'QUOTE' : 'CONTRACT', entityId: id, eventType: 'NP_EXPIRING_SAVED', payload: { layer_count: Array.isArray(layers) ? layers.length : 0 } });
    await cl.query('COMMIT');
    res.json({ ok: true, updated_at: updatedAt });
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  }
  finally { cl.release(); }
}

// ── Swiss Re Curves ──
router.get("/ref/swiss-re-curves", asyncHandler(async (_req, res) => {
  const {rows}=await pool.query(`SELECT DISTINCT curve_name FROM public.ref_swiss_re_curve ORDER BY curve_name`);
  res.json(rows.map(r=>r.curve_name));
}));
router.get("/ref/swiss-re-curves/:name", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT x,y FROM public.ref_swiss_re_curve WHERE curve_name=$1 ORDER BY x`,[req.params.name]);
  res.json(rows);
}));

// ── Cedant Programme Limits — other NP contracts for same cedant + overlapping COBs ──
// Returns sum of structure limits × share per overlapping contract (excluding current contract).
// Used by Programme Limits table → Cedant Total Limit column.
router.get("/treaties/:id/cedant-programme-limits", asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Get current contract's cedant and COBs. For NP accumulation we scope by
  //    the programme's LAYER-level COBs (the classes its layers actually
  //    expose), which can differ from the contract-level COB list; fall back to
  //    contract-level COBs when no layer COBs are recorded.
  const contractR = await pool.query(
    `SELECT c.cedant_id,
            array_agg(DISTINCT ccb.class_of_business_id) FILTER (WHERE ccb.class_of_business_id IS NOT NULL) AS contract_cob_ids,
            array_agg(DISTINCT lc.class_of_business_id)  FILTER (WHERE lc.class_of_business_id  IS NOT NULL) AS layer_cob_ids
     FROM public.contract c
     LEFT JOIN public.contract_class_of_business ccb ON ccb.contract_id = c.contract_id
     LEFT JOIN public.contract_np_layers l           ON l.contract_id = c.contract_id
     LEFT JOIN public.contract_np_layer_class_of_business lc ON lc.layer_id = l.layer_id
     WHERE c.contract_id = $1
     GROUP BY c.cedant_id`, [id]
  );
  if (!contractR.rows.length || !contractR.rows[0].cedant_id) {
    return res.json({ contracts: [], totalLimit: 0, cedantId: null });
  }
  const { cedant_id, contract_cob_ids, layer_cob_ids } = contractR.rows[0];
  const layerCobs = (layer_cob_ids || []).filter(Boolean);
  const contractCobs = (contract_cob_ids || []).filter(Boolean);
  const cobIds = layerCobs.length ? layerCobs : contractCobs;

  // 2. Introspect class_of_business PK column name (live DB may differ from dump)
  const cobColRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='class_of_business' ORDER BY ordinal_position`
  );
  const cobCols = cobColRes.rows.map(r => r.column_name);
  const cobIdCol   = cobCols.find(c => c === 'class_of_business_id') || cobCols.find(c => c.endsWith('_id')) || cobCols[0];
  const cobNameCol = cobCols.find(c => c === 'class_of_business') || cobCols.find(c => c.includes('name')) || cobCols[1] || cobCols[0];

  // Find ALL active NP contracts for the same cedant that expose at least one
  // in-scope COB, accumulating per LAYER by the layer's own COBs. When a
  // contract's layers carry no COBs (legacy/unset), fall back to summing all
  // its layers and matching on contract-level COBs so nothing is dropped.
  const otherR = await pool.query(
    `SELECT
       c.contract_id,
       c.uw_year,
       c.uw_status,
       c.signed_line_pct,
       COALESCE(
         (SELECT string_agg(DISTINCT cob.${cobNameCol}, ', ' ORDER BY cob.${cobNameCol})
            FROM public.contract_np_layers l
            JOIN public.contract_np_layer_class_of_business lc ON lc.layer_id = l.layer_id
            JOIN public.class_of_business cob ON cob.${cobIdCol} = lc.class_of_business_id
           WHERE l.contract_id = c.contract_id
             AND (NOT sc.has_scope OR lc.class_of_business_id = ANY(sc.cobs))),
         (SELECT string_agg(DISTINCT cob.${cobNameCol}, ', ' ORDER BY cob.${cobNameCol})
            FROM public.contract_class_of_business ccb
            JOIN public.class_of_business cob ON cob.${cobIdCol} = ccb.class_of_business_id
           WHERE ccb.contract_id = c.contract_id)
       )                                                                          AS cob_names,
       CASE WHEN COALESCE(lim.has_any_layer_cob, false)
            THEN lim.match_layer_limit
            ELSE lim.all_layer_limit END                                          AS total_structure_limit,
       COALESCE(c.signed_line_pct,
         (SELECT o.written_line_pct
          FROM public.contract_offer o
          WHERE o.contract_id = c.contract_id
          ORDER BY o.updated_at DESC LIMIT 1)
       )                                                                          AS effective_line_pct
     FROM public.contract c
     CROSS JOIN (SELECT $2::uuid[] AS cobs,
                        ($2::uuid[] IS NOT NULL AND array_length($2::uuid[], 1) > 0) AS has_scope) sc
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(ml.layer_limit) FILTER (WHERE ml.matches), 0) AS match_layer_limit,
         COALESCE(SUM(ml.layer_limit), 0)                           AS all_layer_limit,
         bool_or(ml.has_cob)                                        AS has_any_layer_cob
       FROM (
         SELECT
           l.layer_id,
           l.layer_limit,
           EXISTS (SELECT 1 FROM public.contract_np_layer_class_of_business lc
                    WHERE lc.layer_id = l.layer_id) AS has_cob,
           EXISTS (SELECT 1 FROM public.contract_np_layer_class_of_business lc
                    WHERE lc.layer_id = l.layer_id
                      AND (NOT sc.has_scope OR lc.class_of_business_id = ANY(sc.cobs))) AS matches
         FROM public.contract_np_layers l
         WHERE l.contract_id = c.contract_id
       ) ml
     ) lim ON TRUE
     WHERE c.cedant_id = $1
       AND c.uw_status NOT IN ('DECLINED','NTU')
       AND (
         (COALESCE(lim.has_any_layer_cob, false) AND lim.match_layer_limit IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.contract_np_layers l
            JOIN public.contract_np_layer_class_of_business lc ON lc.layer_id = l.layer_id
            WHERE l.contract_id = c.contract_id
              AND (NOT sc.has_scope OR lc.class_of_business_id = ANY(sc.cobs))))
         OR (NOT COALESCE(lim.has_any_layer_cob, false)
             AND (NOT sc.has_scope
                  OR EXISTS (SELECT 1 FROM public.contract_class_of_business x
                              WHERE x.contract_id = c.contract_id
                                AND x.class_of_business_id = ANY(sc.cobs))))
       )
     ORDER BY c.uw_year DESC`,
    [cedant_id, cobIds.length ? cobIds : null]
  );

  // 3. For each contract: effective_limit = effective_line_pct/100 × total_structure_limit
  //    Sum across all matching contracts (including current) = total cedant limit
  const contracts = otherR.rows.map(r => {
    const structLimit  = parseFloat(r.total_structure_limit) || 0;
    const linePct      = parseFloat(r.effective_line_pct)    || 0;
    const effectiveLimit = linePct > 0 ? Math.round(structLimit * linePct / 100) : structLimit;
    return {
      contract_id:     r.contract_id,
      uw_year:         r.uw_year,
      uw_status:       r.uw_status,
      cob_names:       r.cob_names,
      total_structure_limit: structLimit,
      effective_line_pct:    linePct,
      effective_limit:       effectiveLimit,
      is_current:            r.contract_id === id,
    };
  });

  // totalLimit = sum of all effective limits across all matching contracts
  const totalLimit = contracts.reduce((s, r) => s + r.effective_limit, 0);

  res.json({ contracts, totalLimit, cedantId: cedant_id });
}));

// ── NP Excess LDF Factors ──────────────────────────────────────────────────
// GET: returns chosen LDF/CDF factors for the NP excess layer
// Used by NpFinalPricing to compute developed ultimate excess losses
router.get("/treaties/:id/np/excess-ldfs", ...npTreatyGuard, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM public.contract_np_excess_ldf WHERE contract_id=$1 ORDER BY dev_month`,
    [id]
  );
  res.json(rows);
}));
router.get("/quotes/:id/np/excess-ldfs", ...npQuoteGuard, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM public.quote_np_excess_ldf WHERE quote_id=$1 ORDER BY dev_month`,
    [id]
  );
  res.json(rows);
}));

// PUT: save chosen factors (called by NpExcessDevFactors saveDevFactors path
//      AND directly here for a clean dedicated endpoint)
router.put("/treaties/:id/np/excess-ldfs", ...npTreatyGuard, validateBody(excessLdfsPutSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { factors = [], tail_factor = 1.0 } = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertExists(cl, 'public.contract', 'contract_id', id, 'Contract');
    await assertParentEntityUnchanged(cl, { parentTable: 'contract', idColumn: 'contract_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(`DELETE FROM public.contract_np_excess_ldf WHERE contract_id=$1`, [id]);
    for (const f of factors) {
      await cl.query(
        `INSERT INTO public.contract_np_excess_ldf
           (contract_id, dev_month, chosen_source, chosen_ldf, chosen_cdf,
            actual_ldf, actual_cdf, param_ldf, param_cdf, tail_factor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, f.dev_month, f.chosen_source || null,
         numOrNull(f.chosen_ldf), numOrNull(f.chosen_cdf),
         numOrNull(f.actual_ldf), numOrNull(f.actual_cdf),
         numOrNull(f.param_ldf ?? f.parametrized_ldf), numOrNull(f.param_cdf ?? f.parametrized_cdf),
         numOrNull(tail_factor) ?? 1.0]
      );
    }
    const updatedAt = await touchParentEntity(cl, { parentTable: 'contract', idColumn: 'contract_id', id });
    await auditMutation(cl, req, { entityType: 'CONTRACT', entityId: id, eventType: 'NP_EXCESS_LDFS_SAVED', payload: { factor_count: Array.isArray(factors) ? factors.length : 0 } });
    await cl.query('COMMIT');
    res.json({ ok: true, updated_at: updatedAt });
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cl.release(); }
}));
router.put("/quotes/:id/np/excess-ldfs", ...npQuoteGuard, validateBody(excessLdfsPutSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { factors = [], tail_factor = 1.0 } = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
    await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(`DELETE FROM public.quote_np_excess_ldf WHERE quote_id=$1`, [id]);
    for (const f of factors) {
      await cl.query(
        `INSERT INTO public.quote_np_excess_ldf
           (quote_id, dev_month, chosen_source, chosen_ldf, chosen_cdf,
            actual_ldf, actual_cdf, param_ldf, param_cdf, tail_factor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, f.dev_month, f.chosen_source || null,
         numOrNull(f.chosen_ldf), numOrNull(f.chosen_cdf),
         numOrNull(f.actual_ldf), numOrNull(f.actual_cdf),
         numOrNull(f.param_ldf ?? f.parametrized_ldf), numOrNull(f.param_cdf ?? f.parametrized_cdf),
         numOrNull(tail_factor) ?? 1.0]
      );
    }
    const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
    await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: 'NP_EXCESS_LDFS_SAVED', payload: { factor_count: Array.isArray(factors) ? factors.length : 0 } });
    await cl.query('COMMIT');
    res.json({ ok: true, updated_at: updatedAt });
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cl.release(); }
}));

// ── NP Large Loss / Cat Loss LDF Factors ────────────────────────────────────
// Generic handler factory — used for both loss types
function makeLossLdfRoutes(lossType) {
  const contractTbl  = `contract_np_${lossType}_ldf`;
  const quoteTbl     = `quote_np_${lossType}_ldf`;
  const contractUlt  = `contract_np_${lossType}_ultimate`;
  const quoteUlt     = `quote_np_${lossType}_ultimate`;
  const path         = lossType.replace('_loss', '-loss'); // large_loss → large-loss

  // GET LDFs
  router.get(`/treaties/:id/np/${path}-ldfs`, ...npTreatyGuard, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [ldfs, ults] = await Promise.all([
      pool.query(`SELECT * FROM public.${contractTbl} WHERE contract_id=$1 ORDER BY dev_month`, [id]),
      pool.query(`SELECT * FROM public.${contractUlt} WHERE contract_id=$1 ORDER BY acc_year`, [id]),
    ]);
    res.json({ ldfs: ldfs.rows, ultimates: ults.rows });
  }));

  router.get(`/quotes/:id/np/${path}-ldfs`, ...npQuoteGuard, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [ldfs, ults] = await Promise.all([
      pool.query(`SELECT * FROM public.${quoteTbl} WHERE quote_id=$1 ORDER BY dev_month`, [id]),
      pool.query(`SELECT * FROM public.${quoteUlt} WHERE quote_id=$1 ORDER BY acc_year`, [id]),
    ]);
    res.json({ ldfs: ldfs.rows, ultimates: ults.rows });
  }));

  // PUT LDFs + ultimates
  router.put(`/treaties/:id/np/${path}-ldfs`, ...npTreatyGuard, validateBody(lossLdfsPutSchema), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { ldfs = [], ultimates = [], tail_factor = 1.0 } = req.body;
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      await assertExists(cl, 'public.contract', 'contract_id', id, 'Contract');
      await assertParentEntityUnchanged(cl, { parentTable: 'contract', idColumn: 'contract_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
      await cl.query(`DELETE FROM public.${contractTbl} WHERE contract_id=$1`, [id]);
      for (const f of ldfs) {
        await cl.query(
          `INSERT INTO public.${contractTbl} (contract_id, dev_month, chosen_ldf, chosen_cdf, tail_factor)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, f.dev_month, numOrNull(f.chosen_ldf), numOrNull(f.chosen_cdf), numOrNull(tail_factor) ?? 1.0]
        );
      }
      await cl.query(`DELETE FROM public.${contractUlt} WHERE contract_id=$1`, [id]);
      for (const u of ultimates) {
        await cl.query(
          `INSERT INTO public.${contractUlt}
             (contract_id, acc_year, loss_count, reported, applied_cdf, ibnr, ultimate)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, u.year || u.acc_year, u.count || u.loss_count || 0,
           numOrNull(u.reported) ?? 0, numOrNull(u.cdf || u.applied_cdf) ?? 1.0,
           numOrNull(u.ibnr) ?? 0, numOrNull(u.ultimate) ?? 0]
        );
      }
      const updatedAt = await touchParentEntity(cl, { parentTable: 'contract', idColumn: 'contract_id', id });
      await auditMutation(cl, req, { entityType: 'CONTRACT', entityId: id, eventType: `NP_${lossType.toUpperCase()}_LDFS_SAVED`, payload: { ldf_count: Array.isArray(ldfs) ? ldfs.length : 0 } });
      await cl.query('COMMIT');
      res.json({ ok: true, updated_at: updatedAt });
    } catch (e) {
      await cl.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cl.release(); }
  }));

  router.put(`/quotes/:id/np/${path}-ldfs`, ...npQuoteGuard, validateBody(lossLdfsPutSchema), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { ldfs = [], ultimates = [], tail_factor = 1.0 } = req.body;
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      await assertExists(cl, 'public.quote', 'quote_id', id, 'Quote');
      await assertParentEntityUnchanged(cl, { parentTable: 'quote', idColumn: 'quote_id', id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
      await cl.query(`DELETE FROM public.${quoteTbl} WHERE quote_id=$1`, [id]);
      for (const f of ldfs) {
        await cl.query(
          `INSERT INTO public.${quoteTbl} (quote_id, dev_month, chosen_ldf, chosen_cdf, tail_factor)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, f.dev_month, numOrNull(f.chosen_ldf), numOrNull(f.chosen_cdf), numOrNull(tail_factor) ?? 1.0]
        );
      }
      await cl.query(`DELETE FROM public.${quoteUlt} WHERE quote_id=$1`, [id]);
      for (const u of ultimates) {
        await cl.query(
          `INSERT INTO public.${quoteUlt}
             (quote_id, acc_year, loss_count, reported, applied_cdf, ibnr, ultimate)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, u.year || u.acc_year, u.count || u.loss_count || 0,
           numOrNull(u.reported) ?? 0, numOrNull(u.cdf || u.applied_cdf) ?? 1.0,
           numOrNull(u.ibnr) ?? 0, numOrNull(u.ultimate) ?? 0]
        );
      }
      const updatedAt = await touchParentEntity(cl, { parentTable: 'quote', idColumn: 'quote_id', id });
      await auditMutation(cl, req, { entityType: 'QUOTE', entityId: id, eventType: `NP_${lossType.toUpperCase()}_LDFS_SAVED`, payload: { ldf_count: Array.isArray(ldfs) ? ldfs.length : 0 } });
      await cl.query('COMMIT');
      res.json({ ok: true, updated_at: updatedAt });
    } catch (e) {
      await cl.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cl.release(); }
  }));
}

makeLossLdfRoutes('large_loss');
makeLossLdfRoutes('cat_loss');

async function historicalPerformanceGet(req, res) {
  const ctx = entityContext(req);
  const { rows } = await pool.query(
    `SELECT uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio
     FROM public.${ctx.npTable('historical_performance')}
     WHERE ${ctx.idColumn} = $1 ORDER BY uw_year`,
    [req.params.id]
  );
  res.json(rows);
}

async function historicalPerformancePut(req, res) {
  const ctx = entityContext(req);
  const { id } = req.params;
  const inputRows = req.body.rows ?? [];
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertParentEntityUnchanged(cl, { parentTable: ctx.parentTable, idColumn: ctx.idColumn, id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(`DELETE FROM public.${ctx.npTable('historical_performance')} WHERE ${ctx.idColumn} = $1`, [id]);
    for (const r of inputRows) {
      await cl.query(
        `INSERT INTO public.${ctx.npTable('historical_performance')}
           (${ctx.idColumn}, uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, r.uw_year,
         numOrNull(r.premiums), numOrNull(r.claims), numOrNull(r.egnpi),
         numOrNull(r.result), numOrNull(r.loss_ratio),
         numOrNull(r.expense_ratio), numOrNull(r.combined_ratio)]
      );
    }
    const updatedAt = await touchParentEntity(cl, {
      parentTable: ctx.parentTable,
      idColumn: ctx.idColumn,
      id,
    });
    await auditMutation(cl, req, { entityType: ctx.isQuote ? 'QUOTE' : 'CONTRACT', entityId: id, eventType: 'NP_HISTORICAL_PERF_SAVED', payload: { row_count: Array.isArray(inputRows) ? inputRows.length : 0 } });
    await cl.query("COMMIT");
    res.json({ ok: true, updated_at: updatedAt });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; }
  finally { cl.release(); }
}

// ── GET/PUT /api/{treaties|quotes}/:id/np/historical-performance ──
router.get("/treaties/:id/np/historical-performance", ...npTreatyGuard, asyncHandler(historicalPerformanceGet));
router.get("/quotes/:id/np/historical-performance", ...npQuoteGuard, asyncHandler(historicalPerformanceGet));
router.put("/treaties/:id/np/historical-performance", ...npTreatyGuard, validateBody(historicalPerfPutSchema), asyncHandler(historicalPerformancePut));
router.put("/quotes/:id/np/historical-performance", ...npQuoteGuard, validateBody(historicalPerfPutSchema), asyncHandler(historicalPerformancePut));

// ── Stop Loss / Aggregate XL pricing ────────────────────────────────────────
// One row per contract/quote in {contract|quote}_np_stop_loss_pricing —
// inputs + outputs are JSONB. PUT is an upsert so the underwriter's
// last save is always the row that comes back on GET.
async function stopLossPricingGet(req, res) {
  const ctx = entityContext(req);
  const { rows } = await pool.query(
    `SELECT inputs, outputs, updated_at
     FROM public.${ctx.npTable('stop_loss_pricing')}
     WHERE ${ctx.idColumn} = $1`,
    [req.params.id]
  );
  if (!rows.length) {
    res.json({ inputs: {}, outputs: null });
    return;
  }
  res.json(rows[0]);
}

async function stopLossPricingPut(req, res) {
  const ctx = entityContext(req);
  const { id } = req.params;
  const inputs  = req.body?.inputs  ?? {};
  const outputs = req.body?.outputs ?? null;
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertParentEntityUnchanged(cl, { parentTable: ctx.parentTable, idColumn: ctx.idColumn, id, ifUnmodifiedSince: req.headers['if-unmodified-since'] });
    await cl.query(
      `INSERT INTO public.${ctx.npTable('stop_loss_pricing')}
         (${ctx.idColumn}, inputs, outputs)
       VALUES ($1, $2::jsonb, $3::jsonb)
       ON CONFLICT (${ctx.idColumn}) DO UPDATE
         SET inputs = EXCLUDED.inputs,
             outputs = EXCLUDED.outputs,
             updated_at = now()`,
      [id, JSON.stringify(inputs), outputs == null ? null : JSON.stringify(outputs)]
    );
    const updatedAt = await touchParentEntity(cl, {
      parentTable: ctx.parentTable,
      idColumn: ctx.idColumn,
      id,
    });
    await auditMutation(cl, req, { entityType: ctx.isQuote ? 'QUOTE' : 'CONTRACT', entityId: id, eventType: 'NP_STOP_LOSS_PRICING_SAVED' });
    await cl.query("COMMIT");
    res.json({ ok: true, updated_at: updatedAt });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; }
  finally { cl.release(); }
}

router.get("/treaties/:id/np/stop-loss-pricing", ...npTreatyGuard, asyncHandler(stopLossPricingGet));
router.get("/quotes/:id/np/stop-loss-pricing",  ...npQuoteGuard, asyncHandler(stopLossPricingGet));
router.put("/treaties/:id/np/stop-loss-pricing", ...npTreatyGuard, validateBody(stopLossPricingPutSchema), asyncHandler(stopLossPricingPut));
router.put("/quotes/:id/np/stop-loss-pricing",  ...npQuoteGuard, validateBody(stopLossPricingPutSchema), asyncHandler(stopLossPricingPut));

export default router;
