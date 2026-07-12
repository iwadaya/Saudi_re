/**
 * exportPricingToExcel.js
 * Builds the NP Final Pricing sheets.
 *
 * A pure sheet-builder (`buildNpPricingSheets`) consumed by the
 * whole-contract workbook exporter (npWorkbookExporters.js) for the
 * Treaty-Detail -> Final-Pricing sequence. No I/O here — the exporter
 * owns the workbook and download.
 */
function toNum(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function pct(v) { const n = toNum(v); return n != null ? `${n.toFixed(2)}%` : '–'; }
function fmtNum(v) { const n = toNum(v); return n != null ? Math.round(n) : null; }

/**
 * Pure builder: returns an ordered list of { name, aoa } sheets.
 * No I/O, no workbook - callers decide what to do with them.
 * @returns {Array<{name:string, aoa:Array<Array<any>>}>}
 */
export function buildNpPricingSheets(data) {
  const {
    layers = [], quoteStructures = [], mode,
    treatyTypeStr, cedantName, countryName, uwYear,
    currency, isQuote, totalROL, egnpi, totalLimit,
    programmeRows = [],
  } = data || {};

  const sheets = [];

  // -- Summary --
  sheets.push({
    name: 'Summary',
    aoa: [
      ['Field', 'Value'],
      ['Cedant',               cedantName   || '–'],
      ['Country',              countryName  || '–'],
      ['UW Year',              uwYear       || '–'],
      ['Treaty Type',          treatyTypeStr|| '–'],
      ['XL Mode',              mode         || '–'],
      ['Currency',             currency     || '–'],
      ['EST. GNPI (100%)',     fmtNum(egnpi)],
      ['Total Programme Limit',fmtNum(totalLimit)],
      ['Total ROL',            pct(totalROL)],
    ],
  });

  // -- Risk XL Layers --
  const riskLayers = layers.filter(l => l.risk || (!l.cat));
  if (riskLayers.length) {
    const headers = ['Layer','Limit','Deductible','Pure Burn %','Pareto %',
      'Burn+Pareto %','Exposure MBBEPD %','Wt Burn %','Wt Exp %','Loading %','Total ROL %','UW Price %'];
    const rows = riskLayers.map(l => [
      l.layer, fmtNum(l.limit), fmtNum(l.deductible),
      pct(l.riskPureBurn), pct(l.riskPareto), pct(l.riskAvgBurnPareto),
      pct(l.riskExposure), toNum(l.riskWeightBurn), toNum(l.riskWeightExposure),
      toNum(l.riskLoading), pct(l.riskTotalPrice), pct(l.riskUwPrice || l.riskTotalPrice),
    ]);
    rows.push(['TOTAL', riskLayers.reduce((s,l) => s+(toNum(l.limit)||0), 0), ...Array(10).fill('')]);
    sheets.push({ name: 'Risk XL Layers', aoa: [headers, ...rows] });
  }

  // -- Cat XL Layers --
  const catLayers = layers.filter(l => l.cat);
  if (catLayers.length) {
    const headers = ['Layer','Limit','Deductible','Pure Burn %','Pareto %',
      'Burn+Pareto %','Exposure MBBEPD %','Wt Burn %','Wt Exp %','Loading %','Total ROL %','UW Price %'];
    const rows = catLayers.map(l => [
      l.layer, fmtNum(l.limit), fmtNum(l.deductible),
      pct(l.catPureBurn), pct(l.catPareto), pct(l.catAvgBurnPareto),
      pct(l.catExposure), toNum(l.catWeightBurn), toNum(l.catWeightExposure),
      toNum(l.catLoading), pct(l.catTotalPrice), pct(l.catUwPrice || l.catTotalPrice),
    ]);
    rows.push(['TOTAL', catLayers.reduce((s,l) => s+(toNum(l.limit)||0), 0), ...Array(10).fill('')]);
    sheets.push({ name: 'Cat XL Layers', aoa: [headers, ...rows] });
  }

  // -- Pricing Summary --
  if (layers.length) {
    const headers = ['Layer','Limit','Deductible','Reinstatements',
      'Reinsurer %','Lead %','Expiring %','Hist. Margin %','Margin %','Tech Ratio %','% Diff'];
    const rows = layers.map(l => {
      const rp = toNum(l.reinsurerPricing), lp = toNum(l.leadPricing);
      const diff = (rp && lp) ? ((rp / lp) - 1) * 100 : null;
      const n = parseInt(l.noReinst ?? l.num_reinstatements ?? '', 10);
      const p = parseFloat(String(l.reinstPct ?? l.reinstatement_pct ?? '').replace(/%/g, ''));
      const reinst = (n > 0 && Number.isFinite(p)) ? `${n}@${p.toFixed(0)}%` : (n > 0 ? String(n) : '–');
      return [
        l.layer, fmtNum(l.limit), fmtNum(l.deductible), reinst,
        pct(l.reinsurerPricing), pct(l.leadPricing), pct(l.expiringPricing),
        pct(l.historicalMargin), pct(l.reinsurerMargin), pct(l.technicalRatio),
        diff != null ? `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%` : '–',
      ];
    });
    const totLim = layers.reduce((s,l) => s+(toNum(l.limit)||0), 0);
    if (totLim > 0) {
      const sp = f => layers.reduce((s,l) => s+(toNum(l.limit)||0)*(toNum(l[f])||0), 0) / totLim;
      const wR = sp('reinsurerPricing'), wL = sp('leadPricing'), wE = sp('expiringPricing');
      const totP = layers.reduce((s,l) => s+(toNum(l.limit)||0)*(toNum(l.reinsurerPricing)||0), 0);
      const wH = totP > 0 ? layers.reduce((s,l) => s+(toNum(l.limit)||0)*(toNum(l.reinsurerPricing)||0)*(toNum(l.historicalMargin)||0), 0) / totP : 0;
      const wT = wH ? 100 - wH : 0;
      const d = (wR && wL) ? ((wR / wL) - 1) * 100 : null;
      rows.push(['TOTAL', totLim, '', '', pct(wR), pct(wL), pct(wE), pct(wH), '–', pct(wT),
        d != null ? `${d >= 0 ? '+' : ''}${d.toFixed(2)}%` : '–']);
    }
    sheets.push({ name: 'Pricing Summary', aoa: [headers, ...rows] });
  }

  // -- Programme Limits --
  if (!isQuote && programmeRows.length) {
    const headers = ['Layer','Share %','Premium','Per Risk Limit','Cat Limit',
      'Cedant Total Limit','Agg Contribution','Total Country Agg','Annual Agg Limit','Expected Shortfall'];
    const rows = programmeRows.map((r, i) => [
      layers[i]?.layer || `L${i+1}`, pct(layers[i]?.share),
      fmtNum(r.prem), fmtNum(r.perRisk), fmtNum(r.catLim),
      fmtNum(r.cedantTot), fmtNum(r.aggContrib), fmtNum(r.totalCountryAgg),
      fmtNum(r.aal), fmtNum(r.es),
    ]);
    sheets.push({ name: 'Programme Limits', aoa: [headers, ...rows] });
  }

  // -- Quote Structures --
  if (isQuote && quoteStructures.length) {
    quoteStructures.forEach((st, sIdx) => {
      const stLayers = Array.isArray(st.layers) ? st.layers : [];
      if (!stLayers.length) return;
      const headers = ['Layer','Type','Limit','Deductible','EGNPI','Rate/ROL %','Reinsurer %','Lead %','Expiring %'];
      const rows = stLayers.map(l => [
        l.layerNumber || l.layer_number,
        l.xlType || st.xlType || '–',
        fmtNum(l.limit || l.layer_limit),
        fmtNum(l.deductible || l.attachment),
        fmtNum(l.egnpi), pct(l.rate || l.rol),
        pct(l.reinsurerPricing), pct(l.leadPricing), pct(l.expiringPricing),
      ]);
      sheets.push({ name: `Structure ${sIdx+1}`, aoa: [headers, ...rows] });
    });
  }

  return sheets;
}
