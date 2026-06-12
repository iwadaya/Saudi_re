// server/src/services/renewalPackExport/builder.js
// Builds the portfolio renewal pack as an ExcelJS Workbook (all amounts in USD),
// styled with the Universe theme (cover sheet, title bars, zebra tables).

import ExcelJS from 'exceljs';
import { UT, titleBar, headerRow, zebra, totalRow, finishSheet, coverSheet } from './theme.js';

const APPLY_SIGNED_SHARE = true; // scale SI/premium/agg by signed_line_pct (NOT counts)
const RISK_BANDS_USD = [0, 1e6, 2.5e6, 5e6, 10e6, 25e6, 50e6, 100e6, 250e6, 500e6, 1e9, Infinity];
// bands are [RISK_BANDS_USD[i], RISK_BANDS_USD[i+1])

// Latest rate per currency — same FX sub as dashboard.js
const FX = `(SELECT DISTINCT ON (currency_code) currency_code, COALESCE(rate_to_usd,1.0) AS rate_to_usd
             FROM public.ref_exchange_rate ORDER BY currency_code, effective_date DESC) fx`;

const TRIANGLE_TYPES = [
  { type: 'PREMIUM', sheet: 'Premium Triangle' },
  { type: 'CLAIMS_PAID', sheet: 'Paid Claims Triangle' },
  { type: 'CLAIMS_OS', sheet: 'OS Claims Triangle' },
];
const TRIANGLE_SUBTITLE = 'All amounts USD · UW year × development period';

export async function buildRenewalPackWorkbook(pool) {
  const workbook = new ExcelJS.Workbook();
  coverSheet(workbook, [
    { name: 'Premium Triangle', desc: 'Aggregate written premium by UW year × development' },
    { name: 'Paid Claims Triangle', desc: 'Aggregate paid claims' },
    { name: 'OS Claims Triangle', desc: 'Aggregate outstanding claims' },
    { name: 'Incurred Triangle', desc: 'Paid + outstanding' },
    { name: 'Large Losses', desc: 'Large-loss register with country' },
    { name: 'Cat Losses', desc: 'Catastrophe-loss register with country' },
    { name: 'Risk Profile', desc: 'Banded sum-insured profile, signed contracts' },
    { name: 'Claims Profile', desc: 'Banded claims experience, signed contracts' },
    { name: 'Aggregates by Country', desc: 'Peril aggregates (EQ/WS/Flood/SRCC/Others)' },
  ], { date: new Date().toISOString().slice(0, 10) });
  await addTriangleSheets(workbook, pool);
  await addLossSheet(workbook, pool, 'Large Losses', 'contract_large_losses', 'contract_large_loss_report');
  await addLossSheet(workbook, pool, 'Cat Losses', 'contract_cat_losses', 'contract_cat_loss_report');
  await addRiskProfileSheet(workbook, pool);
  await addClaimsProfileSheet(workbook, pool);
  await addCountryAggregatesSheet(workbook, pool);
  return workbook;
}

// ---------- helpers ----------

const num = (v) => (v == null ? 0 : Number(v));
const numOrNull = (v) => (v == null ? null : Number(v));
const devLabel = (d) => (d % 12 === 0 ? 'DY ' + d / 12 : d + 'm');

function writeNoData(ws, title, subtitle) {
  const hdr = titleBar(ws, 6, title, subtitle);
  const cell = ws.getCell(hdr, 1);
  cell.value = 'No data available';
  cell.font = { name: UT.font, size: 10, italic: true, color: { argb: UT.inkSoft } };
  ws.views = [{ showGridLines: false }];
}

function applyFormats(ws, firstRow, lastRow, fmtByCol) {
  for (let rr = firstRow; rr <= lastRow; rr++) {
    for (const [col, fmt] of Object.entries(fmtByCol)) {
      ws.getCell(rr, Number(col)).numFmt = fmt;
    }
  }
}

function setWidths(ws, widths) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function bandIndexFor(usd) {
  for (let i = 0; i < RISK_BANDS_USD.length - 1; i++) {
    if (usd >= RISK_BANDS_USD[i] && usd < RISK_BANDS_USD[i + 1]) return i;
  }
  return -1; // negative or NaN — leave unbanded
}

