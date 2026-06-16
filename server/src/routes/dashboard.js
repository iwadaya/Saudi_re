// server/src/routes/dashboard.js — Live data, all amounts converted to USD.
// Canonical column names are enforced by migrations 000_core_schema and
// 038_fix_schema_column_gaps:
//   class_of_business (class_of_business_id, class_of_business, code)
//   contract_class_of_business (class_of_business_id)
// Reference them directly — if a deployment ever lacks them, fail loud
// rather than silently dropping rows from dashboard aggregates.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../helpers.js";
const router = Router();

// ── Shared SQL building blocks ──────────────────────────────────────────────
// Referenced by both the per-tab queries and the reusable units/unitsLob CTE
// builders, so prop vs NP metrics line up no matter which query computes them.

// Region bucketing on the joined country row (alias cnt).
const regionBucket = `CASE
    WHEN cnt.region IN ('GCC','Levant','North Africa') THEN 'Middle East'
    WHEN cnt.region IN ('Sub-Saharan Africa')          THEN 'Africa'
    WHEN cnt.region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
    WHEN cnt.region = 'Europe'   THEN 'Europe'
    WHEN cnt.region = 'Americas' THEN 'Americas'
    ELSE 'Other'
  END`;

// Latest rate_to_usd per currency_code (alias fx).
const fxSub = `(SELECT DISTINCT ON (currency_code)
                    currency_code, COALESCE(rate_to_usd, 1.0) AS rate_to_usd
                  FROM public.ref_exchange_rate
                  ORDER BY currency_code, effective_date DESC) fx`;

// Reinsurer signed share (signed line, else latest written line, else 100%)
// as a 0–1 fraction.
const signedShare = `(COALESCE(c.signed_line_pct,
    (SELECT o.written_line_pct FROM public.contract_offer o
     WHERE o.contract_id=c.contract_id ORDER BY o.updated_at DESC LIMIT 1),
    100.0) / 100.0)`;

// Non-proportional detection from the treaty-type category.
const isNp = `(COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%')`;

// Standard premium-weighted aggregate expressions over the `units` CTE, so a
// caller can `SELECT ${UNIT_AGGREGATES.avgRol} ... FROM units`. Rates (rol,
// balance, margin) are weighted by premium, never averaged naively.
export const UNIT_AGGREGATES = {
  premium:  'SUM(premium)',
  exposure: 'SUM(exposure)',
  avgRol:   'SUM(rol*premium)     FILTER (WHERE rol     IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE rol     IS NOT NULL),0)',
  balance:  'SUM(balance*premium) FILTER (WHERE balance IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE balance IS NOT NULL),0)',
  uwMargin: 'SUM(margin*premium)  FILTER (WHERE margin  IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE margin  IS NOT NULL),0)',
};

