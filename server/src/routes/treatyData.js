// server/src/routes/treatyData.js — Sub-entity endpoints (triangles, losses, profiles, cresta, docs, etc.)
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler, numOrNull, dateOrNull, safeUwYear, preserveBool, preserveNum, assertExists, isStaleSince } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { getTriangleBounds, filterTriangleCells, normalizeTriangleRequest } from '../lib/triangleBounds.js';
import { stripTriangleCells, stripFieldForType, summarizeLossPlacement, combineIncurredCells } from '../lib/triangleStripping.js';
import { suggestLossQuarters } from '../lib/lossQuarterMapper.js';
import { logAudit } from '../services/audit.js';
import { assertCanEdit, getEditPermission } from '../services/permissions.js';
import { actorFromReq } from '../middleware/requestContext.js';
import { saveCrestaSlice } from '../lib/crestaSave.js';
import { crestaSaveSchema } from '../validation/cresta.js';
import { triangleCellsSchema, devFactorPutSchema, triangleTypeSchema } from '../validation/triangle.js';
import { validateBody } from '../lib/validate.js';
import { assertParentEntityUnchanged, touchParentEntity } from '../lib/parentEntityPersistence.js';
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

async function assertContractFresh(db, contractId, req) {
  await assertParentEntityUnchanged(db, {
    parentTable: 'contract',
    idColumn: 'contract_id',
    id: contractId,
    ifUnmodifiedSince: req.headers['if-unmodified-since'],
  });
}

async function touchContract(db, contractId) {
  return await touchParentEntity(db, {
    parentTable: 'contract',
    idColumn: 'contract_id',
    id: contractId,
  });
}

// Triangle variant (migration 116). Reads/writes default to MODIFIED so all
// pre-variant behaviour is unchanged unless ACTUAL is explicitly requested.
// Returns null for an explicitly-invalid value so the caller can 400.
const TRIANGLE_VARIANTS = new Set(['ACTUAL', 'MODIFIED']);
function resolveVariant(raw) {
  if (raw == null || raw === '') return 'MODIFIED';
  const v = String(raw).toUpperCase();
  return TRIANGLE_VARIANTS.has(v) ? v : null;
}