function makeBands(initAccumulators) {
  return RISK_BANDS_USD.slice(0, -1).map((lo, i) => ({
    lo,
    hi: RISK_BANDS_USD[i + 1],
    ...initAccumulators(),
  }));
}

// ---------- triangles ----------

async function addTriangleSheets(workbook, pool) {
  const typeSheets = TRIANGLE_TYPES.map(({ type, sheet }) => ({ type, ws: workbook.addWorksheet(sheet) }));
  const incurredWs = workbook.addWorksheet('Incurred Triangle');

  // Global bounds fetched once so all four triangle tabs align
  let minY = null;
  let maxY = null;
  try {
    const { rows } = await pool.query(
      'SELECT MIN(origin_year) AS min_y, MAX(origin_year) AS max_y FROM public.contract_triangle_cells'
    );
    if (rows.length && rows[0].min_y != null && rows[0].max_y != null) {
      minY = Number(rows[0].min_y);
      maxY = Number(rows[0].max_y);
    }
  } catch {
    // null bounds → every triangle tab falls back to "No data available"
  }

  const grids = {}; // type → Map('year|dev' → USD value), or null when the query failed
  const devSet = new Set(); // dev_months across all three types so tabs share columns
  for (const { type } of typeSheets) {
    grids[type] = null;
    if (minY == null) continue;
    try {
      const { rows } = await pool.query(
        `SELECT t2.origin_year, t2.dev_months,
                SUM(t2.cum_value * COALESCE(fx.rate_to_usd,1.0)) AS val
         FROM public.contract_triangle_cells t2
         JOIN public.contract c ON c.contract_id = t2.contract_id
         LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
         LEFT JOIN ${FX} ON fx.currency_code = cur.currency_code
         WHERE t2.type = $1
         GROUP BY t2.origin_year, t2.dev_months`,
        [type]
      );
      const grid = new Map();
      for (const r of rows) {
        const dev = Number(r.dev_months);
        devSet.add(dev);
        grid.set(`${Number(r.origin_year)}|${dev}`, Number(r.val));
      }
      grids[type] = grid;
    } catch {
      grids[type] = null;
    }
  }
  const devCols = [...devSet].sort((a, b) => a - b);

  for (const { type, ws } of typeSheets) {
    writeTriangle(ws, grids[type], minY, maxY, devCols);
  }

  // Incurred = Paid + OS; missing treated as 0, blank only if both missing
  const paid = grids.CLAIMS_PAID;
  const os = grids.CLAIMS_OS;
  let incurred = null;
  if ((paid || os) && minY != null) {
    incurred = new Map();
    for (let y = minY; y <= maxY; y++) {
      for (const d of devCols) {
        const key = `${y}|${d}`;
        const p = paid ? paid.get(key) : undefined;
        const o = os ? os.get(key) : undefined;
        if (p !== undefined || o !== undefined) incurred.set(key, (p ?? 0) + (o ?? 0));
      }
    }
  }
  writeTriangle(incurredWs, incurred, minY, maxY, devCols);
}

function writeTriangle(ws, grid, minY, maxY, devCols) {
  if (!grid || minY == null || devCols.length === 0) {
    writeNoData(ws, ws.name, TRIANGLE_SUBTITLE);
    return;
  }
  const ncols = devCols.length + 1;
  const hdr = titleBar(ws, ncols, ws.name, TRIANGLE_SUBTITLE);
  ws.getRow(hdr).values = ['UW Year', ...devCols.map(devLabel)];
  headerRow(ws, hdr, ncols);

  const firstData = hdr + 1;
  let rowIdx = firstData;
  for (let y = minY; y <= maxY; y++) {
    ws.getRow(rowIdx).values = [y, ...devCols.map((d) => grid.get(`${y}|${d}`) ?? null)];
    rowIdx++;
  }
  const lastData = rowIdx - 1;
  zebra(ws, firstData, lastData, ncols);

  const fmtByCol = {};
  for (let c = 2; c <= ncols; c++) fmtByCol[c] = UT.fmtMoney;
  applyFormats(ws, firstData, lastData, fmtByCol);
  setWidths(ws, [12, ...devCols.map(() => 14)]);
  finishSheet(ws, hdr, 1);
}

// ---------- large / cat losses ----------