// One row per calculation unit so every tab aggregates prop and NP identically:
//   PROP → one row per contract (premium = signed × (QS+surplus EPI)).
//   NP   → one row per layer    (premium = signed × Σ(uw_price × layer_limit)).
// `where` is applied to BOTH halves of the UNION ALL. `withLob` adds the COB
// join (fanning rows out per class of business, as the legacy LOB queries do).
function buildUnits(where, ccyDivisor, withLob) {
  const lobCol = withLob ? 'cob.class_of_business AS lob,' : '';
  const lobJoin = withLob
    ? `JOIN public.contract_class_of_business ccb ON ccb.contract_id=c.contract_id
      JOIN public.class_of_business cob          ON cob.class_of_business_id=ccb.class_of_business_id`
    : '';
  // contract_pricing_outputs as DISTINCT ON so the margin join never fans out.
  const cpoJoin = `LEFT JOIN (SELECT DISTINCT ON (contract_id) contract_id, actuarial_margin
                 FROM public.contract_pricing_outputs
                ORDER BY contract_id, updated_at DESC) cpo ON cpo.contract_id=c.contract_id`;
  const prop = `
    SELECT
      c.contract_id,
      ${lobCol}
      ${regionBucket} AS region,
      COALESCE(tt.treaty_type,'Unknown') AS treaty_type,
      'PROP'::text AS kind,
      ${signedShare} * (COALESCE(pd.quota_share_epi,0)+COALESCE(pd.surplus_epi,0)) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS premium,
      ${signedShare} * COALESCE(pd.total_capacity,0) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS exposure,
      NULL::numeric AS rol,
      COALESCE(pd.total_capacity,0) / NULLIF(COALESCE(pd.quota_share_epi,0)+COALESCE(pd.surplus_epi,0),0) AS balance,
      cpo.actuarial_margin AS margin,
      c.inception_date AS inception_date,
      c.uw_year AS uw_year
    FROM public.contract c
    LEFT JOIN public.country cnt              ON cnt.country_id=c.country_id
    LEFT JOIN public.treaty_type tt           ON tt.treaty_type_id=c.treaty_type_id
    LEFT JOIN public.contract_prop_details pd ON pd.contract_id=c.contract_id
    LEFT JOIN public.currency cur             ON cur.currency_id=c.currency_id
    LEFT JOIN ${fxSub}                        ON fx.currency_code=cur.currency_code
    ${cpoJoin}
    ${lobJoin}
    ${where} AND NOT ${isNp}`;
  const np = `
    SELECT
      c.contract_id,
      ${lobCol}
      ${regionBucket} AS region,
      COALESCE(tt.treaty_type,'Unknown') AS treaty_type,
      'NP'::text AS kind,
      ${signedShare} * (COALESCE(l.uw_price,0) * COALESCE(l.layer_limit,0)) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS premium,
      ${signedShare} * COALESCE(l.layer_limit,0) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS exposure,
      l.uw_price AS rol,
      NULL::numeric AS balance,
      l.modelled_margin AS margin,
      c.inception_date AS inception_date,
      c.uw_year AS uw_year
    FROM public.contract c
    JOIN public.contract_np_layers l          ON l.contract_id=c.contract_id
    LEFT JOIN public.country cnt              ON cnt.country_id=c.country_id
    LEFT JOIN public.treaty_type tt           ON tt.treaty_type_id=c.treaty_type_id
    LEFT JOIN public.currency cur             ON cur.currency_id=c.currency_id
    LEFT JOIN ${fxSub}                        ON fx.currency_code=cur.currency_code
    ${lobJoin}
    ${where} AND ${isNp}`;
  return `units AS (${prop}
    UNION ALL${np}
  )`;
}

// CTE named `units` — one calculation unit per row. Use as:
//   WITH ${unitsCte(where, ccyDivisor)} SELECT ${UNIT_AGGREGATES.premium} FROM units
export const unitsCte = (where, ccyDivisor) => buildUnits(where, ccyDivisor, false);
// Same shape, fanned out per class of business (rows carry `lob`).
export const unitsLobCte = (where, ccyDivisor) => buildUnits(where, ccyDivisor, true);

// ── Filters ───────────────────────────────────────────────────────────────
router.get("/dashboard/filters", asyncHandler(async (_req, res) => {
  const [years, regions, treatyTypes, months] = await Promise.all([
    pool.query(`SELECT DISTINCT uw_year FROM public.contract
                WHERE uw_year IS NOT NULL ORDER BY uw_year DESC LIMIT 10`),
    pool.query(`SELECT DISTINCT
      CASE WHEN region IN ('GCC','Levant','North Africa') THEN 'Middle East'
           WHEN region IN ('Sub-Saharan Africa')          THEN 'Africa'
           WHEN region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
           WHEN region = 'Europe'   THEN 'Europe'
           WHEN region = 'Americas' THEN 'Americas'
           ELSE NULL END AS r
      FROM public.country WHERE region IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT treaty_type FROM public.treaty_type ORDER BY 1`),
    pool.query(`SELECT DISTINCT EXTRACT(MONTH FROM inception_date)::int AS m
                FROM public.contract WHERE inception_date IS NOT NULL ORDER BY 1`),
  ]);
  res.json({
    uwYears:      years.rows.map(r => r.uw_year),
    regions:      regions.rows.map(r => r.r).filter(Boolean),
    treatyTypes:  treatyTypes.rows.map(r => r.treaty_type),
    months:       months.rows.map(r => r.m),
    currencies:   ['USD','SAR','GBP'],
    defaultUwYear: years.rows[0]?.uw_year || null,
  });
}));