// ── TRIANGLES ──
router.get("/treaties/:id/triangles/:type", asyncHandler(async (req, res) => {
  const variant = resolveVariant(req.query.variant);
  if (!variant) return res.status(400).json({ error: 'Invalid triangle variant', code: 'VALIDATION_FAILED' });
  const {rows}=await pool.query(`SELECT cell_id,origin_year,dev_months,cum_value FROM public.contract_triangle_cells WHERE contract_id=$1 AND type=$2::public.triangle_type AND variant=$3::public.triangle_variant ORDER BY origin_year,dev_months`,[req.params.id,req.params.type.toUpperCase(),variant]);
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
  // INCURRED is not stored as its own triangle — it is paid + OS. Build the
  // combined full triangle here so the incurred loss amount can be stripped
  // directly from it (see combineIncurredCells in lib/triangleStripping.js).
  let cells;
  if (t === 'INCURRED') {
    const [{ rows: paidCells }, { rows: osCells }] = await Promise.all([
      pool.query(`SELECT origin_year,dev_months,cum_value FROM public.contract_triangle_cells WHERE contract_id=$1 AND type='CLAIMS_PAID'::public.triangle_type AND variant='MODIFIED'::public.triangle_variant ORDER BY origin_year,dev_months`, [id]),
      pool.query(`SELECT origin_year,dev_months,cum_value FROM public.contract_triangle_cells WHERE contract_id=$1 AND type='CLAIMS_OS'::public.triangle_type AND variant='MODIFIED'::public.triangle_variant ORDER BY origin_year,dev_months`, [id]),
    ]);
    cells = combineIncurredCells(paidCells, osCells);
  } else {
    const { rows } = await pool.query(
      `SELECT cell_id,origin_year,dev_months,cum_value FROM public.contract_triangle_cells WHERE contract_id=$1 AND type=$2::public.triangle_type AND variant='MODIFIED'::public.triangle_variant ORDER BY origin_year,dev_months`,
      [id, t]
    );
    cells = rows;
  }
  const { rows: largeLosses } = await pool.query(
    `SELECT ll.uw_year, ll.date_of_loss, ll.actuarial_reported_date, ll.paid, ll.os, ll.incurred
       FROM public.contract_large_losses ll
       JOIN public.contract_large_loss_report r ON r.report_id = ll.report_id
      WHERE r.contract_id = $1`, [id]
  );
  const { rows: catLosses } = await pool.query(
    `SELECT cl.uw_year, cl.date_of_loss, cl.actuarial_reported_date, cl.paid, cl.os, cl.incurred
       FROM public.contract_cat_losses cl
       JOIN public.contract_cat_loss_report r ON r.report_id = cl.report_id
      WHERE r.contract_id = $1`, [id]
  );
  // Honour the per-treaty strip flag: when stripping is off, the stripped
  // variant is identical to the full triangle (no losses removed).
  const { rows: pd } = await pool.query(`SELECT strip_large_cat_losses FROM public.contract_prop_details WHERE contract_id=$1`, [id]);
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
      // Losses placed by the loss-date proxy (no reliable reported date) —
      // the actuary should verify these placements.
      proxyPlaced: placement.proxy, reportedPlaced: placement.reported,
    },
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
  const bounds = await getTriangleBounds('treaty', id);
  const cells = filterTriangleCells(bounds, cellsParse.data);
  const cl = await pool.connect();
  try {
    await cl.query("BEGIN");
    await assertContractFresh(cl, id, req);
    // Scope the delete to this variant — saving one variant must never wipe
    // the other's cells.
    await cl.query(`DELETE FROM public.contract_triangle_cells WHERE contract_id=$1 AND type=$2::public.triangle_type AND variant=$3::public.triangle_variant`, [id, t, variant]);
    if (cells.length) {
      // One round-trip via unnest() instead of N inserts — matters at
      // 60×60 bounds where the loop produced ~1800 round-trips inside
      // the transaction.
      await cl.query(
        `INSERT INTO public.contract_triangle_cells (contract_id, type, variant, origin_year, dev_months, cum_value)
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
    await logAudit(cl, {
      entityType: 'CONTRACT', entityId: id, eventType: 'TRIANGLE_SAVED',
      actor: actorFromReq(req),
      payload: { triangle_type: t, variant, saved: cells.length, dropped: rawCells.length - cells.length },
    }, { critical: true });
    const updatedAt = await touchContract(cl, id);
    await cl.query("COMMIT");
    res.json({ ok: true, saved: cells.length, dropped: rawCells.length - cells.length, updated_at: updatedAt });
  } catch (e) { await cl.query("ROLLBACK").catch(() => {}); throw e; } finally { cl.release(); }
}));


// ── DEV FACTORS ──
router.get("/treaties/:id/dev-factors/:type", asyncHandler(async (req, res) => {
  const {rows}=await pool.query(`SELECT * FROM public.contract_dev_factor WHERE contract_id=$1 AND triangle_type=$2 ORDER BY dev_month`,[req.params.id,req.params.type.toUpperCase()]);
  res.json(rows);
}));
// Staleness: was the source triangle saved more recently than the dev factors
// for this type? INCURRED factors are driven by the paid + OS triangles, so
// both feed its "triangle last updated". `stale` is only true when factors
// exist and the triangle was saved after them.
router.get("/treaties/:id/dev-factors/:type/staleness", asyncHandler(async (req, res) => {
  const { id, type } = req.params;
  const typeParse = triangleTypeSchema.safeParse(type.toUpperCase());
  if (!typeParse.success) return res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
  const t = typeParse.data;
  const sourceTypes = t === 'INCURRED' ? ['CLAIMS_PAID', 'CLAIMS_OS'] : [t];
  const [triRes, dfRes] = await Promise.all([
    pool.query(
      `SELECT MAX(updated_at) AS ts FROM public.contract_triangle_cells
        WHERE contract_id=$1 AND type = ANY($2::public.triangle_type[]) AND variant='MODIFIED'::public.triangle_variant`,
      [id, sourceTypes]
    ),
    pool.query(
      `SELECT MAX(saved_at) AS ts FROM public.contract_dev_factor
        WHERE contract_id=$1 AND triangle_type=$2::public.triangle_type`,
      [id, t]
    ),
  ]);
  const triangleUpdatedAt = triRes.rows[0]?.ts || null;
  const factorsSavedAt = dfRes.rows[0]?.ts || null;
  const stale = !!(triangleUpdatedAt && factorsSavedAt && new Date(triangleUpdatedAt) > new Date(factorsSavedAt));
  res.json({ triangleUpdatedAt, factorsSavedAt, stale });
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
    await assertContractFresh(cl, id, req);
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
    await logAudit(cl, {
      entityType: 'CONTRACT', entityId: id, eventType: 'DEV_FACTORS_SAVED',
      actor: actorFromReq(req),
      payload: { triangle_type: t, count: factors.length, method: req.body?.method || null, basis: req.body?.basis || null },
    }, { critical: true });
    const updatedAt = await touchContract(cl, id);
    await cl.query("COMMIT");
    res.json({ ok: true, updated_at: updatedAt });
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
  await assertExists(cl, 'public.contract', 'contract_id', id, 'Treaty');
  await assertContractFresh(cl, id, req);
  const {rows:rr}=await cl.query(`INSERT INTO public.contract_large_loss_report (contract_id,report_date) VALUES ($1,$2) ON CONFLICT (contract_id) DO UPDATE SET report_date=EXCLUDED.report_date,updated_at=now() RETURNING report_id`,[id,dateOrNull(report_date)]);
  const rid=rr[0].report_id;
  // Snapshot existing reported_date / is_selected / inflation_factor per loss_id
  // so a delete+reinsert doesn't erase them when this save omits them (the
  // loss-list grid sends neither selection nor inflation).
  const {rows:prev}=await cl.query(`SELECT loss_id,reported_date,is_selected,inflation_factor FROM public.contract_large_losses WHERE report_id=$1`,[rid]);
  const prevReported=new Map(prev.map(r=>[String(r.loss_id),r.reported_date]));
  const prevSelected=new Map(prev.map(r=>[String(r.loss_id),r.is_selected]));
  const prevInfl=new Map(prev.map(r=>[String(r.loss_id),r.inflation_factor]));
  await cl.query(`DELETE FROM public.contract_large_losses WHERE report_id=$1`,[rid]);
  const today=new Date().toISOString().slice(0,10);
  const reportSaved=dateOrNull(report_date)||today;
  // Generate loss_ids up front so we can batch the insert and still
  // return the same array of ids one-row-at-a-time used to surface.
  const largeLossesWithIds = losses.map((l) => {
    const key = l.loss_id ? String(l.loss_id) : null;
    const existedReported = key ? prevReported.get(key) : null;
    return {
      ...l,
      _loss_id: l.loss_id || randomUUID(),
      // "Saved in Universe": the report date of the cycle in which this loss
      // first entered, preserved across later saves so year-over-year report
      // comparison can tell which losses are new. New rows take the current
      // report date.
      _reported: existedReported || reportSaved,
      // Actuarial reporting date (when the loss was booked into the triangle)
      // — user-entered, nullable, drives stripping.
      _actuarial: parseDateFlex(l.actuarial_reported_date),
      _dol: parseDateFlex(l.date_of_loss),
      _pinc: parseDateFlex(l.policy_inception_date),
      // Underwriting year — NaN-guarded so an invalid inception/loss date
      // can't push NaN into the integer column and abort the save.
      _uwy: safeUwYear(l),
      // Preserve selection + inflation when the save omits them.
      _selected: preserveBool(l.is_selected, key ? prevSelected.get(key) : undefined),
      _infl: preserveNum(l.inflation_factor, key ? prevInfl.get(key) : undefined, 1),
    };
  });
  const largeLossesInsert = buildBatchInsert({
    table: 'public.contract_large_losses',
    columns: ['report_id','loss_id','uw_year','insured_name','loss_name','date_of_loss','class_of_business','paid','os','incurred','is_selected','inflation_factor','reported_date','actuarial_reported_date','policy_inception_date'],
    rows: largeLossesWithIds.map((l) => [
      l._loss_id, l._uwy, l.insured_name, l.loss_name, l._dol,
      l.class_of_business, numOrNull(l.paid), numOrNull(l.os), numOrNull(l.incurred),
      l._selected, l._infl, l._reported, l._actuarial, l._pinc,
    ]),
    leadingId: rid,
  });
  if (largeLossesInsert) await cl.query(largeLossesInsert.sql, largeLossesInsert.params);
  const savedLosses = largeLossesWithIds.map((l) => l._loss_id);
  const updatedAt = await touchContract(cl, id);
  await cl.query("COMMIT");res.json({ok:true,report_id:rid,loss_ids:savedLosses,updated_at:updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
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
  await assertExists(cl, 'public.contract', 'contract_id', id, 'Treaty');
  await assertContractFresh(cl, id, req);
  const {rows:rr}=await cl.query(`INSERT INTO public.contract_cat_loss_report (contract_id,report_date) VALUES ($1,$2) ON CONFLICT (contract_id) DO UPDATE SET report_date=EXCLUDED.report_date,updated_at=now() RETURNING report_id`,[id,dateOrNull(report_date)]);
  const rid=rr[0].report_id;
  const {rows:prev}=await cl.query(`SELECT loss_id,reported_date,is_selected,inflation_factor FROM public.contract_cat_losses WHERE report_id=$1`,[rid]);
  const prevReported=new Map(prev.map(r=>[String(r.loss_id),r.reported_date]));
  const prevSelected=new Map(prev.map(r=>[String(r.loss_id),r.is_selected]));
  const prevInfl=new Map(prev.map(r=>[String(r.loss_id),r.inflation_factor]));
  await cl.query(`DELETE FROM public.contract_cat_losses WHERE report_id=$1`,[rid]);
  const today=new Date().toISOString().slice(0,10);
  const reportSaved=dateOrNull(report_date)||today;
  const catLossesWithIds = losses.map((l) => {
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
      _actuarial: parseDateFlex(l.actuarial_reported_date),
      _dol: parseDateFlex(l.date_of_loss),
      _pinc: parseDateFlex(l.policy_inception_date),
      // NaN-guarded underwriting year (see large-loss handler).
      _uwy: safeUwYear(l),
      // Preserve selection + inflation when the save omits them.
      _selected: preserveBool(l.is_selected, key ? prevSelected.get(key) : undefined),
      _infl: preserveNum(l.inflation_factor, key ? prevInfl.get(key) : undefined, 1),
    };
  });
  const catLossesInsert = buildBatchInsert({
    table: 'public.contract_cat_losses',
    columns: ['report_id','loss_id','uw_year','insured_name','loss_name','date_of_loss','class_of_business','paid','os','incurred','is_selected','inflation_factor','reported_date','actuarial_reported_date','policy_inception_date'],
    rows: catLossesWithIds.map((l) => [
      l._loss_id, l._uwy, l.insured_name, l.loss_name, l._dol,
      l.class_of_business, numOrNull(l.paid), numOrNull(l.os), numOrNull(l.incurred),
      l._selected, l._infl, l._reported, l._actuarial, l._pinc,
    ]),
    leadingId: rid,
  });
  if (catLossesInsert) await cl.query(catLossesInsert.sql, catLossesInsert.params);
  const savedLosses = catLossesWithIds.map((l) => l._loss_id);
  const updatedAt = await touchContract(cl, id);
  await cl.query("COMMIT");res.json({ok:true,report_id:rid,loss_ids:savedLosses,updated_at:updatedAt});}catch(e){await cl.query("ROLLBACK").catch(()=>{});throw e;}finally{cl.release();}
}));

// ── PORTFOLIO FALLBACK LOSSES ──
// Individual large/cat loss records drawn from the cedant's OTHER treaties.
// Used by the Pareto screens to fall back to portfolio-average experience when
// the current treaty has no large/cat losses of its own.
router.get("/treaties/:id/portfolio-losses/:lossType", asyncHandler(async (req, res) => {
  const { id, lossType } = req.params;
  const isCat = String(lossType).toLowerCase() === 'cat';
  // Table names are selected by a boolean, never interpolated from raw input.
  const reportTable = isCat ? 'public.contract_cat_loss_report' : 'public.contract_large_loss_report';
  const lossTable = isCat ? 'public.contract_cat_losses' : 'public.contract_large_losses';

  const { rows: cRows } = await pool.query(`SELECT cedant_id FROM public.contract WHERE contract_id=$1`, [id]);
  const cedantId = cRows[0]?.cedant_id;
  if (!cedantId) return res.json({ losses: [], treatyCount: 0 });

  const { rows: losses } = await pool.query(
    `SELECT l.uw_year, l.incurred, l.paid, l.os, l.inflation_factor, l.is_selected, c.contract_id
       FROM ${lossTable} l
       JOIN ${reportTable} r ON r.report_id = l.report_id
       JOIN public.contract c ON c.contract_id = r.contract_id
      WHERE c.cedant_id = $1 AND c.contract_id <> $2`,
    [cedantId, id]
  );
  const treatyCount = new Set(losses.map(l => l.contract_id)).size;
  res.json({ losses, treatyCount });
}));

// ── STRIP LARGE/CAT TOGGLE ──
// Per-treaty choice of whether large + cat losses are stripped from the claims
// triangle. Focused single-column update so it can be persisted from the Dev
// Factors screen without overwriting the rest of the treaty detail.
router.put("/treaties/:id/strip-large-cat", asyncHandler(async (req, res) => {
  const strip = req.body?.strip_large_cat_losses === true;
  // Upsert so the toggle persists even if Dev Factors is reached before the
  // detail screen has created the prop-details row (no silent no-op).
  await pool.query(
    `INSERT INTO public.contract_prop_details (contract_id, strip_large_cat_losses)
       VALUES ($1, $2)
     ON CONFLICT (contract_id) DO UPDATE
       SET strip_large_cat_losses=EXCLUDED.strip_large_cat_losses, updated_at=now()`,
    [req.params.id, strip]
  );
  res.json({ ok: true, strip_large_cat_losses: strip });
}));

// ── LOSS-SELECTION STALENESS ──
// Warns the UI that the saved loss selection is outdated when large/cat losses
// have been edited (MAX updated_at) after the selection snapshot was last saved
// (loss_selection_saved_at). Never stale when no selection has been saved.
router.get("/treaties/:id/losses/staleness", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [lossRes, detRes] = await Promise.all([
    pool.query(
      `SELECT GREATEST(
         (SELECT MAX(l.updated_at) FROM public.contract_large_losses l
            JOIN public.contract_large_loss_report r ON r.report_id=l.report_id WHERE r.contract_id=$1),
         (SELECT MAX(l.updated_at) FROM public.contract_cat_losses l
            JOIN public.contract_cat_loss_report r ON r.report_id=l.report_id WHERE r.contract_id=$1)
       ) AS ts`,
      [id]
    ),
    pool.query(
      `SELECT loss_selection_saved_at AS ts FROM public.contract_prop_details WHERE contract_id=$1`,
      [id]
    ),
  ]);
  const lossesUpdatedAt = lossRes.rows[0]?.ts || null;
  const selectionSavedAt = detRes.rows[0]?.ts || null;
  res.json({ lossesUpdatedAt, selectionSavedAt, stale: isStaleSince(lossesUpdatedAt, selectionSavedAt) });
}));


// ── AI: MAP LOSSES TO DEVELOPMENT QUARTERS ──
// Advisory: suggests the development period each large/cat loss most likely
// entered the triangle (matching loss amounts to row jumps + reporting lag).
// Returns suggestions only — the actuary applies them by setting the
// actuarial reported date and saving.
router.post("/treaties/:id/losses/suggest-quarters", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows: incurredCells } = await pool.query(
    `SELECT origin_year, dev_months, SUM(cum_value) AS cum_value
       FROM public.contract_triangle_cells
      WHERE contract_id=$1 AND type IN ('CLAIMS_PAID','CLAIMS_OS') AND variant='MODIFIED'::public.triangle_variant
      GROUP BY origin_year, dev_months
      ORDER BY origin_year, dev_months`, [id]
  );
  const { rows: largeLosses } = await pool.query(
    `SELECT ll.loss_id, ll.uw_year, ll.date_of_loss, ll.actuarial_reported_date, ll.paid, ll.os, ll.incurred
       FROM public.contract_large_losses ll
       JOIN public.contract_large_loss_report r ON r.report_id = ll.report_id
      WHERE r.contract_id = $1`, [id]
  );
  const { rows: catLosses } = await pool.query(
    `SELECT cl.loss_id, cl.uw_year, cl.date_of_loss, cl.actuarial_reported_date, cl.paid, cl.os, cl.incurred
       FROM public.contract_cat_losses cl
       JOIN public.contract_cat_loss_report r ON r.report_id = cl.report_id
      WHERE r.contract_id = $1`, [id]
  );
  const losses = [...largeLosses, ...catLosses];
  if (!losses.length) return res.json({ suggestions: [], provider: null });
  try {
    const out = await suggestLossQuarters({ losses, triangleCells: incurredCells, triangleType: 'INCURRED' });
    res.json(out);
  } catch (e) {
    const msg = e?.message || 'AI mapping failed';
    const noProvider = /No LLM provider configured/i.test(msg);
    logger.error('[losses/suggest-quarters] failed', { error: msg });
    return res.status(noProvider ? 503 : 502).json({ error: msg });
  }
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

    const selectionItemsInsert = buildBatchInsert({
      table: 'public.contract_loss_selection_snapshot_item',
      columns: [
        'snapshot_id', 'uw_year', 'insured_name', 'loss_name', 'date_of_loss', 'class_of_business',
        'paid', 'os', 'incurred', 'inflation_factor', 'inflated_incurred', 'source_loss_id',
      ],
      rows: selected_losses.map((l) => [
        l.uw_year || null,
        l.insured_name || null,
        l.loss_name || null,
        parseDateFlex(l.date_of_loss) || null,
        l.class_of_business || null,
        numOrNull(l.paid) || 0,
        numOrNull(l.os) || 0,
        numOrNull(l.incurred) || 0,
        numOrNull(l.inflation_factor) || 1,
        numOrNull(l.inflated) || numOrNull(l.inflated_incurred) || null,
        l.loss_id || l.source_loss_id || null,
      ]),
      leadingId: snap.snapshot_id,
    });
    if (selectionItemsInsert) await cl.query(selectionItemsInsert.sql, selectionItemsInsert.params);
    // Mark the selection as saved now so the staleness check can tell whether
    // losses have been edited since. Upsert so it persists even if Loss
    // Selection is reached before the detail screen created the row.
    await cl.query(
      `INSERT INTO public.contract_prop_details (contract_id, loss_selection_saved_at)
         VALUES ($1, now())
       ON CONFLICT (contract_id) DO UPDATE SET loss_selection_saved_at=now(), updated_at=now()`,
      [req.params.id]
    );
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
  await assertContractFresh(pool, id, req);
  await saveCrestaSlice({ kind: 'contract', id, rows: cRows, treatyType, cobId: cobId || null, cobName: cobName || null, countryId: countryId || null });
  const updatedAt = await touchContract(pool, id);
  res.json({ ok: true, updated_at: updatedAt });
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

function documentEntity(doc) {
  if (doc?.contract_id) return { entityType: 'CONTRACT', entityId: doc.contract_id };
  if (doc?.quote_id) return { entityType: 'QUOTE', entityId: doc.quote_id };
  return null;
}

async function loadDocumentForAccess(req, docId, { write = false } = {}) {
  const { rows } = await pool.query(`SELECT * FROM public.contract_document WHERE document_id=$1`, [docId]);
  if (!rows.length) return null;

  const doc = rows[0];
  const owner = documentEntity(doc);
  if (!owner) {
    throw Object.assign(new Error('Document has no owning treaty or quote'), { status: 404, code: 'DOCUMENT_OWNER_NOT_FOUND' });
  }

  if (write) {
    await assertCanEdit(req, owner.entityType, owner.entityId);
    return doc;
  }

  const isSupervisor = req.user?.isSupervisor === true || Number(req.user?.hierarchyLevel) <= 2;
  if (isSupervisor) return doc;

  const permission = await getEditPermission(req, owner.entityType, owner.entityId);
  if (permission.canEdit) return doc;

  throw Object.assign(new Error('You do not have access to this document.'), { status: 403, code: 'FORBIDDEN' });
}

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
    { actorUserId: req.user?.userId || null },
  );
  res.json(payload);
}));

router.post("/treaties/:id/wording-checklist/ai-check", asyncHandler(async (req, res) => {
  const payload = await runWordingChecklistAi(
    pool,
    { type: 'contract', id: req.params.id },
    { actorUserId: req.user?.userId || null },
  );
  res.json(payload);
}));

router.delete("/documents/:docId", asyncHandler(async (req, res) => {
  const doc = await loadDocumentForAccess(req, req.params.docId, { write: true });
  if (!doc) return res.status(404).json({error:"Document not found"});
  const {rowCount}=await pool.query(`DELETE FROM public.contract_document WHERE document_id=$1`,[req.params.docId]);
  if(!rowCount) return res.status(404).json({error:"Document not found"});
  const sp = doc.storage_path || '';
  // Best-effort cleanup — the DB row is already gone, so any failure
  // here is a logged disk-space leak, not a request failure.
  deleteUploadedFile(sp).catch((err) => {
    logger.warn('[doc/delete] storage cleanup failed', { storagePath: sp, error: err?.message });
  });
  res.json({ok:true});
}));

async function serveDoc(req, res) {
  const doc = await loadDocumentForAccess(req, req.params.docId);
  if(!doc) return res.status(404).json({error:"Document not found"});
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
  const doc = await loadDocumentForAccess(req, req.params.docId);
  if (!doc) return res.status(404).json({ error: "Document not found" });
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