async function addLossSheet(workbook, pool, sheetName, lossTable, reportTable) {
  const ws = workbook.addWorksheet(sheetName);
  const subtitle = 'All amounts USD';
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT ll.uw_year, ll.insured_name, ll.loss_name, ll.date_of_loss, ll.class_of_business,
              ll.paid     * COALESCE(fx.rate_to_usd,1.0) AS paid_usd,
              ll.os       * COALESCE(fx.rate_to_usd,1.0) AS os_usd,
              ll.incurred * COALESCE(fx.rate_to_usd,1.0) AS incurred_usd,
              ll.is_selected, co.country_name
       FROM public.${lossTable} ll
       JOIN public.${reportTable} r ON r.report_id = ll.report_id
       JOIN public.contract c ON c.contract_id = r.contract_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN ${FX} ON fx.currency_code = cur.currency_code
       LEFT JOIN public.country co ON co.country_id = c.country_id
       ORDER BY ll.date_of_loss NULLS LAST`
    ));
  } catch {
    writeNoData(ws, sheetName, subtitle);
    return;
  }
  if (!rows.length) {
    writeNoData(ws, sheetName, subtitle);
    return;
  }

  const headers = ['UW Year', 'Insured', 'Loss Name', 'Date of Loss', 'Class of Business',
    'Paid (USD)', 'OS (USD)', 'Incurred (USD)', 'Selected', 'Country'];
  const ncols = headers.length;
  const hdr = titleBar(ws, ncols, sheetName, subtitle);
  ws.getRow(hdr).values = headers;
  headerRow(ws, hdr, ncols);

  const firstData = hdr + 1;
  let rowIdx = firstData;
  for (const r of rows) {
    ws.getRow(rowIdx).values = [
      numOrNull(r.uw_year),
      r.insured_name ?? null,
      r.loss_name ?? null,
      r.date_of_loss ?? null,
      r.class_of_business ?? null,
      numOrNull(r.paid_usd),
      numOrNull(r.os_usd),
      numOrNull(r.incurred_usd),
      r.is_selected ?? null,
      r.country_name ?? null,
    ];
    rowIdx++;
  }
  const lastData = rowIdx - 1;
  zebra(ws, firstData, lastData, ncols);
  applyFormats(ws, firstData, lastData, { 4: UT.fmtDate, 6: UT.fmtMoney, 7: UT.fmtMoney, 8: UT.fmtMoney });
  for (let rr = firstData; rr <= lastData; rr++) {
    ws.getCell(rr, 9).alignment = { horizontal: 'center' };
  }
  setWidths(ws, [14, 26, 26, 14, 14, 14, 14, 14, 14, 18]);
  finishSheet(ws, hdr, 1);
}

// ---------- risk profile ----------

async function addRiskProfileSheet(workbook, pool) {
  const ws = workbook.addWorksheet('Risk Profile');
  const subtitle = 'Signed contracts · USD · share-adjusted exposure & premium';
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT c.contract_id, COALESCE(c.signed_line_pct,100) AS slp,
              b.from_amt, b.to_amt, b.no_of_risks, b.total_sum_insured, b.gross_premium,
              COALESCE(fx.rate_to_usd,1.0) AS r
       FROM public.contract c
       JOIN public.contract_risk_profile p ON p.contract_id = c.contract_id
       JOIN public.contract_risk_profile_band b ON b.profile_id = p.profile_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN ${FX} ON fx.currency_code = cur.currency_code
       WHERE c.uw_status = 'SIGNED'`
    ));
  } catch {
    writeNoData(ws, 'Risk Profile', subtitle);
    return;
  }
  if (!rows.length) {
    writeNoData(ws, 'Risk Profile', subtitle);
    return;
  }

  const bands = makeBands(() => ({ contracts: new Set(), risks: 0, tsi: 0, premium: 0 }));
  const allContracts = new Set();
  for (const r of rows) {
    const rate = Number(r.r);
    const share = APPLY_SIGNED_SHARE ? Number(r.slp) / 100 : 1;
    const band = bands[bandIndexFor(num(r.from_amt) * rate)];
    if (!band) continue;
    band.contracts.add(r.contract_id);
    allContracts.add(r.contract_id);
    band.risks += num(r.no_of_risks);
    band.tsi += num(r.total_sum_insured) * rate * share;
    band.premium += num(r.gross_premium) * rate * share;
  }

  const headers = ['Lower Band', 'Upper Band', '# Contracts', '# Risks',
    'Total Sum Insured (USD)', 'Total Premium (USD)', 'Rate'];
  const ncols = headers.length;
  const hdr = titleBar(ws, ncols, 'Risk Profile', subtitle);
  ws.getRow(hdr).values = headers;
  headerRow(ws, hdr, ncols);

  const firstData = hdr + 1;
  let rowIdx = firstData;
  let tRisks = 0;
  let tTsi = 0;
  let tPremium = 0;
  for (const band of bands) {
    ws.getRow(rowIdx).values = [
      band.lo,
      Number.isFinite(band.hi) ? band.hi : null,
      band.contracts.size,
      band.risks,
      band.tsi,
      band.premium,
      band.tsi !== 0 ? band.premium / band.tsi : null,
    ];
    rowIdx++;
    tRisks += band.risks;
    tTsi += band.tsi;
    tPremium += band.premium;
  }
  const lastData = rowIdx - 1;
  zebra(ws, firstData, lastData, ncols);

  ws.getRow(rowIdx).values = ['TOTAL', null, allContracts.size, tRisks, tTsi, tPremium,
    tTsi !== 0 ? tPremium / tTsi : null];
  totalRow(ws, rowIdx, ncols);

  applyFormats(ws, firstData, rowIdx, {
    1: UT.fmtInt, 2: UT.fmtInt, 3: UT.fmtInt, 4: UT.fmtInt,
    5: UT.fmtMoney, 6: UT.fmtMoney, 7: UT.fmtPct,
  });
  setWidths(ws, [16, 16, 12, 12, 18, 18, 12]);
  finishSheet(ws, hdr, 2);
}

