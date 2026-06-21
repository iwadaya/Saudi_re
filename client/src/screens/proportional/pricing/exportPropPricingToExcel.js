/**
 * exportPropPricingToExcel.js
 * Builds the Proportional Pricing sheets.
 *
 * Split into a pure sheet-builder (`buildPropPricingSheets`) and a thin
 * download wrapper (`exportPropPricingToExcel`). The builder is reused by the
 * whole-contract workbook exporter (propWorkbookExporters.js) so the pricing
 * sheets are identical whether you export just this screen or the full
 * Treaty-Detail -> Pricing sequence.
 *
 * exceljs is lazy-loaded via the excel util so it stays out of the main
 * vendor bundle. The user pays the cost only if they click Export.
 */
import { COMPONENT_ROWS, SHARE_COLS } from './components/propPricingConstants.js';
import { toN as cn } from '../../../utils/format.js';

function pct(v, d=2) { const n = cn(v); return n ? `${(n*100).toFixed(d)}%` : '–'; }
function fmtN(v) { const n = cn(v); return n ? Math.round(n) : null; }

/**
 * Pure builder: returns an ordered list of { name, aoa } sheets.
 * @returns {Array<{name:string, aoa:Array<Array<any>>}>}
 */
export function buildPropPricingSheets(data) {
  const {
    cedantName = '', countryName = '', uwYear = '', currency = 'SAR',
    treatyType = '',
    components = {}, yearly = [], epiSplit = [],
    shareRows = [], shareGrid = {},
    leads = [], comment = '',
    totalEpi = 0, qsEpi = 0, surplusEpi = 0,
    techResult = null,
  } = data || {};

  const sheets = [];

  // -- Summary --
  sheets.push({
    name: 'Summary',
    aoa: [
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
    ],
  });

  // -- Pricing Components --
  const compHeaders = ['Component', 'Actuarial', 'UW', 'Market', 'Actual Stats'];
  const compRows = COMPONENT_ROWS.map(name => {
    const c = components[name] || {};
    return [name, pct(c.actuarial), pct(c.uw), pct(c.market), pct(c.actual_stats)];
  });
  if (techResult !== null) compRows.push(['Technical Result', pct(techResult), '', '', '']);
  sheets.push({ name: 'Pricing Components', aoa: [compHeaders, ...compRows] });

  // -- Historical Yearly --
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
    sheets.push({ name: 'Historical Yearly', aoa: [yHeaders, ...yRows] });
  }

  // -- EPI Split by COB --
  if (epiSplit.length > 0) {
    const epiHeaders = ['Class of Business', 'Premium'];
    const epiRows = epiSplit.map(r => [
      r.cob_name || r.name || r.class_of_business || '–',
      fmtN(r.premium),
    ]);
    epiRows.push(['TOTAL', epiSplit.reduce((s, r) => s + cn(r.premium), 0)]);
    sheets.push({ name: 'EPI by Class', aoa: [epiHeaders, ...epiRows] });
  }

  // -- Programme Limits & Downside --
  if (shareRows.length > 0) {
    const plHeaders = ['Share', ...SHARE_COLS.map(c => c.label)];
    const plRows = shareRows.map(label => {
      const g = shareGrid[label] || {};
      return [label, ...SHARE_COLS.map(c => fmtN(g[c.key]))];
    });
    sheets.push({ name: 'Programme Limits', aoa: [plHeaders, ...plRows] });
  }

  // -- Market (Leads / Reinsurers) --
  if (leads.length > 0) {
    const mHeaders = ['Reinsurer', 'Role', 'Written Line %', 'Capacity'];
    const mRows = leads.map(l => [
      l.reinsurer_name || l.name || '–',
      l.role || '–',
      l.written_line_pct != null ? `${cn(l.written_line_pct).toFixed(4)}%` : '–',
      fmtN(l.capacity),
    ]);
    sheets.push({ name: 'Market', aoa: [mHeaders, ...mRows] });
  }

  return sheets;
}

function applyAutoWidth(ws, aoa) {
  const ncols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  ws.columns = Array.from({ length: ncols }, (_, i) => ({
    width: Math.max(14, ...aoa.map((r) => String(r[i] ?? '').length + 2)),
  }));
}

/** Standalone "Export this screen" download - unchanged output. */
export async function exportPropPricingToExcel(data) {
  const { createWorkbook } = await import('../../../utils/excel');
  const wb = await createWorkbook();
  for (const s of buildPropPricingSheets(data)) {
    const ws = wb.appendSheet(s.name, s.aoa);
    applyAutoWidth(ws, s.aoa);
  }
  const { cedantName, uwYear } = data || {};
  const filename = `Prop_Pricing_${(cedantName||'Export').replace(/\s+/g,'_')}_${uwYear||new Date().getFullYear()}.xlsx`;
  await wb.writeFile(filename);
}
