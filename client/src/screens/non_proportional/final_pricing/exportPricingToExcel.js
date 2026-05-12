/**
 * exportPricingToExcel.js
 * Exports NP Final Pricing screen data to a multi-sheet Excel workbook.
 * exceljs is lazy-loaded via the excel util so it stays out of the main
 * vendor bundle.
 */
function toNum(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function pct(v) { const n = toNum(v); return n != null ? `${n.toFixed(2)}%` : '–'; }
function fmtNum(v) { const n = toNum(v); return n != null ? Math.round(n) : null; }

function appendStyledSheet(wb, name, headers, rows) {
  const ws = wb.appendSheet(name, [headers, ...rows]);
  ws.columns = headers.map((h, i) => ({
    width: Math.max(14, String(h).length + 2, ...rows.map(r => String(r[i] ?? '').length)),
  }));
  return ws;
}

export async function exportNpPricingToExcel(data) {
  const { createWorkbook } = await import('../../../utils/excel');
  const {
    layers = [], quoteStructures = [], mode,
    treatyTypeStr, cedantName, countryName, uwYear,
    currency, isQuote, totalROL, egnpi, totalLimit,
    programmeRows = [],
  } = data;

  const wb = await createWorkbook();

  // ── Sheet 1: Summary ─────────────────────────────────────────────────
  const summaryRows = [
    ['Cedant',               cedantName   || '–'],
    ['Country',              countryName  || '–'],
    ['UW Year',              uwYear       || '–'],
    ['Treaty Type',          treatyTypeStr|| '–'],
    ['XL Mode',              mode         || '–'],
    ['Currency',             currency     || '–'],
    ['EST. GNPI (100%)',     fmtNum(egnpi)],
    ['Total Programme Limit',fmtNum(totalLimit)],
    ['Total ROL',            pct(totalROL)],
  ];
  const wsSummary = wb.appendSheet('Summary', [['Field', 'Value'], ...summaryRows]);
  wsSummary.columns = [{ width: 28 }, { width: 22 }];

  // ── Sheet 2: Risk XL Layers ──────────────────────────────────────────
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
    appendStyledSheet(wb, 'Risk XL Layers', headers, rows);
  }

  // ── Sheet 3: Cat XL Layers ───────────────────────────────────────────
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
    appendStyledSheet(wb, 'Cat XL Layers', headers, rows);
  }

  // ── Sheet 4: Pricing Summary ─────────────────────────────────────────
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
    // Weighted totals row
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
    appendStyledSheet(wb, 'Pricing Summary', headers, rows);
  }

  // ── Sheet 5: Programme Limits ────────────────────────────────────────
  if (!isQuote && programmeRows.length) {
    const headers = ['Layer','Share %','Premium','Per Risk Limit','Cat Limit',
      'Cedant Total Limit','Agg Contribution','Total Country Agg','Annual Agg Limit','Expected Shortfall'];
    const rows = programmeRows.map((r, i) => [
      layers[i]?.layer || `L${i+1}`, pct(layers[i]?.share),
      fmtNum(r.prem), fmtNum(r.perRisk), fmtNum(r.catLim),
      fmtNum(r.cedantTot), fmtNum(r.aggContrib), fmtNum(r.totalCountryAgg),
      fmtNum(r.aal), fmtNum(r.es),
    ]);
    appendStyledSheet(wb, 'Programme Limits', headers, rows);
  }

  // ── Sheet 6+: Quote Structures ───────────────────────────────────────
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
      appendStyledSheet(wb, `Structure ${sIdx+1}`, headers, rows);
    });
  }

  // ── Download ─────────────────────────────────────────────────────────
  const filename = `NP_Pricing_${(cedantName||'Export').replace(/\s+/g,'_')}_${uwYear||new Date().getFullYear()}.xlsx`;
  await wb.writeFile(filename);
}