// ---------- claims profile ----------

async function addClaimsProfileSheet(workbook, pool) {
  const ws = workbook.addWorksheet('Claims Profile');
  const subtitle = 'Signed contracts · USD · share-adjusted';
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT c.contract_id, COALESCE(c.signed_line_pct,100) AS slp,
              b.from_amt, b.no_of_claims, b.aggregate_incurred, b.no_of_risks, b.total_sum_insured,
              COALESCE(fx.rate_to_usd,1.0) AS r
       FROM public.contract c
       JOIN public.contract_claims_profile p ON p.contract_id = c.contract_id
       JOIN public.contract_claims_profile_band b ON b.profile_id = p.profile_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN ${FX} ON fx.currency_code = cur.currency_code
       WHERE c.uw_status = 'SIGNED'`
    ));
  } catch {
    writeNoData(ws, 'Claims Profile', subtitle);
    return;
  }
  if (!rows.length) {
    writeNoData(ws, 'Claims Profile', subtitle);
    return;
  }

  const bands = makeBands(() => ({ claims: 0, risks: 0, incurred: 0, tsi: 0 }));
  for (const r of rows) {
    const rate = Number(r.r);
    const share = APPLY_SIGNED_SHARE ? Number(r.slp) / 100 : 1;
    const band = bands[bandIndexFor(num(r.from_amt) * rate)];
    if (!band) continue;
    band.claims += num(r.no_of_claims);
    band.risks += num(r.no_of_risks);
    band.incurred += num(r.aggregate_incurred) * rate * share;
    band.tsi += num(r.total_sum_insured) * rate * share;
  }

  const headers = ['Lower Band', 'Upper Band', '# Claims', '# Risks',
    'Incurred (USD)', 'Total Sum Insured (USD)', 'Loss Rate'];
  const ncols = headers.length;
  const hdr = titleBar(ws, ncols, 'Claims Profile', subtitle);
  ws.getRow(hdr).values = headers;
  headerRow(ws, hdr, ncols);

  const firstData = hdr + 1;
  let rowIdx = firstData;
  let tClaims = 0;
  let tRisks = 0;
  let tIncurred = 0;
  let tTsi = 0;
  for (const band of bands) {
    ws.getRow(rowIdx).values = [
      band.lo,
      Number.isFinite(band.hi) ? band.hi : null,
      band.claims,
      band.risks,
      band.incurred,
      band.tsi,
      band.tsi !== 0 ? band.incurred / band.tsi : null,
    ];
    rowIdx++;
    tClaims += band.claims;
    tRisks += band.risks;
    tIncurred += band.incurred;
    tTsi += band.tsi;
  }
  const lastData = rowIdx - 1;
  zebra(ws, firstData, lastData, ncols);

  ws.getRow(rowIdx).values = ['TOTAL', null, tClaims, tRisks, tIncurred, tTsi,
    tTsi !== 0 ? tIncurred / tTsi : null];
  totalRow(ws, rowIdx, ncols);

  applyFormats(ws, firstData, rowIdx, {
    1: UT.fmtInt, 2: UT.fmtInt, 3: UT.fmtInt, 4: UT.fmtInt,
    5: UT.fmtMoney, 6: UT.fmtMoney, 7: UT.fmtPct,
  });
  setWidths(ws, [16, 16, 12, 12, 18, 18, 12]);
  finishSheet(ws, hdr, 2);
}

// ---------- cresta aggregates ----------

async function addCountryAggregatesSheet(workbook, pool) {
  const ws = workbook.addWorksheet('Aggregates by Country');
  const subtitle = 'Signed contracts · USD · share-adjusted aggregate exposure';
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT co.country_name,
              SUM(cd.eq_agg     * COALESCE(fx.rate_to_usd,1.0) * (CASE WHEN $1 THEN COALESCE(c.signed_line_pct,100)/100 ELSE 1 END)) AS eq,
              SUM(cd.ws_agg     * COALESCE(fx.rate_to_usd,1.0) * (CASE WHEN $1 THEN COALESCE(c.signed_line_pct,100)/100 ELSE 1 END)) AS ws,
              SUM(cd.flood_agg  * COALESCE(fx.rate_to_usd,1.0) * (CASE WHEN $1 THEN COALESCE(c.signed_line_pct,100)/100 ELSE 1 END)) AS flood,
              SUM(cd.srcc_agg   * COALESCE(fx.rate_to_usd,1.0) * (CASE WHEN $1 THEN COALESCE(c.signed_line_pct,100)/100 ELSE 1 END)) AS srcc,
              SUM(cd.others_agg * COALESCE(fx.rate_to_usd,1.0) * (CASE WHEN $1 THEN COALESCE(c.signed_line_pct,100)/100 ELSE 1 END)) AS others
       FROM public.contract_cresta_data cd
       JOIN public.contract c ON c.contract_id = cd.contract_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN ${FX} ON fx.currency_code = cur.currency_code
       LEFT JOIN public.country co ON co.country_id = cd.country_id
       WHERE c.uw_status = 'SIGNED'
       GROUP BY co.country_name
       ORDER BY co.country_name`,
      [APPLY_SIGNED_SHARE]
    ));
  } catch {
    writeNoData(ws, 'Aggregates by Country', subtitle);
    return;
  }
  if (!rows.length) {
    writeNoData(ws, 'Aggregates by Country', subtitle);
    return;
  }

  const headers = ['Country', 'EQ', 'WS', 'Flood', 'SRCC', 'Others', 'Total'];
  const ncols = headers.length;
  const hdr = titleBar(ws, ncols, 'Aggregates by Country', subtitle);
  ws.getRow(hdr).values = headers;
  headerRow(ws, hdr, ncols);

  const firstData = hdr + 1;
  let rowIdx = firstData;
  const totals = [0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    const vals = [num(r.eq), num(r.ws), num(r.flood), num(r.srcc), num(r.others)];
    const total = vals.reduce((a, b) => a + b, 0);
    ws.getRow(rowIdx).values = [r.country_name ?? null, ...vals, total];
    rowIdx++;
    vals.forEach((v, i) => { totals[i] += v; });
    totals[5] += total;
  }
  const lastData = rowIdx - 1;
  zebra(ws, firstData, lastData, ncols);

  ws.getRow(rowIdx).values = ['TOTAL', ...totals];
  totalRow(ws, rowIdx, ncols);

  applyFormats(ws, firstData, rowIdx, {
    2: UT.fmtMoney, 3: UT.fmtMoney, 4: UT.fmtMoney, 5: UT.fmtMoney, 6: UT.fmtMoney, 7: UT.fmtMoney,
  });
  setWidths(ws, [22, 16, 16, 16, 16, 16, 16]);
  finishSheet(ws, hdr, 1);
}