// ── Main page data ────────────────────────────────────────────────────────
router.get("/dashboard/page/:tab", asyncHandler(async (req, res) => {
  const { tab } = req.params;
  const { uwYear, month, region, treatyType, currency: reqCurrency } = req.query;

  // Target display currency (default USD)
  const ALLOWED = ['USD','SAR','GBP'];
  const displayCcy = ALLOWED.includes(reqCurrency) ? reqCurrency : 'USD';

  // Fetch target currency rate to USD (so we can divide USD amount by it)
  let targetRateToUsd = 1.0;
  if (displayCcy !== 'USD') {
    try {
      const { rows: rr } = await pool.query(
        `SELECT rate_to_usd FROM public.ref_exchange_rate
         WHERE currency_code=$1 ORDER BY effective_date DESC LIMIT 1`, [displayCcy]
      );
      if (rr.length && rr[0].rate_to_usd > 0) targetRateToUsd = Number(rr[0].rate_to_usd);
    } catch {}
  }
  // Conversion factor: contract_ccy → USD → displayCcy
  // effPrem (in contract_ccy) × fx.rate_to_usd / targetRateToUsd = amount in displayCcy
  const ccyDivisor = targetRateToUsd;

  // WHERE
  // Portfolio metrics count live business only: exclude DRAFT (not yet a real
  // position) and the terminal dead states DECLINED/NTU (never on risk). This
  // matches the "active portfolio" filter used in home.js and the pricing
  // aggregates; previously DECLINED/NTU leaked into premium/exposure totals.
  const conds = ["c.uw_status NOT IN ('DRAFT','DECLINED','NTU')"];
  const params = [];
  let i = 1;
  if (uwYear)     { conds.push(`c.uw_year = $${i++}`);         params.push(Number(uwYear)); }
  if (month)      { conds.push(`EXTRACT(MONTH FROM c.inception_date) = $${i++}`); params.push(Number(month)); }
  if (treatyType) { conds.push(`tt.treaty_type = $${i++}`);    params.push(treatyType); }
  if (region)     { conds.push(`(${regionBucket}) = $${i++}`); params.push(region); }
  const where = `WHERE ${conds.join(' AND ')}`;

  // All tabs aggregate over the shared units / unitsLob CTEs, which source from
  // public.contract ONLY — quotes are a standalone artefact and never feed
  // portfolio exposure (POST /api/quotes/:id/bind is disabled; see
  // quoteLifecycle.js and docs/architecture.md "Quote binding scope").
  //
  // Response coercion: keep a SQL NULL (e.g. a premium-weighted rate with no
  // contributing rows) as null rather than turning it into 0.
  const num = (v) => (v == null ? null : Number(v));

  // ── portfolio-overview ────────────────────────────────────────────────
  if (tab === 'portfolio-overview') {
    // Every metric is computed over the shared units / unitsLob CTEs so prop
    // and NP roll up consistently. mw_num / mw_den are the premium-weighted
    // margin numerator/denominator feeding buildWeightedPivot.
    const unitsW   = unitsCte(where, ccyDivisor);
    const unitsLob = unitsLobCte(where, ccyDivisor);
    const mwNum = 'COALESCE(SUM(margin*premium) FILTER (WHERE margin IS NOT NULL),0) AS mw_num';
    const mwDen = 'COALESCE(SUM(premium)        FILTER (WHERE margin IS NOT NULL),0) AS mw_den';

    const [kpiR, regionR, lobR, monthR, regTreatyR, lobTreatyR, lobRegionR] = await Promise.all([

      pool.query(`WITH ${unitsW}
        SELECT
          COUNT(DISTINCT contract_id)::int        AS contracts,
          COALESCE(${UNIT_AGGREGATES.premium},0)  AS premium,
          COALESCE(${UNIT_AGGREGATES.exposure},0) AS exposure,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.avgRol}               AS "avgRol",
          ${UNIT_AGGREGATES.uwMargin}             AS "avgUwMargin"
        FROM units`, params),

      pool.query(`WITH ${unitsW}
        SELECT region,
          COUNT(DISTINCT contract_id)::int        AS contracts,
          COALESCE(${UNIT_AGGREGATES.premium},0)  AS premium,
          COALESCE(${UNIT_AGGREGATES.exposure},0) AS exposure,
          ${UNIT_AGGREGATES.avgRol}               AS rol,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
        FROM units GROUP BY region ORDER BY 3 DESC`, params),

      pool.query(`WITH ${unitsLob}
        SELECT lob,
          COUNT(DISTINCT contract_id)::int        AS contracts,
          COALESCE(${UNIT_AGGREGATES.premium},0)  AS premium,
          COALESCE(${UNIT_AGGREGATES.exposure},0) AS exposure,
          ${UNIT_AGGREGATES.avgRol}               AS rol,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
        FROM units WHERE lob IS NOT NULL GROUP BY lob ORDER BY 3 DESC`, params),

      pool.query(`WITH ${unitsW}
        SELECT to_char(inception_date,'YYYY-MM') AS month, COALESCE(SUM(premium),0) AS value
        FROM units WHERE inception_date IS NOT NULL GROUP BY 1 ORDER BY 1`, params),

      pool.query(`WITH ${unitsW}
        SELECT region, treaty_type,
          COALESCE(SUM(premium),0)  AS premium,
          COALESCE(SUM(exposure),0) AS exposure,
          ${mwNum}, ${mwDen}
        FROM units GROUP BY region, treaty_type`, params),

      pool.query(`WITH ${unitsLob}
        SELECT lob, treaty_type,
          COALESCE(SUM(premium),0)  AS premium,
          COALESCE(SUM(exposure),0) AS exposure,
          ${mwNum}, ${mwDen}
        FROM units WHERE lob IS NOT NULL GROUP BY lob, treaty_type`, params),

      pool.query(`WITH ${unitsLob}
        SELECT lob, region,
          COALESCE(SUM(premium),0)  AS premium,
          ${mwNum}, ${mwDen}
        FROM units WHERE lob IS NOT NULL GROUP BY lob, region`, params),
    ]);

    const kpi = kpiR.rows[0] || {};

    // Region rows: drop the 'Other' bucket; portfolioPct is each region's share
    // of the shown region premium so the column sums to ~100%.
    const regionRows = regionR.rows.filter(r => r.region && r.region !== 'Other');
    const totalRegionPrem = regionRows.reduce((s, r) => s + Number(r.premium), 0);
    const summaryByRegion = regionRows.map(r => ({
      region:    r.region,
      contracts: r.contracts,
      premium:   Number(r.premium),
      exposure:  Number(r.exposure),
      rol:       num(r.rol),
      balance:   num(r.balance),
      uwMargin:  num(r.uwMargin),
      portfolioPct: totalRegionPrem > 0 ? Number(r.premium) / totalRegionPrem : 0,
    }));

    // LOB rows come from the fanned-out unitsLob CTE, so portfolioPct is a
    // share of the LOB-fanned premium total (sums to ~100% across LOBs).
    const totalLobPrem = lobR.rows.reduce((s, r) => s + Number(r.premium), 0);
    const summaryByLob = lobR.rows.map(r => ({
      lob:       r.lob,
      contracts: r.contracts,
      premium:   Number(r.premium),
      exposure:  Number(r.exposure),
      rol:       num(r.rol),
      balance:   num(r.balance),
      uwMargin:  num(r.uwMargin),
      portfolioPct: totalLobPrem > 0 ? Number(r.premium) / totalLobPrem : 0,
    }));

    const premiumRegionTreaty = buildPivot(regTreatyR.rows, 'region', 'treaty_type', 'premium');
    const premiumLobTreaty    = buildPivot(lobTreatyR.rows, 'lob',    'treaty_type', 'premium');

    return res.json({
      kpis: {
        contracts:   kpi.contracts || 0,
        premium:     Number(kpi.premium) || 0,
        exposure:    Number(kpi.exposure) || 0,
        balance:     num(kpi.balance),
        avgRol:      num(kpi.avgRol),
        avgUwMargin: num(kpi.avgUwMargin),
      },
      summaryByRegion,
      summaryByLob,
      series: {
        premiumByMonth: monthR.rows.map(r => ({ month: r.month, value: Number(r.value) || 0 })),
      },
      premiumRegionTreaty,
      exposureRegionTreaty:    buildPivot(regTreatyR.rows, 'region', 'treaty_type', 'exposure'),
      uwMarginRegionTreaty:    buildWeightedPivot(regTreatyR.rows, 'region', 'treaty_type', 'mw_num', 'mw_den'),
      compositionRegionTreaty: normalizePivot(premiumRegionTreaty),
      premiumLobTreaty,
      exposureLobTreaty:       buildPivot(lobTreatyR.rows, 'lob', 'treaty_type', 'exposure'),
      uwMarginLobTreaty:       buildWeightedPivot(lobTreatyR.rows, 'lob', 'treaty_type', 'mw_num', 'mw_den'),
      compositionLobTreaty:    normalizePivot(premiumLobTreaty),
      premiumLobRegion:        buildPivot(lobRegionR.rows, 'lob', 'region', 'premium'),
      uwMarginLobRegion:       buildWeightedPivot(lobRegionR.rows, 'lob', 'region', 'mw_num', 'mw_den'),
    });
  }

  // ── portfolio-summary ─────────────────────────────────────────────────
  if (tab === 'portfolio-summary') {
    const unitsW = unitsCte(where, ccyDivisor);
    const [byYearR, regionYearR] = await Promise.all([
      pool.query(`WITH ${unitsW}
        SELECT uw_year AS "uwYear",
          COUNT(DISTINCT contract_id)::int        AS contracts,
          COALESCE(${UNIT_AGGREGATES.premium},0)  AS premium,
          COALESCE(${UNIT_AGGREGATES.exposure},0) AS exposure,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.avgRol}               AS rol,
          ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
        FROM units GROUP BY uw_year ORDER BY uw_year`, params),
      pool.query(`WITH ${unitsW}
        SELECT region, uw_year::text AS uw_year, COALESCE(SUM(premium),0) AS premium
        FROM units GROUP BY region, uw_year ORDER BY region, uw_year`, params),
    ]);
    return res.json({
      kpis: {},
      byYear: byYearR.rows.map(r => ({
        ...r,
        premium: Number(r.premium), exposure: Number(r.exposure),
        balance: num(r.balance), rol: num(r.rol), uwMargin: num(r.uwMargin),
      })),
      regionYear: buildPivot(regionYearR.rows, 'region', 'uw_year', 'premium'),
    });
  }

  // ── regional-analysis ────────────────────────────────────────────────
  // Region-scoped: the region filter is already in `where`, so every unit
  // here belongs to the selected region and portfolioPct is within-region.
  if (tab === 'regional-analysis') {
    const unitsW   = unitsCte(where, ccyDivisor);
    const unitsLob = unitsLobCte(where, ccyDivisor);
    const mwNum = 'COALESCE(SUM(margin*premium) FILTER (WHERE margin IS NOT NULL),0) AS mw_num';
    const mwDen = 'COALESCE(SUM(premium)        FILTER (WHERE margin IS NOT NULL),0) AS mw_den';
    const [byYearR, byLobR, lobTreatyR] = await Promise.all([
      pool.query(`WITH ${unitsW}
        SELECT uw_year AS "uwYear",
          COUNT(DISTINCT contract_id)::int        AS contracts,
          COALESCE(${UNIT_AGGREGATES.premium},0)  AS premium,
          COALESCE(${UNIT_AGGREGATES.exposure},0) AS exposure,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.avgRol}               AS rol,
          ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
        FROM units GROUP BY uw_year ORDER BY uw_year`, params),
      pool.query(`WITH ${unitsLob}
        SELECT lob,
          COUNT(DISTINCT contract_id)::int        AS contracts,
          COALESCE(${UNIT_AGGREGATES.premium},0)  AS premium,
          COALESCE(${UNIT_AGGREGATES.exposure},0) AS exposure,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.avgRol}               AS rol,
          ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
        FROM units WHERE lob IS NOT NULL GROUP BY lob ORDER BY 3 DESC`, params),
      pool.query(`WITH ${unitsLob}
        SELECT lob, treaty_type,
          COALESCE(SUM(premium),0)  AS premium,
          COALESCE(SUM(exposure),0) AS exposure,
          ${mwNum}, ${mwDen}
        FROM units WHERE lob IS NOT NULL GROUP BY lob, treaty_type`, params),
    ]);
    const totalLobPrem = byLobR.rows.reduce((s, r) => s + Number(r.premium), 0);
    const lobTreatyPremium = buildPivot(lobTreatyR.rows, 'lob', 'treaty_type', 'premium');
    return res.json({
      kpis: {},
      byYear: byYearR.rows.map(r => ({
        ...r,
        premium: Number(r.premium), exposure: Number(r.exposure),
        balance: num(r.balance), rol: num(r.rol), uwMargin: num(r.uwMargin),
      })),
      byLob: byLobR.rows.map(r => ({
        lob: r.lob, contracts: r.contracts,
        premium: Number(r.premium), exposure: Number(r.exposure),
        rol: num(r.rol), balance: num(r.balance), uwMargin: num(r.uwMargin),
        portfolioPct: totalLobPrem > 0 ? Number(r.premium) / totalLobPrem : 0,
      })),
      lobTreatyPremium,
      lobTreatyExposure:    buildPivot(lobTreatyR.rows, 'lob', 'treaty_type', 'exposure'),
      lobTreatyComposition: normalizePivot(lobTreatyPremium),
      lobTreatyUwMargin:    buildWeightedPivot(lobTreatyR.rows, 'lob', 'treaty_type', 'mw_num', 'mw_den'),
    });
  }

  res.json({ kpis: {}, rows: [] });
}));

