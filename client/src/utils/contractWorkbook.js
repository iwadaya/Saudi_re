// src/utils/contractWorkbook.js
// ─────────────────────────────────────────────────────────────────────────
// "Whole contract" multi-sheet Excel exporter.
//
// Produces ONE workbook in which each worksheet mirrors one wizard screen,
// in the exact order the underwriter walks the tool (Treaty Detail → … →
// Final Pricing). Two design rules keep it honest:
//
//   1. Sheet ORDER is driven by the caller passing getWizardNav(...).order,
//      so the export sequence can never drift from the live wizard (it even
//      respects treaty-type / quote-mode / triangulation filtering, because
//      getWizardNav already applied it).
//
//   2. Per-screen DATA comes from the same persisted endpoints the screens
//      themselves load from — so the workbook reflects what is actually
//      saved on the contract, not transient UI state. The single exception
//      is the terminal pricing screen, whose computed figures live only in
//      memory at that point; the caller passes those in via ctx.finalData
//      and the pricing builders (buildNpPricingSheets / buildPropPricingSheets)
//      reproduce the exact sheets the per-screen export already emits.
//
// This is the engine only. The per-flow screen registries live next to the
// final-pricing screens (npWorkbookExporters.js / propWorkbookExporters.js).
//
// exceljs is lazy-loaded via utils/excel so it stays out of the main bundle —
// the cost is paid only when the user clicks Export.
// ─────────────────────────────────────────────────────────────────────────

import { httpFetch } from './httpClient';

/**
 * Tolerant GET. Returns parsed JSON, or null on 404 / empty / network error,
 * so one missing or never-visited screen never aborts the whole export.
 * @param {string} path  e.g. `/api/treaties/123/large-losses`
 * @param {AbortSignal} [signal]
 * @returns {Promise<any|null>}
 */
export async function fetchJson(path, signal) {
  try {
    return await httpFetch(path, { method: 'GET', signal });
  } catch (err) {
    if (err && err.status === 404) return null;
    console.warn(`[contractWorkbook] fetch failed: ${path}`, err?.message || err);
    return null;
  }
}

