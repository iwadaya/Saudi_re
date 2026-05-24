// server/src/routes/treatyData.js — Sub-entity endpoints (triangles, losses, profiles, cresta, docs, etc.)
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, numOrNull, dateOrNull } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { getTriangleBounds, filterTriangleCells, normalizeTriangleRequest } from '../lib/triangleBounds.js';
import { stripTriangleCells, stripFieldForType } from '../lib/triangleStripping.js';
import { logAudit } from '../services/audit.js';
import { saveCrestaSlice } from '../lib/crestaSave.js';
import { crestaSaveSchema } from '../validation/cresta.js';
import { triangleCellsSchema, devFactorPutSchema, triangleTypeSchema } from '../validation/triangle.js';
import { validateBody } from '../lib/validate.js';
import { getWordingChecklist, runWordingChecklistAi, saveWordingChecklist } from '../services/wordingChecklist.js';
import {
  storeUploadedFile,
  deleteUploadedFile,
  isRemoteStoragePath,
  resolveLocalStoragePath,
} from '../lib/uploadStorage.js';
import { buildBatchInsert } from '../db/batchInsert.js';
import { randomUUID } from 'node:crypto';
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const router = Router();
function parseDateFlex(v){return dateOrNull(v);}

// ── TRIANGLES ──
router.get("/treaties/:id/triangles/:type", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT cell_id,origin_year,dev_months,cum_value FROM public.contract_triangle_cells WHERE contract_id=$1 AND type=$2::public.triangle_type ORDER BY origin_year,dev_months`,[req.params.id,req.params.type.toUpperCase()]);
  res.json({cells:rows});
}));
// Returns the triangle in two variants: `full` (raw cells) and `stripped`
// (large + cat losses removed — the attritional basis for selecting dev
// factors). See lib/triangleStripping.js for the stripping rules.
router.get("/treaties/:id/triangles/:type/with-exclusions", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  const { rows: cells } = await pool.query(
    `SELECT cell_id,origin_year,dev_months,cum_value FROM public.contract_triangle_cells WHERE contract_id=$1 AND type=$2::public.triangle_type ORDER BY origin_year,dev_months`,
    [id, t]
  );
  const { rows: largeLosses } = await pool.query(
    `SELECT ll.uw_year, ll.date_of_loss, ll.paid, ll.os, ll.incurred
       FROM public.contract_large_losses ll
       JOIN public.contract_large_loss_report r ON r.report_id = ll.report_id
      WHERE r.contract_id = $1`, [id]
  );
  const { rows: catLosses } = await pool.query(
    `SELECT cl.uw_year, cl.date_of_loss, cl.paid, cl.os, cl.incurred
       FROM public.contract_cat_losses cl
       JOIN public.contract_cat_loss_report r ON r.report_id = cl.report_id
      WHERE r.contract_id = $1`, [id]
  );
  const field = stripFieldForType(t);
  const stripped = stripTriangleCells(cells, field ? [...largeLosses, ...catLosses] : [], field);
  res.json({
    full: { cells },
    stripped: { cells: stripped },
    exclusions: { largeLossCount: largeLosses.length, catLossCount: catLosses.length, applies: !!field },
  });
}));
router.post("/treaties/:id/triangles/:type", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  // Validate the path enum before anything else — silently uppercasing
  // an unknown value used to hand a 500 to the caller when Postgres
  // rejected the cast.
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  // Accept any client wire shape (TriangleScreen sends {cells}, the Excel
  // import agent sends {triangle: {dev_years, rows}}, fallthrough is
  // bare-array). Validate the normalised array, then drop anything outside
  // the contract's upper triangle so accidental overflows never reach
  // contract_triangle_cells.
  const rawCells = normalizeTriangleRequest(req.body);
  const cellsParse = triangleCellsSchema.safeParse(rawCells);
  if (!cellsParse.success) {
    return res.status(400).json({
      error: 'Invalid triangle payload', code: 'VALIDATION_FAILED',
      fields: cellsParse.error.issues.map(i => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    });
  }
  const bounds = await getTriangleBounds('treaty', id);
  const cells = filterTriangleCells(bounds, cellsParse.data);
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await cl.query(`DELETE FROM public.contract_triangle_cells WHERE contract_id=$1 AND type=$2::public.triangle_type`, [id, t]);
    if (cells.length) {
      // One round-trip via unnest() instead of N inserts — matters at
      // 60×60 bounds where the loop produced ~1800 round-trips inside
      // the transaction.
      await cl.query(
        `INSERT INTO public.contract_triangle_cells (contract_id, type, origin_year, dev_months, cum_value)
         SELECT $1, $2::public.triangle_type, oy, dm, cv
           FROM unnest($3::int[], $4::int[], $5::numeric[]) AS u(oy, dm, cv)`,
        [
          id, t,
          cells.map(c => c.origin_year),
          cells.map(c => c.dev_months),
          cells.map(c => numOrNull(c.cum_value) ?? 0),
        ]
      );
    }
    await cl.query("COMMIT");
    await logAudit(pool, {
      entityType: 'CONTRACT', entityId: id, eventType: 'TRIANGLE_SAVED',
      actor: req.body?._actor || req.user?.displayName || 'SYSTEM',
      payload: { triangle_type: t, saved: cells.length, dropped: rawCells.length - cells.length },
    });
    res.json({ ok: true, saved: cells.length, dropped: rawCells.length - cells.length });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; } finally { cl.release(); }
}));


// ── DEV FACTORS ──
router.get("/treaties/:id/dev-factors/:type", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.contract_dev_factor WHERE contract_id=$1 AND triangle_type=$2 ORDER BY dev_month`,[req.params.id,req.params.type.toUpperCase()]);
  res.json(rows);
}));
router.put("/treaties/:id/dev-factors/:type", validateBody(devFactorPutSchema), asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  const factors = req.body.factors ?? [];
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await cl.query(
      `DELETE FROM public.contract_dev_factor WHERE contract_id=$1 AND triangle_type=$2::public.triangle_type`,
      [id, t]
    );
    if (factors.length) {
      // Two leading params: contract_id ($1) and triangle_type ($2 with
      // an explicit ::public.triangle_type cast). buildBatchInsert only
      // supports a single leading id, so we hand-roll the placeholders
      // here to keep the type cast and avoid one round-trip per row.
      const cols = ['contract_id','triangle_type','dev_month','selected_ldf','selected_cdf','actual_ldf','actual_cdf','param_ldf','param_cdf','chosen_source','chosen_ldf','chosen_cdf','overridden','parametrized_ldf','parametrized_cdf'];
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
        `INSERT INTO public.contract_dev_factor (${cols.join(',')}) VALUES ${tuples.join(',')}`,
        params,
      );
    }
    await cl.query("COMMIT");
    await logAudit(pool, {
      entityType: 'CONTRACT', entityId: id, eventType: 'DEV_FACTORS_SAVED',
      actor: req.body?._actor || req.user?.displayName || 'SYSTEM',
      payload: { triangle_type: t, count: factors.length, method: req.body?.method || null, basis: req.body?.basis || null },
    });
    res.json({ ok: true });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; } finally { cl.release(); }
}));