// ── Pivot builder ─────────────────────────────────────────────────────────
export function buildPivot(rows, rowKey, colKey, valKey) {
  const colSet = new Set();
  const rowMap = {};
  for (const r of rows) {
    const rv = r[rowKey]; const cv = r[colKey]; const vv = Number(r[valKey]) || 0;
    if (!rv || rv === 'Other') continue;
    colSet.add(cv);
    if (!rowMap[rv]) rowMap[rv] = { values: {}, total: 0 };
    rowMap[rv].values[cv] = (rowMap[rv].values[cv] || 0) + vv;
    rowMap[rv].total += vv;
  }
  const columns = [...colSet].sort();
  const pivotRows = Object.entries(rowMap)
    .map(([key, r]) => ({ [rowKey === 'lob' ? 'lob' : 'region']: key, key, values: r.values, total: r.total }))
    .sort((a, b) => b.total - a.total);
  const totals = { values: {}, total: 0 };
  for (const c of columns) {
    totals.values[c] = pivotRows.reduce((s, r) => s + (r.values[c] || 0), 0);
    totals.total += totals.values[c];
  }
  return { columns, rows: pivotRows, totals };
}

// ── Weighted pivot ──────────────────────────────────────────────────────────
// Like buildPivot but each cell is a premium-weighted ratio Σnum / Σden (den 0
// → 0). Crucially the row total and grand totals are ALSO Σnum / Σden over the
// cell's members — never a sum or average of per-cell ratios. Use for ROL /
// margin / balance pivots where summing rates would be meaningless.
export function buildWeightedPivot(rows, rowKey, colKey, numKey, denKey) {
  const div = (n, d) => (d ? n / d : 0);
  const colSet = new Set();
  const rowMap = {};               // rv -> { cells: {cv:{num,den}}, num, den }
  const colTotals = {};            // cv -> { num, den }
  let grandNum = 0, grandDen = 0;
  for (const r of rows) {
    const rv = r[rowKey]; const cv = r[colKey];
    if (!rv || rv === 'Other') continue;
    const num = Number(r[numKey]) || 0;
    const den = Number(r[denKey]) || 0;
    colSet.add(cv);
    if (!rowMap[rv]) rowMap[rv] = { cells: {}, num: 0, den: 0 };
    if (!rowMap[rv].cells[cv]) rowMap[rv].cells[cv] = { num: 0, den: 0 };
    rowMap[rv].cells[cv].num += num; rowMap[rv].cells[cv].den += den;
    rowMap[rv].num += num;           rowMap[rv].den += den;
    if (!colTotals[cv]) colTotals[cv] = { num: 0, den: 0 };
    colTotals[cv].num += num;        colTotals[cv].den += den;
    grandNum += num;                 grandDen += den;
  }
  const columns = [...colSet].sort();
  const pivotRows = Object.entries(rowMap)
    .map(([key, r]) => {
      const values = {};
      for (const c of columns) values[c] = r.cells[c] ? div(r.cells[c].num, r.cells[c].den) : 0;
      const out = { key, values, total: div(r.num, r.den) };
      out[rowKey === 'lob' ? 'lob' : 'region'] = key;
      return out;
    })
    .sort((a, b) => b.total - a.total);
  const totals = { values: {}, total: div(grandNum, grandDen) };
  for (const c of columns) totals.values[c] = colTotals[c] ? div(colTotals[c].num, colTotals[c].den) : 0;
  return { columns, rows: pivotRows, totals };
}

// ── Composition normaliser ──────────────────────────────────────────────────
// Turn a premium pivot into a portfolio-share pivot: every cell, row total and
// grand total becomes its fraction of total premium. Use for composition/mix
// views instead of counting contracts.
export function normalizePivot(premiumPivot) {
  const grand = Number(premiumPivot?.totals?.total) || 0;
  const share = (v) => (grand > 0 ? (Number(v) || 0) / grand : 0);
  const rows = (premiumPivot?.rows || []).map((r) => {
    const values = {};
    for (const k of Object.keys(r.values || {})) values[k] = share(r.values[k]);
    const out = { key: r.key, values, total: share(r.total) };
    if ('lob' in r) out.lob = r.lob;
    if ('region' in r) out.region = r.region;
    return out;
  });
  const totals = { values: {}, total: share(premiumPivot?.totals?.total) };
  for (const k of Object.keys(premiumPivot?.totals?.values || {})) totals.values[k] = share(premiumPivot.totals.values[k]);
  return { columns: (premiumPivot?.columns || []).slice(), rows, totals };
}

export default router;
