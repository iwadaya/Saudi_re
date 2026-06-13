// client/src/screens/home/exportPortfolio.js
// Themed portfolio export (Cover + Proportional + Non-Proportional sheets).
// Extracted from HomeScreen.jsx to keep that screen under the 800-line budget,
// matching the pattern of exportPropPricingToExcel.js / exportPricingToExcel.js.
import { api } from '../../api';
import { todayIso } from '../../utils/format';

// ── Portfolio export ──────────────────────────────────────────────────────
export async function exportPortfolioToExcel() {
  const { createWorkbook } = await import('../../utils/excel');
  const { UT, titleBar, headerRow, zebra, finishSheet, coverSheet } =
    await import('../../../../shared/universeXlsxTheme.js');
  const { prop, np } = await api.getPortfolioExport();

  // Money / int / rate fields pass straight through.
  const num = v => (v == null || v === '') ? null : Number(v);
  // Whole-percent source fields (25 → 0.25) — store as a fraction for '0.00%'.
  // NP rol/rate are now canonically whole-percent in the DB too (e.g. 4.5),
  // normalized on the write path and backfilled (migration 117), so they use
  // pctWhole like every other percent field — no per-row heuristic needed.
  const pctWhole = v => (v == null || v === '') ? null : Number(v) / 100;

  const date = todayIso();
  const wb = await createWorkbook();
  const workbook = wb.workbook;

  // ── Cover sheet (added first so it leads the workbook) ───────────────
  const tabs = [
    { name: 'Proportional', desc: 'All proportional contracts · one row per contract' },
    { name: 'Non-Proportional', desc: 'All NP layers · one row per layer' },
  ];
  const meta = {
    title: 'Portfolio Export',
    date,
    lines: [
      ['Generated', date],
      ['Currency basis', 'Original treaty currency · 100% terms'],
      ['FX reference', 'FX → SAR column shows the latest rate per contract currency'],
      ['Scope', 'Proportional: one row per contract · Non-Proportional: one row per layer'],
    ],
  };
  coverSheet(workbook, tabs, meta);

  // Build one themed portfolio sheet from a config object.
  function buildPortfolioSheet(book, cfg) {
    const ncols = cfg.headers.length;
    const ws = book.addWorksheet(cfg.tab);
    const hdr = titleBar(ws, ncols, cfg.title, cfg.subtitle); // → 4
    if (!cfg.rows.length) {
      const cell = ws.getCell(hdr + 1, 1);
      cell.value = 'No data available';
      cell.font = { name: UT.font, italic: true, color: { argb: UT.inkSoft } };
      finishSheet(ws, hdr, cfg.freezeCols);
      return ws;
    }
    ws.getRow(hdr).values = cfg.headers;
    headerRow(ws, hdr, ncols);

    const firstData = hdr + 1;
    cfg.rows.forEach((row, i) => { ws.getRow(firstData + i).values = row; });
    const lastData = firstData + cfg.rows.length - 1;
    zebra(ws, firstData, lastData, ncols);

    for (let c = 1; c <= ncols; c++) {
      const fmt = cfg.formats[c];
      const isCenter = cfg.center.includes(c);
      if (!fmt && !isCenter) continue;
      for (let rr = firstData; rr <= lastData; rr++) {
        const cell = ws.getCell(rr, c);
        if (fmt) cell.numFmt = fmt;
        if (isCenter) cell.alignment = { ...cell.alignment, horizontal: 'center' };
      }
    }

    cfg.widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    finishSheet(ws, hdr, cfg.freezeCols);
    return ws;
  }

  // ── Sheet 1: Proportional (20 cols) ──────────────────────────────────
  buildPortfolioSheet(workbook, {
    tab: 'Proportional',
    title: 'Proportional Treaty Portfolio',
    subtitle: 'All proportional contracts · one row per contract · amounts in original (100%) currency',
    freezeCols: 2,
    headers: [
      'Contract ID','Cedant','Country','Treaty Type','UW Year','Status','COB',
      'Currency','FX → SAR',
      'Limit 100%','Premium 100%','Commission %','Written Line %','Signed Line %',
      'Attritional Loss Ratio','Large Loss Loading','Cat Loss Loading','Combined Ratio',
      'Underwriter','Approver',
    ],
    rows: (prop || []).map(r => [
      r.contract_id, r.cedant, r.country, r.treaty_type,
      num(r.uw_year), r.status, r.cob,
      r.currency_code || null, num(r.fx_to_sar),
      num(r.limit_100), num(r.premium_100), pctWhole(r.commission_pct),
      pctWhole(r.written_line_pct), pctWhole(r.signed_line_pct),
      pctWhole(r.attritional_ratio), pctWhole(r.large_loss_load),
      pctWhole(r.cat_loss_load), pctWhole(r.combined_ratio),
      r.underwriter_name || null, r.approver_name || null,
    ]),
    formats: {
      9: UT.fmtRate, 10: UT.fmtMoney, 11: UT.fmtMoney, 12: UT.fmtPct, 13: UT.fmtPct,
      14: UT.fmtPct, 15: UT.fmtPct, 16: UT.fmtPct, 17: UT.fmtPct, 18: UT.fmtPct,
    },
    center: [5, 6, 8],
    widths: [38,24,16,16,10,16,30,10,12,16,16,13,13,13,14,14,14,14,20,20],
  });

  // ── Sheet 2: Non-Proportional (25 cols, per layer) ───────────────────
  buildPortfolioSheet(workbook, {
    tab: 'Non-Proportional',
    title: 'Non-Proportional Portfolio',
    subtitle: 'All NP layers · one row per layer · amounts in original (100%) currency',
    freezeCols: 2,
    headers: [
      'Contract ID','Cedant','Country','Treaty Type','UW Year','Status','COB',
      'Currency','FX → SAR',
      'Layer #','Attachment','Limit (Layer)','EGNPI 100%',
      'Premium (Layer)','ROL %','Rate %','Brokerage %',
      'Written Line %','Signed Line %',
      'Attritional Loss Ratio','Large Loss Loading','Cat Loss Loading','Combined Ratio',
      'Underwriter','Approver',
    ],
    rows: (np || []).map(r => [
      r.contract_id, r.cedant, r.country, r.treaty_type,
      num(r.uw_year), r.status, r.cob,
      r.currency_code || null, num(r.fx_to_sar),
      num(r.layer_number), num(r.attachment), num(r.limit_layer),
      num(r.egnpi_100), num(r.premium_100),
      pctWhole(r.rol_pct), pctWhole(r.rate_pct), pctWhole(r.commission_pct),
      pctWhole(r.written_line_pct), pctWhole(r.signed_line_pct),
      pctWhole(r.attritional_ratio), pctWhole(r.large_loss_load),
      pctWhole(r.cat_loss_load), pctWhole(r.combined_ratio),
      r.underwriter_name || null, r.approver_name || null,
    ]),
    formats: {
      9: UT.fmtRate, 11: UT.fmtMoney, 12: UT.fmtMoney, 13: UT.fmtMoney, 14: UT.fmtMoney,
      15: UT.fmtPct, 16: UT.fmtPct, 17: UT.fmtPct, 18: UT.fmtPct, 19: UT.fmtPct,
      20: UT.fmtPct, 21: UT.fmtPct, 22: UT.fmtPct, 23: UT.fmtPct,
    },
    center: [5, 6, 8, 10],
    widths: [38,24,16,16,10,16,28,10,12,9,16,16,16,16,11,11,12,13,13,14,14,14,14,20,20],
  });

  // Download
  await wb.writeFile(`TheUniverse_Portfolio_${date}.xlsx`);
}
