// client/src/screens/dashboard/dashboardExport.js
// Client-side "Export to Excel" for the dashboards. Builds a branded Universe
// workbook off the data the active tab already loaded — no server endpoint —
// so the file reflects the exact currency + filter state on screen. The treaty
// dashboard uses the default manifest; the fac dashboard passes its own
// manifest + label (facDashboardColumns.js) through the same writer.
//
// Reuses the shared XLSX theme (shared/universeXlsxTheme.js) and the lazy
// exceljs wrapper (utils/excel → createWorkbook) that the portfolio export
// uses, so exceljs stays out of the initial bundle and styling isn't dupliated.
import { createWorkbook } from '../../utils/excel';
import { todayIso } from '../../utils/format';
import { DASHBOARD_EXPORT_MANIFEST, KPI_ROWS } from './dashboardColumns';

// kind → Excel numFmt. Raw numeric values are written; these only control
// display. pct values are fractions (0.21 → "21.00%").
const NUMFMT = {
  money: '#,##0',
  pct: '0.00%',
  mult: '0.00"×"',
  permille: '0.00"‰"',   // fac rates are already in ‰ (1.23 → 1.23‰)
  int: '#,##0',
  text: null,
};

// Resolve a possibly-dotted manifest key against the tab payload.
function resolvePath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Return the block's data if present & non-empty, else null (block is skipped).
function resolveBlock(block, data) {
  if (block.type === 'kpis') {
    const kpis = data?.kpis;
    if (!kpis) return null;
    return (block.cols || KPI_ROWS).some((c) => kpis[c.key] != null) ? kpis : null;
  }
  const v = resolvePath(data, block.key);
  if (block.type === 'pivot') {
    return v && Array.isArray(v.columns) && v.columns.length ? v : null;
  }
  return Array.isArray(v) && v.length ? v : null; // table | series
}

// Write one cell with the raw value + numFmt for its kind. null / blank / N/A
// (NP balance, prop ROL) is left BLANK — never coerced to 0.
function setCell(cell, value, kind) {
  if (kind === 'text') {
    if (value == null || value === '') return;
    cell.value = String(value);
    return;
  }
  if (value == null) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  cell.value = n;
  if (NUMFMT[kind]) cell.numFmt = NUMFMT[kind];
}

const colWidth = (c) => (c.kind === 'text' ? 26 : 15);

// Header + body rows for a flat block (table / series).
function writeRows(ws, T, sheet, subtitle, cols, rows) {
  const ncols = cols.length;
  const hdr = T.titleBar(ws, ncols, sheet, subtitle);
  ws.getRow(hdr).values = cols.map((c) => c.label);
  T.headerRow(ws, hdr, ncols);
  const firstData = hdr + 1;
  rows.forEach((row, i) => {
    const rr = ws.getRow(firstData + i);
    cols.forEach((c, ci) => setCell(rr.getCell(ci + 1), row[c.key], c.kind));
  });
  if (rows.length) T.zebra(ws, firstData, firstData + rows.length - 1, ncols);
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = colWidth(c); });
  T.finishSheet(ws, hdr, 1);
}

// Two-column Metric | Value sheet; each value keeps its own kind/numFmt.
function writeKpis(ws, T, sheet, subtitle, kpis, cols) {
  const hdr = T.titleBar(ws, 2, sheet, subtitle);
  ws.getRow(hdr).values = ['Metric', 'Value'];
  T.headerRow(ws, hdr, 2);
  const firstData = hdr + 1;
  cols.forEach((m, i) => {
    const rr = ws.getRow(firstData + i);
    setCell(rr.getCell(1), m.label, 'text');
    setCell(rr.getCell(2), kpis[m.key], m.kind);
  });
  T.zebra(ws, firstData, firstData + cols.length - 1, 2);
  ws.getColumn(1).width = 26; ws.getColumn(2).width = 18;
  T.finishSheet(ws, hdr, 1);
}