// ── LARGE LOSSES ──
router.get("/treaties/:id/large-losses", asyncHandler(async (req, res) => {
  const {rows:rr}=await pool.query(`SELECT * FROM public.contract_large_loss_report WHERE contract_id=$1`,[req.params.id]);
  if(!rr.length) return res.json({report:null,losses:[]});
  const {rows:losses}=await pool.query(`SELECT * FROM public.contract_large_losses WHERE report_id=$1 ORDER BY uw_year,date_of_loss`,[rr[0].report_id]);
  res.json({report:rr[0],losses});
}));
router.put("/treaties/:id/large-losses", asyncHandler(async (req, res) => {
  const {id}=req.params;const {report_date,losses=[]}=req.body;const cl=await pool.connect();
  try{await cl.query("BEGIN");
  const {rows:rr}=await cl.query(`INSERT INTO public.contract_large_loss_report (contract_id,report_date) VALUES ($1,$2) ON CONFLICT (contract_id) DO UPDATE SET report_date=EXCLUDED.report_date,updated_at=now() RETURNING report_id`,[id,dateOrNull(report_date)]);
  const rid=rr[0].report_id;
  // Snapshot existing reported_date per loss_id so a delete+reinsert doesn't
  // erase when each loss first entered this contract.
  const {rows:prev}=await cl.query(`SELECT loss_id,reported_date FROM public.contract_large_losses WHERE report_id=$1`,[rid]);
  const prevReported=new Map(prev.map(r=>[String(r.loss_id),r.reported_date]));
  await cl.query(`DELETE FROM public.contract_large_losses WHERE report_id=$1`,[rid]);
  const today=new Date().toISOString().slice(0,10);
  // Generate loss_ids up front so we can batch the insert and still
  // return the same array of ids one-row-at-a-time used to surface.
  const largeLossesWithIds = losses.map((l) => {
    const existedReported = l.loss_id ? prevReported.get(String(l.loss_id)) : null;
    return {
      ...l,
      _loss_id: l.loss_id || randomUUID(),
      _reported: parseDateFlex(l.reported_date) || existedReported || today,
      _dol: parseDateFlex(l.date_of_loss),
    };
  });
  const largeLossesInsert = buildBatchInsert({
    table: 'public.contract_large_losses',
    columns: ['report_id','loss_id','uw_year','insured_name','loss_name','date_of_loss','class_of_business','paid','os','incurred','is_selected','inflation_factor','reported_date'],
    rows: largeLossesWithIds.map((l) => [
      l._loss_id, numOrNull(l.uw_year), l.insured_name, l.loss_name, l._dol,
      l.class_of_business, numOrNull(l.paid), numOrNull(l.os), numOrNull(l.incurred),
      l.is_selected ?? true, numOrNull(l.inflation_factor) ?? 1, l._reported,
    ]),
    leadingId: rid,
  });
  if (largeLossesInsert) await cl.query(largeLossesInsert.sql, largeLossesInsert.params);
  const savedLosses = largeLossesWithIds.map((l) => l._loss_id);
  await cl.query("COMMIT");res.json({ok:true,report_id:rid,loss_ids:savedLosses});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── CAT LOSSES ──
router.get("/treaties/:id/cat-losses", asyncHandler(async (req, res) => {
  const {rows:rr}=await pool.query(`SELECT * FROM public.contract_cat_loss_report WHERE contract_id=$1`,[req.params.id]);
  if(!rr.length) return res.json({report:null,losses:[]});
  const {rows:losses}=await pool.query(`SELECT * FROM public.contract_cat_losses WHERE report_id=$1 ORDER BY uw_year,date_of_loss`,[rr[0].report_id]);
  res.json({report:rr[0],losses});
}));
router.put("/treaties/:id/cat-losses", asyncHandler(async (req, res) => {
  const {id}=req.params;const {report_date,losses=[]}=req.body;const cl=await pool.connect();
  try{await cl.query("BEGIN");
  const {rows:rr}=await cl.query(`INSERT INTO public.contract_cat_loss_report (contract_id,report_date) VALUES ($1,$2) ON CONFLICT (contract_id) DO UPDATE SET report_date=EXCLUDED.report_date,updated_at=now() RETURNING report_id`,[id,dateOrNull(report_date)]);
  const rid=rr[0].report_id;
  const {rows:prev}=await cl.query(`SELECT loss_id,reported_date FROM public.contract_cat_losses WHERE report_id=$1`,[rid]);
  const prevReported=new Map(prev.map(r=>[String(r.loss_id),r.reported_date]));
  await cl.query(`DELETE FROM public.contract_cat_losses WHERE report_id=$1`,[rid]);
  const today=new Date().toISOString().slice(0,10);
  const catLossesWithIds = losses.map((l) => {
    const existedReported = l.loss_id ? prevReported.get(String(l.loss_id)) : null;
    return {
      ...l,
      _loss_id: l.loss_id || randomUUID(),
      _reported: parseDateFlex(l.reported_date) || existedReported || today,
      _dol: parseDateFlex(l.date_of_loss),
    };
  });
  const catLossesInsert = buildBatchInsert({
    table: 'public.contract_cat_losses',
    columns: ['report_id','loss_id','uw_year','insured_name','loss_name','date_of_loss','class_of_business','paid','os','incurred','is_selected','inflation_factor','reported_date'],
    rows: catLossesWithIds.map((l) => [
      l._loss_id, numOrNull(l.uw_year), l.insured_name, l.loss_name, l._dol,
      l.class_of_business, numOrNull(l.paid), numOrNull(l.os), numOrNull(l.incurred),
      l.is_selected ?? true, numOrNull(l.inflation_factor) ?? 1, l._reported,
    ]),
    leadingId: rid,
  });
  if (catLossesInsert) await cl.query(catLossesInsert.sql, catLossesInsert.params);
  const savedLosses = catLossesWithIds.map((l) => l._loss_id);
  await cl.query("COMMIT");res.json({ok:true,report_id:rid,loss_ids:savedLosses});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));


// ── LOSS SELECTION SNAPSHOTS (Return Period Curves) ──
// Stores derived return period curves/key points from Pareto screens so downstream pricing can consume
function normLossType(t){
  const u=String(t||'').toUpperCase();
  if(u==='LARGE'||u==='CAT') return u;
  if(u==='LARGE_LOSS'||u==='LARGELOSS'||u==='LL'||u==='L') return 'LARGE';
  if(u==='CAT_LOSS'||u==='CATLOSS'||u==='CL'||u==='C') return 'CAT';
  // support client params "large"/"cat"
  if(String(t||'').toLowerCase()==='large') return 'LARGE';
  if(String(t||'').toLowerCase()==='cat') return 'CAT';
  return null;
}

router.get("/treaties/:id/loss-selection/:lossType/latest", asyncHandler(async (req, res) => {
  const lt = normLossType(req.params.lossType);
  if(!lt) return res.status(400).json({error:"Invalid lossType"});
  const {rows}=await pool.query(
    `SELECT * FROM public.contract_loss_selection_snapshot
     WHERE contract_id=$1 AND loss_type=$2
     ORDER BY created_at DESC
     LIMIT 1`, [req.params.id, lt]
  );
  if(!rows.length) return res.json({snapshot:null, items:[]});
  const snap=rows[0];
  const {rows:items}=await pool.query(
    `SELECT * FROM public.contract_loss_selection_snapshot_item
     WHERE snapshot_id=$1
     ORDER BY created_at ASC`, [snap.snapshot_id]
  );
  res.json({snapshot:snap, items});
}));

router.put("/treaties/:id/loss-selection/:lossType/snapshot", asyncHandler(async (req, res) => {
  const lt = normLossType(req.params.lossType);
  if(!lt) return res.status(400).json({error:"Invalid lossType"});
  const body=req.body||{};
  const selected_losses = Array.isArray(body.selected_losses)?body.selected_losses:[];
  const cl=await pool.connect();
  try{
    await cl.query("BEGIN");
    const {rows}=await cl.query(
      `INSERT INTO public.contract_loss_selection_snapshot
        (contract_id, loss_type,
         inflation_mode, inflation_index, inflation_rate_pct, inflation_base_year, inflation_to_year,
         threshold, global_factor, selected_count,
         loadings, total_loading_pct,
         distribution_fits, active_distribution,
         pareto_xm, pareto_alpha, pareto_limit, observation_years,
         return_period_curve, return_period_key_points, assumptions_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        req.params.id,
        lt,
        body.inflation_mode||null,
        body.inflation_index||null,
        numOrNull(body.inflation_rate_pct),
        numOrNull(body.inflation_base_year),
        numOrNull(body.inflation_to_year),
        numOrNull(body.threshold),
        numOrNull(body.global_factor),
        selected_losses.length || body.selected_count || null,
        body.loadings ? JSON.stringify(body.loadings) : null,
        numOrNull(body.total_loading_pct),
        body.distribution_fits ? JSON.stringify(body.distribution_fits) : null,
        body.active_distribution||null,
        numOrNull(body.pareto_xm),
        numOrNull(body.pareto_alpha),
        numOrNull(body.pareto_limit),
        numOrNull(body.observation_years),
        body.return_period_curve ? JSON.stringify(body.return_period_curve) : null,
        body.return_period_key_points ? JSON.stringify(body.return_period_key_points) : null,
        body.assumptions_hash||null,
      ]
    );
    const snap=rows[0];

    if(selected_losses.length){
      for(const l of selected_losses){
        await cl.query(
          `INSERT INTO public.contract_loss_selection_snapshot_item
            (snapshot_id, uw_year, insured_name, loss_name, date_of_loss, class_of_business,
             paid, os, incurred, inflation_factor, inflated_incurred, source_loss_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            snap.snapshot_id,
            l.uw_year||null,
            l.insured_name||null,
            l.loss_name||null,
            parseDateFlex(l.date_of_loss)||null,
            l.class_of_business||null,
            numOrNull(l.paid)||0,
            numOrNull(l.os)||0,
            numOrNull(l.incurred)||0,
            numOrNull(l.inflation_factor)||1,
            numOrNull(l.inflated)||numOrNull(l.inflated_incurred)||null,
            l.loss_id||l.source_loss_id||null,
          ]
        );
      }
    }
    await cl.query("COMMIT");
    res.json({ok:true, snapshot:snap});
  }catch(e){
    await cl.query("ROLLBACK").catch(()=>{});
    throw e;
  }finally{
    cl.release();
  }
}));


// ── COBs ──
router.get("/treaties/:id/cobs", asyncHandler(async (req, res) => {
  try {
    // Introspect ALL column names for class_of_business table
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='class_of_business' ORDER BY ordinal_position`
    );
    const cols = colRes.rows.map(r => r.column_name);
    // Find the PK/ID column
    const idCol   = cols.find(c => c === 'class_of_business_id') || cols.find(c => c === 'class_id') || cols.find(c => c.endsWith('_id')) || cols[0];
    // Find the name column
    const nameCol = cols.find(c => c === 'class_of_business') || cols.find(c => c === 'class_name') || cols.find(c => c.includes('name')) || cols[1] || cols[0];
    // Find code column
    const codeCol = cols.find(c => c === 'code') || cols.find(c => c === 'class_code') || null;
    const selectCode = codeCol ? `, cob.${codeCol} AS code` : ``;

    // contract_class_of_business always uses class_of_business_id as FK
    // but cob table PK may be class_id or class_of_business_id
    const {rows}=await pool.query(
      `SELECT ccb.class_of_business_id, cob.${nameCol} AS name${selectCode}
       FROM public.contract_class_of_business ccb
       JOIN public.class_of_business cob ON cob.${idCol}=ccb.class_of_business_id
       WHERE ccb.contract_id=$1`,
      [req.params.id]
    );
    if (rows.length) return res.json(rows);

    // NP treaties store COBs at the layer level
    const {rows: npRows}=await pool.query(
      `SELECT DISTINCT lc.class_of_business_id, cob.${nameCol} AS name${selectCode}
       FROM public.contract_np_layer_class_of_business lc
       JOIN public.contract_np_layers l ON lc.layer_id = l.layer_id
       JOIN public.class_of_business cob ON cob.${idCol}=lc.class_of_business_id
       WHERE l.contract_id = $1
       ORDER BY lc.class_of_business_id`,
      [req.params.id]
    );
    return res.json(npRows);
  } catch(err) {
    logger.error('[/cobs] error', { error: err.message });
    // Fallback: return primary COB from contract directly without JOIN
    try {
      const {rows} = await pool.query(
        `SELECT primary_class_of_business_id AS class_of_business_id, NULL AS name, NULL AS code
         FROM public.contract
         WHERE contract_id=$1 AND primary_class_of_business_id IS NOT NULL`,
        [req.params.id]
      );
      return res.json(rows);
    } catch(err2) {
      logger.error('[/cobs] fallback error', { error: err2.message });
      return res.json([]);
    }
  }
}));
router.put("/treaties/:id/cobs", asyncHandler(async (req, res) => {
  const {id}=req.params;const ids=req.body.class_ids??req.body.classIds??(Array.isArray(req.body)?req.body:[]);
  const cl=await pool.connect();
  try{await cl.query("BEGIN");await cl.query(`DELETE FROM public.contract_class_of_business WHERE contract_id=$1`,[id]);
  const cobInsert = buildBatchInsert({
    table: 'public.contract_class_of_business',
    columns: ['contract_id','class_of_business_id'],
    rows: ids.filter((cid) => cid != null).map((cid) => [cid]),
    leadingId: id,
    conflict: 'ON CONFLICT DO NOTHING',
  });
  if (cobInsert) await cl.query(cobInsert.sql, cobInsert.params);
  await cl.query("COMMIT");res.json({ok:true});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── RISK PROFILES ──
router.get("/treaties/:id/risk-profiles/:cobId", asyncHandler(async (req, res) => {
  const {rows:pr}=await pool.query(`SELECT * FROM public.contract_risk_profile WHERE contract_id=$1 AND class_of_business_id=$2`,[req.params.id,req.params.cobId]);
  if(!pr.length) return res.json({profile:null,bands:[]});
  const {rows:bands}=await pool.query(`SELECT * FROM public.contract_risk_profile_band WHERE profile_id=$1 ORDER BY from_amt`,[pr[0].profile_id]);
  res.json({profile:pr[0],bands});
}));
router.put("/treaties/:id/risk-profiles/:cobId", asyncHandler(async (req, res) => {
  const {id,cobId}=req.params;const {c_value,pml_percentage,selected_curve,custom_b,custom_g,gross_loss_ratio,bands=[]}=req.body;const cl=await pool.connect();
  try{await cl.query("BEGIN");
  const {rows}=await cl.query(`INSERT INTO public.contract_risk_profile (contract_id,class_of_business_id,c_value,pml_percentage,selected_curve,custom_b,custom_g,gross_loss_ratio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (contract_id,class_of_business_id) DO UPDATE SET c_value=EXCLUDED.c_value,pml_percentage=EXCLUDED.pml_percentage,selected_curve=EXCLUDED.selected_curve,custom_b=EXCLUDED.custom_b,custom_g=EXCLUDED.custom_g,gross_loss_ratio=EXCLUDED.gross_loss_ratio RETURNING profile_id`,
    [id,cobId,numOrNull(c_value)??0,numOrNull(pml_percentage)??100,selected_curve||null,numOrNull(custom_b),numOrNull(custom_g),numOrNull(gross_loss_ratio)]);
  const pid=rows[0].profile_id;await cl.query(`DELETE FROM public.contract_risk_profile_band WHERE profile_id=$1`,[pid]);
  const riskBandsInsert = buildBatchInsert({
    table: 'public.contract_risk_profile_band',
    columns: ['profile_id','from_amt','to_amt','no_of_risks','total_sum_insured','gross_premium'],
    rows: bands.map((b) => [numOrNull(b.from_amt),numOrNull(b.to_amt),numOrNull(b.no_of_risks),numOrNull(b.total_sum_insured),numOrNull(b.gross_premium)]),
    leadingId: pid,
  });
  if (riskBandsInsert) await cl.query(riskBandsInsert.sql, riskBandsInsert.params);
  await cl.query("COMMIT");res.json({ok:true,profile_id:pid});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── CLAIMS PROFILES ──
router.get("/treaties/:id/claims-profiles/:cobId", asyncHandler(async (req, res) => {
  const {rows:pr}=await pool.query(`SELECT * FROM public.contract_claims_profile WHERE contract_id=$1 AND class_of_business_id=$2`,[req.params.id,req.params.cobId]);
  if(!pr.length) return res.json({profile:null,bands:[]});
  const {rows:bands}=await pool.query(`SELECT * FROM public.contract_claims_profile_band WHERE profile_id=$1 ORDER BY from_amt`,[pr[0].profile_id]);
  res.json({profile:pr[0],bands});
}));
router.put("/treaties/:id/claims-profiles/:cobId", asyncHandler(async (req, res) => {
  const {id,cobId}=req.params;const rawRows=req.body.bands??req.body.rows??[];const cl=await pool.connect();
  try{await cl.query("BEGIN");
  const {rows}=await cl.query(`INSERT INTO public.contract_claims_profile (contract_id,class_of_business_id) VALUES ($1,$2) ON CONFLICT (contract_id,class_of_business_id) DO UPDATE SET contract_id=EXCLUDED.contract_id RETURNING profile_id`,[id,cobId]);
  const pid=rows[0].profile_id;await cl.query(`DELETE FROM public.contract_claims_profile_band WHERE profile_id=$1`,[pid]);
  const claimsBandsInsert = buildBatchInsert({
    table: 'public.contract_claims_profile_band',
    columns: ['profile_id','from_amt','to_amt','no_of_claims','aggregate_incurred','no_of_risks','total_sum_insured','gross_premium'],
    rows: rawRows.map((b) => [numOrNull(b.from_amt),numOrNull(b.to_amt),numOrNull(b.no_of_claims),numOrNull(b.aggregate_incurred),numOrNull(b.no_of_risks),numOrNull(b.total_sum_insured),numOrNull(b.gross_premium)]),
    leadingId: pid,
  });
  if (claimsBandsInsert) await cl.query(claimsBandsInsert.sql, claimsBandsInsert.params);
  await cl.query("COMMIT");res.json({ok:true,profile_id:pid});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── CRESTA ──
router.get("/treaties/:id/cresta", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.contract_cresta_data WHERE contract_id=$1 ORDER BY treaty_type,cob_id,country_id,zone_id`,[req.params.id]);
  res.json(rows);
}));
router.put("/treaties/:id/cresta", asyncHandler(async (req, res) => {
  const {id}=req.params;
  const parsed = crestaSaveSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid CRESTA payload', details: parsed.error.issues });
  const { rows: cRows, treaty_type, cob_id: cobId, cob_name: cobName, country_id: countryId } = parsed.data;
  const treatyType = treaty_type || 'Both';
  await saveCrestaSlice({ kind: 'contract', id, rows: cRows, treatyType, cobId: cobId || null, cobName: cobName || null, countryId: countryId || null });
  res.json({ ok: true });
}));

// ── CEDANT EXPOSURE ──
router.get("/treaties/:id/cedant-exposure", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT COALESCE(SUM(eq_agg+ws_agg+flood_agg+srcc_agg+others_agg),0) AS total_exposure FROM public.contract_cresta_data WHERE contract_id=$1`,[req.params.id]);
  res.json({total_exposure:rows[0]?.total_exposure??0});
}));

// ── DOCUMENTS ──
// Storage strategy (Cloudinary if configured, local disk otherwise)
// lives in lib/uploadStorage.js so it can be shared with quotes.js
// and facultative.js. Reads still happen here because they're
// document-table-specific.

// Always use memory storage — the helper decides where the bytes land.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get("/treaties/:id/documents", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT document_id,file_name,mime_type,size_bytes,description,doc_type,title,storage_path,uploaded_at FROM public.contract_document WHERE contract_id=$1 ORDER BY uploaded_at DESC`,[req.params.id]);
  res.json(rows);
}));

router.post("/treaties/:id/documents", upload.single("file"), asyncHandler(async (req, res) => {
  const {id}=req.params;
  const file = req.file;
  const b = req.body;
  if (!file) return res.status(400).json({ error: "No file uploaded" });
  let storagePath;
  try {
    storagePath = await storeUploadedFile({ folder: `universe3/${id}`, file });
  } catch (e) {
    return res.status(502).json({ error: `Upload storage failed: ${e?.message || e}` });
  }
  const {rows}=await pool.query(
    `INSERT INTO public.contract_document (contract_id,file_name,mime_type,size_bytes,storage_path,description,doc_type,title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, file.originalname, file.mimetype, file.size, storagePath, b.description||null, b.doc_type||null, b.title||null]);
  res.status(201).json(rows[0]);
}));

router.get("/treaties/:id/wording-checklist", asyncHandler(async (req, res) => {
  const payload = await getWordingChecklist(pool, { type: 'contract', id: req.params.id });
  res.json(payload);
}));

router.put("/treaties/:id/wording-checklist", asyncHandler(async (req, res) => {
  const payload = await saveWordingChecklist(
    pool,
    { type: 'contract', id: req.params.id },
    req.body?.items || [],
    { actorUserId: req.user?.userId || req.headers['x-user-id'] || null },
  );
  res.json(payload);
}));

router.post("/treaties/:id/wording-checklist/ai-check", asyncHandler(async (req, res) => {
  const payload = await runWordingChecklistAi(
    pool,
    { type: 'contract', id: req.params.id },
    { actorUserId: req.user?.userId || req.headers['x-user-id'] || null },
  );
  res.json(payload);
}));

router.delete("/documents/:docId", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT storage_path FROM public.contract_document WHERE document_id=$1`,[req.params.docId]);
  const {rowCount}=await pool.query(`DELETE FROM public.contract_document WHERE document_id=$1`,[req.params.docId]);
  if(!rowCount) return res.status(404).json({error:"Document not found"});
  const sp = rows[0]?.storage_path || '';
  // Best-effort cleanup — the DB row is already gone, so any failure
  // here is a logged disk-space leak, not a request failure.
  deleteUploadedFile(sp).catch((err) => {
    logger.warn('[doc/delete] storage cleanup failed', { storagePath: sp, error: err?.message });
  });
  res.json({ok:true});
}));

async function serveDoc(req, res) {
  const {rows}=await pool.query(`SELECT * FROM public.contract_document WHERE document_id=$1`,[req.params.docId]);
  if(!rows.length) return res.status(404).json({error:"Document not found"});
  const doc = rows[0];
  const sp = doc.storage_path || '';
  // Cloudinary URL — redirect directly
  if (isRemoteStoragePath(sp)) {
    return res.redirect(sp);
  }
  // Local disk — single async stat both confirms existence and supplies
  // the Content-Length fallback when the DB row predates size_bytes.
  const fp = resolveLocalStoragePath(sp);
  let stat;
  try {
    stat = await fsp.stat(fp);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({error:"File not found on disk"});
    throw err;
  }
  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.file_name)}"`);
  res.setHeader("Content-Length", doc.size_bytes || stat.size);
  fs.createReadStream(fp).pipe(res);
}

