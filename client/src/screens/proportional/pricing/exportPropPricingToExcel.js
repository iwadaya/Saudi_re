/**
 * exportPropPricingToExcel.js
 * Builds the Proportional Pricing sheets.
 *
 * A pure sheet-builder (`buildPropPricingSheets`) consumed by the
 * whole-contract workbook exporter (propWorkbookExporters.js) for the
 * Treaty-Detail -> Pricing sequence. No I/O here — the exporter owns
 * the workbook and download.
 */
import { COMPONENT_ROWS, SHARE_COLS, parsePct } from './components/propPricingConstants.js';
import { toN as cn } from '../../../utils/format.js';

// Component-grid values are ALREADY percent strings ('63.40%') — parse them
// with the screen's own parsePct (fraction out; '%' strings never rescaled)
// and re-format, instead of multiplying an already-percent number by 100.
function pct(v, d=2) { const n = parsePct(v); return n ? `${(n*100).toFixed(d)}%` : '–'; }
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
    // Grid key is 'actual' (propPricingHydration maps actual_stats_value → 'actual').
    return [name, pct(c.actuarial), pct(c.uw), pct(c.market), pct(c.actual)];
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
