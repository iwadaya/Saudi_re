// server/src/routes/nonProp.js — Non-proportional treaty endpoints (PARTIAL-SAVE SAFE)
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, numOrNull } from '../helpers.js';
import { entityContext } from '../lib/entityContext.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../lib/parentEntityPersistence.js';
import { validateBody } from '../lib/validate.js';
import {
  npSaveSchema,
  egnpiYearPutSchema,
  npPricingPutSchema,
  npExpiringPutSchema,
  excessLdfsPutSchema,
  historicalPerfPutSchema,
} from '../validation/nonProp.js';
import { verifyNpPricingOutputs, summariseDrifts, isStrictMode, pricingDriftStats } from '../lib/pricingVerifier.js';
import { logger } from '../lib/logger.js';
const router = Router();
// "UNLIMITED" reinstatements stays null in numeric column; preserved in JSONB
function reinstatInt(v){if(String(v||'').trim().toUpperCase()==='UNLIMITED')return null;return numOrNull(v);}

// ── GET /api/treaties/:id/non-prop ──
// Returns: detail row, layers (each with their COB ids), cob UW limits, JSONB terms,
//          uw_status + offer_status from live DB (authoritative for approval workflow)
router.get("/treaties/:id/non-prop", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [detailR, layersR, termsR, cobLimitsR, contractR, offerR] = await Promise.all([
    pool.query(`SELECT * FROM public.contract_np_details WHERE contract_id=$1`, [id]),
    pool.query(`SELECT * FROM public.contract_np_layers WHERE contract_id=$1 ORDER BY layer_number`, [id]),
    pool.query(`SELECT * FROM public.contract_np_terms WHERE contract_id=$1`, [id]),
    pool.query(`SELECT class_of_business_id, limit_amount FROM public.contract_underwriting_limit WHERE contract_id=$1`, [id]),
    pool.query(`SELECT uw_status, status, updated_at FROM public.contract WHERE contract_id=$1`, [id]),
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
  });
}));