router.get("/documents/:docId/download", asyncHandler(serveDoc));
router.get("/documents/:docId/view",     asyncHandler(serveDoc));

// ── Document text extraction endpoint ──
router.get("/documents/:docId/text", asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM public.contract_document WHERE document_id=$1`, [req.params.docId]
  );
  if (!rows.length) return res.status(404).json({ error: "Document not found" });
  const doc = rows[0];
  const sp = doc.storage_path || '';
  let buffer = null;

  try {
    if (isRemoteStoragePath(sp)) {
      const { default: nodeFetch } = await import('node-fetch');
      const r = await nodeFetch(sp);
      if (!r.ok) return res.json({ text: '', error: 'Could not fetch from cloud' });
      buffer = Buffer.from(await r.arrayBuffer());
    } else {
      const fp = resolveLocalStoragePath(sp);
      try {
        buffer = await fsp.readFile(fp);
      } catch (err) {
        if (err.code === 'ENOENT') return res.json({ text: '', error: 'File not on disk' });
        throw err;
      }
    }
  } catch(e) { return res.json({ text: '', error: e.message }); }

  const mime = doc.mime_type || '';
  let text = '';
  try {
    if (mime === 'application/pdf' || /\.pdf$/i.test(sp)) {
      const pdfParse = _require('pdf-parse');
      const data = await pdfParse(buffer);
      text = data.text || '';
    } else if (mime.startsWith('text') || /\.(txt|csv|md)$/i.test(sp)) {
      text = buffer.toString('utf-8');
    }
  } catch(e) { logger.warn('[doc/text] extraction failed', { error: e.message }); }

  res.json({ text: text.slice(0, 50000), length: text.length, mime });
}));

// ── Benchmarks and other routes below ──
router.get("/benchmarks/:countryId/:triangleType", asyncHandler(async (req, res) => {
  const { countryId, triangleType } = req.params;
  const triType = triangleType.toUpperCase();
  const ldfCol = triType.includes('PREMIUM') ? 'premium_ldf' : 'incurred_ldf';

  // Country-specific
  const { rows: countryRows } = await pool.query(
    `SELECT development_month, ${ldfCol} AS ldf FROM public.ref_benchmark_ldf WHERE country_id=$1 ORDER BY development_month`, [countryId]);

  // Region average (all countries that have benchmarks)
  const { rows: regionRows } = await pool.query(
    `SELECT development_month, AVG(${ldfCol}) AS ldf FROM public.ref_benchmark_ldf GROUP BY development_month ORDER BY development_month`);

  // All countries average (same as region for now since we only have one region of data)
  const { rows: allRows } = await pool.query(
    `SELECT development_month, AVG(${ldfCol}) AS ldf FROM public.ref_benchmark_ldf GROUP BY development_month ORDER BY development_month`);

  res.json({
    country: countryRows.map(r => ({ dev_month: r.development_month, ldf: Number(r.ldf) })),
    region: regionRows.map(r => ({ dev_month: r.development_month, ldf: Number(r.ldf) })),
    all: allRows.map(r => ({ dev_month: r.development_month, ldf: Number(r.ldf) })),
  });
}));

// ── GET /api/treaties/:id/pricing-pattern/:type ──
router.get("/treaties/:id/pricing-pattern/:type", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM public.contract_pricing_patterns WHERE contract_id=$1 AND triangle_type=$2`, [id, type.toUpperCase()]);
  res.json(rows[0] || null);
}));

// ── PUT /api/treaties/:id/pricing-pattern/:type ──
router.put("/treaties/:id/pricing-pattern/:type", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const b = req.body || {};
  const t = type.toUpperCase();
  await pool.query(
    `INSERT INTO public.contract_pricing_patterns (contract_id, triangle_type, selection_method, selected_factors, tail_factor, bf_ielr)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (contract_id, triangle_type) DO UPDATE SET
       selection_method=EXCLUDED.selection_method, selected_factors=EXCLUDED.selected_factors,
       tail_factor=EXCLUDED.tail_factor, bf_ielr=EXCLUDED.bf_ielr, updated_at=now()`,
    [id, t, b.selection_method || 'WEIGHTED', JSON.stringify(b.selected_factors || {}),
     b.tail_factor ?? 1.0, b.bf_ielr ?? 0]);
  res.json({ ok: true });
}));
export default router;
