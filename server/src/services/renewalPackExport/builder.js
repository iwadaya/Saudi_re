// server/src/services/renewalPackExport/builder.js
// Builds the portfolio renewal pack as an ExcelJS Workbook (all amounts in USD).

import ExcelJS from 'exceljs';

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

export async function buildRenewalPackWorkbook(pool) {
  const workbook = new ExcelJS.Workbook();
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

function writeNoData(ws) {
  ws.getCell('A1').value = 'No data';
}

function finishSheet(ws, headers, { freezeCols = 1, moneyCols = [], pctCols = [], dateCols = [] } = {}) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', xSplit: freezeCols, ySplit: 1 }];
  for (const i of moneyCols) ws.getColumn(i).numFmt = '#,##0';
  for (const i of pctCols) ws.getColumn(i).numFmt = '0.00%';
  for (const i of dateCols) ws.getColumn(i).numFmt = 'yyyy-mm-dd';
  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = Math.max(12, String(h).length + 2);
  });
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
    // null bounds → every triangle tab falls back to "No data"
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
    writeNoData(ws);
    return;
  }
  const headers = ['UW Year', ...devCols.map(devLabel)];
  ws.addRow(headers);
  for (let y = minY; y <= maxY; y++) {
    ws.addRow([y, ...devCols.map((d) => grid.get(`${y}|${d}`) ?? null)]);
  }
  finishSheet(ws, headers, { moneyCols: devCols.map((_, i) => i + 2) });
}

// ---------- large / cat losses ----------

async function addLossSheet(workbook, pool, sheetName, lossTable, reportTable) {
  const ws = workbook.addWorksheet(sheetName);
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
    writeNoData(ws);
    return;
  }
  if (!rows.length) {
    writeNoData(ws);
    return;
  }

  const headers = ['UW Year', 'Insured', 'Loss Name', 'Date of Loss', 'Class of Business',
    'Paid (USD)', 'OS (USD)', 'Incurred (USD)', 'Selected', 'Country'];
  ws.addRow(headers);
  for (const r of rows) {
    ws.addRow([
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
    ]);
  }
  finishSheet(ws, headers, { moneyCols: [6, 7, 8], dateCols: [4] });
}

// ---------- risk profile ----------

async function addRiskProfileSheet(workbook, pool) {
  const ws = workbook.addWorksheet('Risk Profile');
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
    writeNoData(ws);
    return;
  }
  if (!rows.length) {
    writeNoData(ws);
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
  ws.addRow(headers);
  let tRisks = 0;
  let tTsi = 0;
  let tPremium = 0;
  for (const band of bands) {
    ws.addRow([
      band.lo,
      Number.isFinite(band.hi) ? band.hi : null,
      band.contracts.size,
      band.risks,
      band.tsi,
      band.premium,
      band.tsi !== 0 ? band.premium / band.tsi : null,
    ]);
    tRisks += band.risks;
    tTsi += band.tsi;
    tPremium += band.premium;
  }
  ws.addRow(['TOTAL', null, allContracts.size, tRisks, tTsi, tPremium,
    tTsi !== 0 ? tPremium / tTsi : null]).font = { bold: true };
  finishSheet(ws, headers, { freezeCols: 2, moneyCols: [1, 2, 5, 6], pctCols: [7] });
}

// ---------- claims profile ----------

async function addClaimsProfileSheet(workbook, pool) {
  const ws = workbook.addWorksheet('Claims Profile');
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
    writeNoData(ws);
    return;
  }
  if (!rows.length) {
    writeNoData(ws);
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
  ws.addRow(headers);
  let tClaims = 0;
  let tRisks = 0;
  let tIncurred = 0;
  let tTsi = 0;
  for (const band of bands) {
    ws.addRow([
      band.lo,
      Number.isFinite(band.hi) ? band.hi : null,
      band.claims,
      band.risks,
      band.incurred,
      band.tsi,
      band.tsi !== 0 ? band.incurred / band.tsi : null,
    ]);
    tClaims += band.claims;
    tRisks += band.risks;
    tIncurred += band.incurred;
    tTsi += band.tsi;
  }
  ws.addRow(['TOTAL', null, tClaims, tRisks, tIncurred, tTsi,
    tTsi !== 0 ? tIncurred / tTsi : null]).font = { bold: true };
  finishSheet(ws, headers, { freezeCols: 2, moneyCols: [1, 2, 5, 6], pctCols: [7] });
}

// ---------- cresta aggregates ----------

async function addCountryAggregatesSheet(workbook, pool) {
  const ws = workbook.addWorksheet('Aggregates by Country');
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
    writeNoData(ws);
    return;
  }
  if (!rows.length) {
    writeNoData(ws);
    return;
  }

  const headers = ['Country', 'EQ', 'WS', 'Flood', 'SRCC', 'Others', 'Total'];
  ws.addRow(headers);
  const totals = [0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    const vals = [num(r.eq), num(r.ws), num(r.flood), num(r.srcc), num(r.others)];
    const total = vals.reduce((a, b) => a + b, 0);
    ws.addRow([r.country_name ?? null, ...vals, total]);
    vals.forEach((v, i) => { totals[i] += v; });
    totals[5] += total;
  }
  ws.addRow(['TOTAL', ...totals]).font = { bold: true };
  finishSheet(ws, headers, { moneyCols: [2, 3, 4, 5, 6, 7] });
}