// ── Generic serializers ─────────────────────────────────────────────────
// Turn an arbitrary screen payload into an array-of-arrays (AoA) the excel
// util drops straight onto a worksheet. Tailored builders in the registries
// can ignore these and hand-roll richer layouts; everything else falls back
// here so every screen still produces a populated sheet.

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function cellValue(v) {
  if (v == null) return '';
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Humanise a snake_case / camelCase key into a header label. */
export function humanizeKey(k) {
  return String(k)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Array of flat objects → [headerRow, ...dataRows].
 * Columns default to the union of keys in first-seen order.
 */
export function tableSheet(rows, { columns, columnLabels } = {}) {
  const arr = Array.isArray(rows) ? rows : [];
  if (!arr.length) return [['(no rows)']];
  const keys = columns || (() => {
    const seen = [];
    for (const r of arr) {
      if (isPlainObject(r)) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    }
    return seen.length ? seen : ['value'];
  })();
  const header = keys.map((k) => (columnLabels && columnLabels[k]) || humanizeKey(k));
  const body = arr.map((r) =>
    keys.map((k) => cellValue(isPlainObject(r) ? r[k] : (k === 'value' ? r : ''))),
  );
  return [header, ...body];
}

/** Plain object → two-column Field/Value sheet. */
export function kvSheet(obj, { skip = [], order } = {}) {
  if (!isPlainObject(obj)) return [['Field', 'Value'], ['Value', cellValue(obj)]];
  const keys = order || Object.keys(obj);
  const rows = [['Field', 'Value']];
  for (const k of keys) {
    if (skip.includes(k)) continue;
    if (!(k in obj)) continue;
    rows.push([humanizeKey(k), cellValue(obj[k])]);
  }
  return rows.length > 1 ? rows : [['Field', 'Value'], ['(empty)', '']];
}

/** Pick table-vs-kv automatically based on payload shape. */
export function autoSheet(data) {
  if (data == null) return [['(no saved data for this screen)']];
  if (Array.isArray(data)) return data.length ? tableSheet(data) : [['(no saved data for this screen)']];
  if (isPlainObject(data)) {
    // Thin wrapper around a single array (e.g. {rows:[…]}, {losses:[…]},
    // {ldfs:[…]}) → table-ise that array.
    const arrKeys = Object.keys(data).filter((k) => Array.isArray(data[k]) && data[k].length);
    if (arrKeys.length === 1) return tableSheet(data[arrKeys[0]]);
    return kvSheet(data);
  }
  return [['Field', 'Value'], ['Value', cellValue(data)]];
}

/** A one-row informational sheet, for screens with no separately-saved data. */
export function noteSheet(text) {
  return [[String(text || 'No saved data for this screen.')]];
}

// ── Workbook builder ─────────────────────────────────────────────────────

function autoWidth(ws, aoa) {
  const ncols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  ws.columns = Array.from({ length: ncols }, (_, i) => ({
    width: Math.min(60, Math.max(10, ...aoa.map((r) => String(r[i] ?? '').length + 2))),
  }));
}

// Mirror the excel util's sheet-name rules + add cross-sheet uniqueness.
// (appendSheet re-sanitises, idempotently, so passing an already-safe name
//  is fine.)
function makeNamer() {
  const used = new Set();
  return (raw) => {
    let name = String(raw || 'Sheet').replace(/[*?:/\\[\]]/g, '_').slice(0, 31) || 'Sheet';
    if (!used.has(name)) { used.add(name); return name; }
    let i = 2;
    while (used.has(`${name.slice(0, 28)}_${i}`)) i += 1;
    name = `${name.slice(0, 28)}_${i}`;
    used.add(name);
    return name;
  };
}

/**
 * A build() may return either:
 *   • an AoA (array of arrays)                          → one sheet
 *   • [{ name, aoa }, …]                                 → several sub-sheets
 * This normalises both into [{ subName|null, aoa }].
 */
function normaliseBuildResult(result) {
  if (!Array.isArray(result) || !result.length) return [{ subName: null, aoa: noteSheet() }];
  const first = result[0];
  if (isPlainObject(first) && Array.isArray(first.aoa)) {
    return result.map((s) => ({ subName: s.name || null, aoa: Array.isArray(s.aoa) && s.aoa.length ? s.aoa : noteSheet() }));
  }
  return [{ subName: null, aoa: result }];
}

/**
 * @param {object} args
 * @param {string}   args.contractId
 * @param {string[]} args.order      ordered wizard step keys (getWizardNav(...).order)
 * @param {Record<string,string>} args.labels   step key → display label (STEP_LABELS)
 * @param {Record<string,{fetch?:Function, build?:Function, sheetName?:string}>} args.registry
 * @param {object}   [args.ctx]      passed to every fetch/build (contractId, isQuote, finalData, header, …)
 * @param {object}   [args.header]   cover-sheet header fields
 * @param {string}   [args.filename]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ sheets:number }>}
 */
export async function buildContractWorkbook({
  contractId, order = [], labels = {}, registry = {}, ctx = {}, header = {}, filename, signal,
}) {
  const { createWorkbook } = await import('./excel');
  const wb = await createWorkbook();
  const nameOf = makeNamer();

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const coverRows = [
    ['UNIVERSE — CONTRACT EXPORT'],
    [],
    ['Cedant', header.cedantName || '–'],
    ['Country', header.countryName || '–'],
    ['UW Year', header.uwYear || '–'],
    ['Treaty Type', header.treatyTypeStr || '–'],
    ['Mode', header.modeLabel || '–'],
    ['Currency', header.currency || '–'],
    ['Contract / Quote ID', String(contractId || '–')],
    ['Generated (UTC)', generatedAt],
    [],
    ['#', 'Screen', 'Sheet(s)'],
  ];

  // Build all data sheets first so the Contents page can index them.
  const plan = []; // { displayName, aoa }
  let seq = 0;
  for (const key of order) {
    seq += 1;
    const label = labels[key] || key;
    const entry = registry[key] || {};
    let result;
    try {
      const data = entry.fetch ? await entry.fetch({ ...ctx, contractId, signal }) : null;
      result = entry.build ? await entry.build(data, { ...ctx, contractId, label, signal }) : autoSheet(data);
    } catch (err) {
      console.warn(`[contractWorkbook] build failed for ${key}`, err?.message || err);
      result = noteSheet(`Export error for this screen: ${err?.message || 'unknown'}`);
    }
    const subs = normaliseBuildResult(result);
    const prefix = String(seq).padStart(2, '0');
    const sheetLabels = [];
    for (const sub of subs) {
      const base = sub.subName
        ? `${prefix} ${entry.sheetName || label} – ${sub.subName}`
        : `${prefix} ${entry.sheetName || label}`;
      const displayName = nameOf(base);
      plan.push({ displayName, aoa: sub.aoa });
      sheetLabels.push(displayName);
    }
    coverRows.push([seq, label, sheetLabels.join('  |  ')]);
  }

  const wsCover = wb.appendSheet('Contents', coverRows);
  wsCover.columns = [{ width: 6 }, { width: 34 }, { width: 46 }];

  for (const s of plan) {
    const ws = wb.appendSheet(s.displayName, s.aoa);
    autoWidth(ws, s.aoa);
  }

  const fname = filename || `Universe_Contract_${contractId || 'export'}.xlsx`;
  await wb.writeFile(fname);
  return { sheets: plan.length };
}