// ── POST /api/treaties/:id/non-prop/save ──
// PARTIAL-SAVE SAFE: only updates sections that are explicitly provided.
// Now also saves:
//   - contract_np_layer_class_of_business  (COB participation per layer)
//   - contract_underwriting_limit           (UW limit per COB)
router.post("/treaties/:id/non-prop/save", validateBody(npSaveSchema), asyncHandler(async (req, res) => {
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
router.get("/treaties/:id/np/egnpi-year", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.contract_np_egnpi_year WHERE contract_id=$1 ORDER BY uw_year`,[req.params.id]);
  res.json(rows);
}));
router.put("/treaties/:id/np/egnpi-year", validateBody(egnpiYearPutSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;const inputRows=req.body.rows??[];const cl=await pool.connect();
  try{await cl.query("BEGIN");await cl.query(`DELETE FROM public.contract_np_egnpi_year WHERE contract_id=$1`,[id]);
  for(const r of inputRows) await cl.query(`INSERT INTO public.contract_np_egnpi_year (contract_id,uw_year,egnpi,inflation_pct) VALUES ($1,$2,$3,$4)`,
    [id,r.uw_year,numOrNull(r.egnpi),numOrNull(r.inflation_pct)]);
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
  await cl.query("COMMIT");res.json({ok:true});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── NP Pricing ──
router.get("/treaties/:id/np-pricing", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const [inputsR,layerInputsR,outputsR]=await Promise.all([
    pool.query(`SELECT * FROM public.contract_np_pricing_inputs WHERE contract_id=$1`,[id]),
    pool.query(`SELECT * FROM public.contract_np_pricing_layer_inputs WHERE contract_id=$1 ORDER BY layer_number`,[id]),
    pool.query(`SELECT * FROM public.contract_np_pricing_outputs WHERE contract_id=$1 ORDER BY layer_number,section`,[id]),
  ]);
  res.json({inputs:inputsR.rows[0]||null,layer_inputs:layerInputsR.rows,outputs:outputsR.rows});
}));
router.put("/treaties/:id/np-pricing", validateBody(npPricingPutSchema), asyncHandler(async (req, res) => {
  const {id}=req.params;
  const {inputs, layer_inputs=[], outputs=[], layer_margins=[]} = req.body;

  // Spot-check client-submitted outputs against the canonical shared math.
  // Always adds an X-Pricing-Drift-Count header so dashboards can graph
  // drift rate over time; strict mode rejects the save with 422.
  const drifts = verifyNpPricingOutputs(outputs);
  res.setHeader('X-Pricing-Drift-Count', String(drifts.length));
  const driftStats = pricingDriftStats(drifts);
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
    for(const li of layer_inputs) await cl.query(
      `INSERT INTO public.contract_np_pricing_layer_inputs (contract_id,layer_number,expiring_pricing_pct) VALUES ($1,$2,$3)`,
      [id,li.layer_number,numOrNull(li.expiring_pricing_pct)]);
    await cl.query(`DELETE FROM public.contract_np_pricing_outputs WHERE contract_id=$1`,[id]);
    for(const o of outputs) await cl.query(
      `INSERT INTO public.contract_np_pricing_outputs (contract_id,layer_number,section,pure_burning_cost,pareto_pricing,burn_plus_pareto,exposure_rating,burn_weight_pct,exposure_weight_pct,pareto_weight_pct,pricing_loading_pct,total_price,prob_attach,prob_exhaust)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id,o.layer_number,o.section,numOrNull(o.pure_burning_cost),numOrNull(o.pareto_pricing),numOrNull(o.burn_plus_pareto),numOrNull(o.exposure_rating),numOrNull(o.burn_weight_pct),numOrNull(o.exposure_weight_pct),numOrNull(o.pareto_weight_pct),numOrNull(o.pricing_loading_pct),numOrNull(o.total_price),numOrNull(o.prob_attach),numOrNull(o.prob_exhaust)]);
    // ── Update per-layer margin columns on contract_np_layers (safe: no-op if columns absent)
    // hist_margin     = HIST. MARGIN (actual/historical) → actual_margin in cedant summary
    // modelled_margin = MARGIN (modelled: (expiring-reinsurer)/expiring) → actuarial_margin
    // SUMPRODUCT(ep * hist_margin) / SUM(ep)     = weighted actual_margin
    // SUMPRODUCT(ep * modelled_margin) / SUM(ep) = weighted actuarial_margin
    for(const m of layer_margins) {
      await cl.query(
        `UPDATE public.contract_np_layers
            SET hist_margin     = COALESCE($3, hist_margin),
                modelled_margin = COALESCE($4, modelled_margin),
                tech_ratio      = COALESCE($5, tech_ratio),
                uw_price        = COALESCE($6, uw_price),
                expiring_price  = COALESCE($7, expiring_price),
                lead_price      = COALESCE($8, lead_price),
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
    await cl.query("COMMIT");
    res.json({ok:true, updated_at: updatedAt});
  } catch(e) { await cl.query("ROLLBACK").catch(()=>{}); throw e; }
  finally { cl.release(); }
}));

// ── NP Expiring Structure ──
// Quote aliases — same handler, isQuote forced true
router.get("/quotes/:id/np/expiring",  asyncHandler(async (req, res) => { req.query.quote = 'true'; req.params = { id: req.params.id }; return npExpiringGet(req, res); }));
router.put("/quotes/:id/np/expiring",   validateBody(npExpiringPutSchema), asyncHandler(async (req, res) => { req.query.quote = 'true'; return npExpiringPut(req, res); }));
router.get("/treaties/:id/np/expiring", asyncHandler(async (req, res) => { return npExpiringGet(req, res); }));
router.put("/treaties/:id/np/expiring", validateBody(npExpiringPutSchema), asyncHandler(async (req, res) => { return npExpiringPut(req, res); }));

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
  try {
    const contractRow = await pool.query(
      `SELECT parent_contract_id FROM public.${ctx.parentTable} WHERE ${ctx.idColumn} = $1`,
      [id],
    );
    parentContractId = contractRow.rows[0]?.parent_contract_id || null;
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

  res.json({ layers, terms, coveredProps: termsR.rows[0]?.covered_props || [], autoPopulated, isRenewal: !!parentContractId, parentContractId });
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
    // Terms — upsert
    await cl.query(
      `INSERT INTO public.${tbl}_terms
        (${col},egnpi,deductible,risk_limit,cat_limit,brokerage_pct,no_claims_bonus_pct,profit_commission_pct,notes,covered_props)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (${col}) DO UPDATE SET
         egnpi=EXCLUDED.egnpi, deductible=EXCLUDED.deductible, risk_limit=EXCLUDED.risk_limit,
         cat_limit=EXCLUDED.cat_limit, brokerage_pct=EXCLUDED.brokerage_pct,
         no_claims_bonus_pct=EXCLUDED.no_claims_bonus_pct, profit_commission_pct=EXCLUDED.profit_commission_pct,
         notes=EXCLUDED.notes, covered_props=EXCLUDED.covered_props, updated_at=now()`,
      [id, numOrNull(terms.egnpi), numOrNull(terms.deductible),
       numOrNull(terms.risk_limit), numOrNull(terms.cat_limit),
       numOrNull(terms.brokerage_pct), numOrNull(terms.no_claims_bonus_pct),
       numOrNull(terms.profit_commission_pct), terms.notes || null,
       coveredProps ? JSON.stringify(coveredProps) : '[]']
    );
    const updatedAt = await touchParentEntity(cl, {
      parentTable: ctx.parentTable,
      idColumn: ctx.idColumn,
      id,
    });
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

  // 1. Get current contract's cedant and COBs
  const contractR = await pool.query(
    `SELECT c.cedant_id,
            array_agg(DISTINCT ccb.class_of_business_id) FILTER (WHERE ccb.class_of_business_id IS NOT NULL) AS cob_ids
     FROM public.contract c
     LEFT JOIN public.contract_class_of_business ccb ON ccb.contract_id = c.contract_id
     WHERE c.contract_id = $1
     GROUP BY c.cedant_id`, [id]
  );
  if (!contractR.rows.length || !contractR.rows[0].cedant_id) {
    return res.json({ contracts: [], totalLimit: 0, cedantId: null });
  }
  const { cedant_id, cob_ids } = contractR.rows[0];
  const cobIds = (cob_ids || []).filter(Boolean);

  // 2. Introspect class_of_business PK column name (live DB may differ from dump)
  const cobColRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='class_of_business' ORDER BY ordinal_position`
  );
  const cobCols = cobColRes.rows.map(r => r.column_name);
  const cobIdCol   = cobCols.find(c => c === 'class_of_business_id') || cobCols.find(c => c.endsWith('_id')) || cobCols[0];
  const cobNameCol = cobCols.find(c => c === 'class_of_business') || cobCols.find(c => c.includes('name')) || cobCols[1] || cobCols[0];

  // Find ALL active NP contracts for same cedant that share at least one COB
  const otherR = await pool.query(
    `SELECT
       c.contract_id,
       c.uw_year,
       c.uw_status,
       c.signed_line_pct,
       string_agg(DISTINCT cob.${cobNameCol}, ', ' ORDER BY cob.${cobNameCol}) AS cob_names,
       COALESCE(SUM(nl.layer_limit), 0)                                         AS total_structure_limit,
       COALESCE(c.signed_line_pct,
         (SELECT o.written_line_pct
          FROM public.contract_offer o
          WHERE o.contract_id = c.contract_id
          ORDER BY o.updated_at DESC LIMIT 1)
       )                                                                          AS effective_line_pct
     FROM public.contract c
     JOIN public.contract_class_of_business ccb ON ccb.contract_id = c.contract_id
     JOIN public.class_of_business cob          ON cob.${cobIdCol} = ccb.class_of_business_id
     LEFT JOIN public.contract_np_layers nl      ON nl.contract_id = c.contract_id
     WHERE c.cedant_id = $1
       AND c.uw_status NOT IN ('DECLINED','NTU')
       AND EXISTS (
         SELECT 1 FROM public.contract_class_of_business x
         WHERE x.contract_id = c.contract_id
           AND ($2::uuid[] IS NULL OR array_length($2::uuid[], 1) = 0
                OR x.class_of_business_id = ANY($2::uuid[]))
       )
     GROUP BY c.contract_id, c.uw_year, c.uw_status, c.signed_line_pct
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
router.get("/treaties/:id/np/excess-ldfs", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM public.contract_np_excess_ldf WHERE contract_id=$1 ORDER BY dev_month`,
    [id]
  );
  res.json(rows);
}));
router.get("/quotes/:id/np/excess-ldfs", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM public.quote_np_excess_ldf WHERE quote_id=$1 ORDER BY dev_month`,
    [id]
  );
  res.json(rows);
}));

// PUT: save chosen factors (called by NpExcessDevFactors saveDevFactors path
//      AND directly here for a clean dedicated endpoint)
router.put("/treaties/:id/np/excess-ldfs", validateBody(excessLdfsPutSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { factors = [], tail_factor = 1.0 } = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
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
    await cl.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cl.release(); }
}));
router.put("/quotes/:id/np/excess-ldfs", validateBody(excessLdfsPutSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { factors = [], tail_factor = 1.0 } = req.body;
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
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
    await cl.query('COMMIT');
    res.json({ ok: true });
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
  router.get(`/treaties/:id/np/${path}-ldfs`, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [ldfs, ults] = await Promise.all([
      pool.query(`SELECT * FROM public.${contractTbl} WHERE contract_id=$1 ORDER BY dev_month`, [id]),
      pool.query(`SELECT * FROM public.${contractUlt} WHERE contract_id=$1 ORDER BY acc_year`, [id]),
    ]);
    res.json({ ldfs: ldfs.rows, ultimates: ults.rows });
  }));

  router.get(`/quotes/:id/np/${path}-ldfs`, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [ldfs, ults] = await Promise.all([
      pool.query(`SELECT * FROM public.${quoteTbl} WHERE quote_id=$1 ORDER BY dev_month`, [id]),
      pool.query(`SELECT * FROM public.${quoteUlt} WHERE quote_id=$1 ORDER BY acc_year`, [id]),
    ]);
    res.json({ ldfs: ldfs.rows, ultimates: ults.rows });
  }));

  // PUT LDFs + ultimates
  router.put(`/treaties/:id/np/${path}-ldfs`, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { ldfs = [], ultimates = [], tail_factor = 1.0 } = req.body;
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
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
      await cl.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await cl.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cl.release(); }
  }));

  router.put(`/quotes/:id/np/${path}-ldfs`, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { ldfs = [], ultimates = [], tail_factor = 1.0 } = req.body;
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
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
      await cl.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await cl.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cl.release(); }
  }));
}

makeLossLdfRoutes('large_loss');
makeLossLdfRoutes('cat_loss');

// ── GET /api/treaties/:id/np/historical-performance ──
router.get("/treaties/:id/np/historical-performance", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio
     FROM public.contract_np_historical_performance
     WHERE contract_id = $1 ORDER BY uw_year`,
    [req.params.id]
  );
  res.json(rows);
}));

// ── PUT /api/treaties/:id/np/historical-performance ──
router.put("/treaties/:id/np/historical-performance", validateBody(historicalPerfPutSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const inputRows = req.body.rows ?? [];
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await cl.query(`DELETE FROM public.contract_np_historical_performance WHERE contract_id = $1`, [id]);
    for (const r of inputRows) {
      await cl.query(
        `INSERT INTO public.contract_np_historical_performance
           (contract_id, uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, r.uw_year,
         numOrNull(r.premiums), numOrNull(r.claims), numOrNull(r.egnpi),
         numOrNull(r.result), numOrNull(r.loss_ratio),
         numOrNull(r.expense_ratio), numOrNull(r.combined_ratio)]
      );
    }
    await cl.query("COMMIT");
    res.json({ ok: true });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; }
  finally { cl.release(); }
}));

export default router;
