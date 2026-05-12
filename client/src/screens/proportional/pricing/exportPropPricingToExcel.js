/**
 * exportPropPricingToExcel.js
 * Exports Proportional Pricing screen data to Excel.
 *
 * exceljs is lazy-loaded via the excel util so it stays out of the main
 * vendor bundle. The user pays the cost only if they click Export.
 */
import { COMPONENT_ROWS, SHARE_COLS } from './components/propPricingConstants.js';
import { toN as cn } from '../../../utils/format.js';

function pct(v, d=2) { const n = cn(v); return n ? `${(n*100).toFixed(d)}%` : '–'; }
function fmtN(v) { const n = cn(v); return n ? Math.round(n) : null; }

function appendStyledSheet(wb, name, headers, rows) {
  const ws = wb.appendSheet(name, [headers, ...rows]);
  ws.columns = headers.map((h, i) => ({
    width: Math.max(14, String(h).length + 2, ...rows.map(r => String(r[i] ?? '').length)),
  }));
  return ws;
}

export async function exportPropPricingToExcel(data) {
  const { createWorkbook } = await import('../../../utils/excel');
  const {
    cedantName = '', countryName = '', uwYear = '', currency = 'SAR',
    treatyType = '',
    components = {}, yearly = [], epiSplit = [],
    shareRows = [], shareGrid = {},
    leads = [], comment = '',
    totalEpi = 0, qsEpi = 0, surplusEpi = 0,
    techResult = null,
  } = data;

  const wb = await createWorkbook();

  // ── Sheet 1: Summary ────────────────────────────────────────────────
  const summaryData = [
    ['Field', 'Value'],
    ['Cedant',       cedantName   || '–'],
    ['Country',      countryName  || '–'],
    ['UW Year',      uwYear       || '–'],
    ['Treaty Type',  treatyType   || '–'],
    ['Currency',     currency     || '–'],
    ['Total EPI',    fmtN(totalEpi)],
    ['QS EPI',       fmtN(qsEpi)],
    ['Surplus EPI',  fmtN(surplusEpi)],
    ['Comment',      comment || '–'],
  ];
  const wsSummary = wb.appendSheet('Summary', summaryData);
  wsSummary.columns = [{ width: 22 }, { width: 28 }];

  // ── Sheet 2: Pricing Components ──────────────────────────────────────
  const compHeaders = ['Component', 'Actuarial', 'UW', 'Market', 'Actual Stats'];
  const compRows = COMPONENT_ROWS.map(name => {
    const c = components[name] || {};
    return [
      name,
      pct(c.actuarial), pct(c.uw), pct(c.market), pct(c.actual_stats),
    ];
  });
  // Add tech result row
  if (techResult !== null) {
    compRows.push(['Technical Result', pct(techResult), '', '', '']);
  }
  appendStyledSheet(wb, 'Pricing Components', compHeaders, compRows);

  // ── Sheet 3: Historical Yearly ────────────────────────────────────────
  if (yearly.length > 0) {
    const yHeaders = ['UW Year', 'Ultimate Premium', 'Ultimate Loss', 'Loss Ratio %',
      'Commission', 'Brokerage', 'Technical Result'];
    const yRows = yearly.map(r => [
      r.uw_year,
      fmtN(r.ultimate_premium),
      fmtN(r.ultimate_loss),
      r.loss_ratio != null ? `${(cn(r.loss_ratio)*100).toFixed(2)}%` : '–',
      fmtN(r.commission_amt),
      fmtN(r.brokerage_amt),
      fmtN(r.technical_result),
    ]);
    appendStyledSheet(wb, 'Historical Yearly', yHeaders, yRows);
  }

  // ── Sheet 4: EPI Split by COB ─────────────────────────────────────────
  if (epiSplit.length > 0) {
    const epiHeaders = ['Class of Business', 'Premium'];
    const epiRows = epiSplit.map(r => [
      r.cob_name || r.name || r.class_of_business || '–',
      fmtN(r.premium),
    ]);
    epiRows.push(['TOTAL', epiSplit.reduce((s, r) => s + cn(r.premium), 0)]);
    appendStyledSheet(wb, 'EPI by Class', epiHeaders, epiRows);
  }

  // ── Sheet 5: Programme Limits & Downside ─────────────────────────────
  if (shareRows.length > 0) {
    const plHeaders = ['Share', ...SHARE_COLS.map(c => c.label)];
    const plRows = shareRows.map(label => {
      const g = shareGrid[label] || {};
      return [label, ...SHARE_COLS.map(c => fmtN(g[c.key]))];
    });
    appendStyledSheet(wb, 'Programme Limits', plHeaders, plRows);
  }

  // ── Sheet 6: Market (Leads / Reinsurers) ─────────────────────────────
  if (leads.length > 0) {
    const mHeaders = ['Reinsurer', 'Role', 'Written Line %', 'Capacity'];
    const mRows = leads.map(l => [
      l.reinsurer_name || l.name || '–',
      l.role || '–',
      l.written_line_pct != null ? `${cn(l.written_line_pct).toFixed(4)}%` : '–',
      fmtN(l.capacity),
    ]);
    appendStyledSheet(wb, 'Market', mHeaders, mRows);
  }

  // ── Download ────────────────────────────────────────────────────────
  const filename = `Prop_Pricing_${(cedantName||'Export').replace(/\s+/g,'_')}_${uwYear||new Date().getFullYear()}.xlsx`;
  await wb.writeFile(filename);
}