// Pivot: [rowLabel, ...columns, Total] header, one body row per data row, then
// a styled Totals row. Every value cell uses the block's single kind.
function writePivot(ws, T, sheet, subtitle, piv, kind, rowLabel) {
  const cols = piv.columns || [];
  const header = [rowLabel, ...cols, 'Total'];
  const ncols = header.length;
  const hdr = T.titleBar(ws, ncols, sheet, subtitle);
  ws.getRow(hdr).values = header;
  T.headerRow(ws, hdr, ncols);
  const firstData = hdr + 1;
  const rows = piv.rows || [];
  rows.forEach((row, i) => {
    const rr = ws.getRow(firstData + i);
    setCell(rr.getCell(1), row.region ?? row.lob ?? row.key ?? '', 'text');
    cols.forEach((c, ci) => setCell(rr.getCell(ci + 2), row.values?.[c], kind));
    setCell(rr.getCell(ncols), row.total, kind);
  });
  if (rows.length) T.zebra(ws, firstData, firstData + rows.length - 1, ncols);
  const totalsIdx = firstData + rows.length;
  const tr = ws.getRow(totalsIdx);
  setCell(tr.getCell(1), 'Total', 'text');
  cols.forEach((c, ci) => setCell(tr.getCell(ci + 2), piv.totals?.values?.[c], kind));
  setCell(tr.getCell(ncols), piv.totals?.total, kind);
  T.totalRow(ws, totalsIdx, ncols);
  ws.getColumn(1).width = 26;
  for (let c = 2; c <= ncols; c++) ws.getColumn(c).width = 14;
  T.finishSheet(ws, hdr, 1);
}

function metaLines({ tabLabel, currency, filters, generated, notes }) {
  const f = filters || {};
  const parts = [];
  if (f.region) parts.push(`Region: ${f.region}`);
  if (f.uwYear) parts.push(`UW Year: ${f.uwYear}`);
  if (f.month) parts.push(`Month: ${f.month}`);
  if (f.treatyType) parts.push(`Treaty Type: ${f.treatyType}`);
  if (f.facType) parts.push(`FAC Type: ${f.facType}`);
  if (f.yearsBack) parts.push(`Years back: ${f.yearsBack}`);
  return [
    ['Tab', tabLabel],
    ['Currency', currency],
    ['Generated', generated.toLocaleString()],
    ['Filters', parts.length ? parts.join('   ·   ') : 'All'],
    ['Notes', notes || 'Raw numeric values; balance = limit ÷ premium; blank cells are N/A.'],
  ];
}

function blockDesc(block) {
  if (block.type === 'kpis') return 'Headline KPIs';
  if (block.type === 'pivot') return `${block.resolved.rows?.length || 0} rows × ${block.resolved.columns?.length || 0} cols`;
  return `${block.resolved.length} rows`;
}

/**
 * Build and download the active tab's workbook.
 * `manifests` / `label` / `kpiRows` / `notes` default to the treaty
 * dashboard's; the fac dashboard passes its own.
 * @returns {Promise<boolean>} false if the tab had nothing to export.
 */
export async function exportDashboardTab({
  tabId, tabLabel, data, currency, filters,
  manifests = DASHBOARD_EXPORT_MANIFEST, label = 'Dashboard', kpiRows = KPI_ROWS, notes,
}) {
  const manifest = manifests[tabId] || [];
  const blocks = [];
  for (const b of manifest) {
    const resolved = resolveBlock(b, data);
    if (resolved != null) blocks.push({ ...b, resolved });
  }
  if (!blocks.length) return false;

  const wb = await createWorkbook();              // lazy-loads exceljs
  const workbook = wb.workbook;
  const T = await import('../../../../shared/universeXlsxTheme.js');

  const date = todayIso();
  const meta = {
    title: `${label} — ${tabLabel}`,
    date,
    lines: metaLines({ tabLabel, currency, filters, generated: new Date(), notes }),
  };
  T.coverSheet(workbook, blocks.map((b) => ({ name: b.sheet, desc: blockDesc(b) })), meta);

  const subtitle = `${tabLabel} · ${currency}`;
  for (const b of blocks) {
    const ws = workbook.addWorksheet(b.sheet);
    if (b.type === 'kpis') writeKpis(ws, T, b.sheet, subtitle, b.resolved, b.cols || kpiRows);
    else if (b.type === 'pivot') writePivot(ws, T, b.sheet, subtitle, b.resolved, b.kind, b.rowLabel || 'Row');
    else writeRows(ws, T, b.sheet, subtitle, b.cols, b.resolved); // table | series
  }

  await wb.writeFile(`Universe_${label.replace(/[^A-Za-z0-9]+/g, '')}_${tabId}_${currency}_${date}.xlsx`);
  return true;
}
