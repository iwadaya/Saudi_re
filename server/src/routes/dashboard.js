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

// ── Filters ───────────────────────────────────────────────────────────────
router.get("/dashboard/filters", asyncHandler(async (_req, res) => {
  const [years, regions, treatyTypes] = await Promise.all([
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
  ]);
  res.json({
    uwYears:      years.rows.map(r => r.uw_year),
    regions:      regions.rows.map(r => r.r).filter(Boolean),
    treatyTypes:  treatyTypes.rows.map(r => r.treaty_type),
    currencies:   ['USD','SAR','GBP'],
    defaultUwYear: years.rows[0]?.uw_year || null,
  });
}));

// ── Main page data ────────────────────────────────────────────────────────
router.get("/dashboard/page/:tab", asyncHandler(async (req, res) => {
  const { tab } = req.params;
  const { uwYear, region, treatyType, currency: reqCurrency } = req.query;

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

  const regionBucket = `CASE
    WHEN cnt.region IN ('GCC','Levant','North Africa') THEN 'Middle East'
    WHEN cnt.region IN ('Sub-Saharan Africa')          THEN 'Africa'
    WHEN cnt.region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
    WHEN cnt.region = 'Europe'   THEN 'Europe'
    WHEN cnt.region = 'Americas' THEN 'Americas'
    ELSE 'Other'
  END`;

  // WHERE
  const conds = ["c.uw_status NOT IN ('DRAFT')"];
  const params = [];
  let i = 1;
  if (uwYear)     { conds.push(`c.uw_year = $${i++}`);         params.push(Number(uwYear)); }
  if (treatyType) { conds.push(`tt.treaty_type = $${i++}`);    params.push(treatyType); }
  if (region)     { conds.push(`(${regionBucket}) = $${i++}`); params.push(region); }
  const where = `WHERE ${conds.join(' AND ')}`;

  // NP layer limit sub
  const nlSub = `(SELECT contract_id, COALESCE(SUM(layer_limit),0) AS total_layer_limit
                  FROM public.contract_np_layers GROUP BY contract_id) sum_nl`;

  // FX sub — latest rate_to_usd per currency_code
  const fxSub = `(SELECT DISTINCT ON (currency_code)
                    currency_code, COALESCE(rate_to_usd, 1.0) AS rate_to_usd
                  FROM public.ref_exchange_rate
                  ORDER BY currency_code, effective_date DESC) fx`;

  // Effective premium in display currency
  const effPremUSD = `(
    COALESCE(c.signed_line_pct,
      (SELECT o.written_line_pct FROM public.contract_offer o
       WHERE o.contract_id=c.contract_id ORDER BY o.updated_at DESC LIMIT 1),
      100.0) / 100.0
  ) * CASE
      WHEN COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%'
        THEN COALESCE(NULLIF(nd.est_gnpi,0), 0)
      ELSE COALESCE(NULLIF(COALESCE(pd.quota_share_epi,0)+COALESCE(pd.surplus_epi,0),0), 0)
    END
  * COALESCE(fx.rate_to_usd, 1.0) / ${ccyDivisor}`;

  // Effective limit in display currency
  const effLimUSD = `(
    COALESCE(c.signed_line_pct,
      (SELECT o.written_line_pct FROM public.contract_offer o
       WHERE o.contract_id=c.contract_id ORDER BY o.updated_at DESC LIMIT 1),
      100.0) / 100.0
  ) * CASE
      WHEN COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%'
        THEN COALESCE(sum_nl.total_layer_limit, 0)
      ELSE COALESCE(pd.total_capacity, 0)
    END
  * COALESCE(fx.rate_to_usd, 1.0) / ${ccyDivisor}`;

  // Base joins
  const baseJoins = `
    FROM public.contract c
    LEFT JOIN public.companies ced             ON ced.company_id=c.cedant_id
    LEFT JOIN public.country cnt               ON cnt.country_id=c.country_id
    LEFT JOIN public.treaty_type tt            ON tt.treaty_type_id=c.treaty_type_id
    LEFT JOIN public.contract_prop_details pd  ON pd.contract_id=c.contract_id
    LEFT JOIN public.contract_np_details nd    ON nd.contract_id=c.contract_id
    LEFT JOIN ${nlSub}                         ON sum_nl.contract_id=c.contract_id
    LEFT JOIN public.currency cur              ON cur.currency_id=c.currency_id
    LEFT JOIN ${fxSub}                         ON fx.currency_code=cur.currency_code`;

  // ── portfolio-overview ────────────────────────────────────────────────
  if (tab === 'portfolio-overview') {
    const [kpiR, regionR, cobR, pivotR, cobPivotR, cobRegionR] = await Promise.all([

      pool.query(`SELECT
        COUNT(DISTINCT c.contract_id)::int AS contracts,
        COALESCE(SUM(${effPremUSD}),0)     AS premium,
        COALESCE(SUM(${effLimUSD}),0)      AS exposure
        ${baseJoins} ${where}`, params),

      pool.query(`SELECT
        ${regionBucket}                         AS region,
        COUNT(DISTINCT c.contract_id)::int      AS contracts,
        COALESCE(SUM(${effPremUSD}),0)          AS premium,
        COALESCE(SUM(${effLimUSD}),0)           AS exposure
        ${baseJoins} ${where}
        GROUP BY 1 ORDER BY 1`, params),

      pool.query(`SELECT
        cob.class_of_business                        AS lob,
        COUNT(DISTINCT c.contract_id)::int      AS contracts,
        COALESCE(SUM(${effPremUSD}),0)          AS premium,
        COALESCE(SUM(${effLimUSD}),0)           AS exposure
        ${baseJoins}
        JOIN public.contract_class_of_business ccb ON ccb.contract_id=c.contract_id
        JOIN public.class_of_business cob ON cob.class_of_business_id=ccb.class_of_business_id
        ${where} GROUP BY 1 ORDER BY 3 DESC`, params),

      pool.query(`SELECT
        ${regionBucket}                         AS region,
        COALESCE(tt.treaty_type,'Unknown')      AS treaty_type,
        COALESCE(SUM(${effPremUSD}),0)          AS premium,
        COALESCE(SUM(${effLimUSD}),0)           AS exposure,
        COUNT(DISTINCT c.contract_id)::int      AS contracts
        ${baseJoins} ${where}
        GROUP BY 1,2 ORDER BY 1,2`, params),

      pool.query(`SELECT
        cob.class_of_business                        AS lob,
        COALESCE(tt.treaty_type,'Unknown')      AS treaty_type,
        COALESCE(SUM(${effPremUSD}),0)          AS premium,
        COALESCE(SUM(${effLimUSD}),0)           AS exposure,
        COUNT(DISTINCT c.contract_id)::int      AS contracts
        ${baseJoins}
        JOIN public.contract_class_of_business ccb ON ccb.contract_id=c.contract_id
        JOIN public.class_of_business cob ON cob.class_of_business_id=ccb.class_of_business_id
        ${where} GROUP BY 1,2 ORDER BY 1,2`, params),

      pool.query(`SELECT
        cob.class_of_business                        AS lob,
        ${regionBucket}                         AS region,
        COALESCE(SUM(${effPremUSD}),0)          AS premium
        ${baseJoins}
        JOIN public.contract_class_of_business ccb ON ccb.contract_id=c.contract_id
        JOIN public.class_of_business cob ON cob.class_of_business_id=ccb.class_of_business_id
        ${where} GROUP BY 1,2 ORDER BY 1,2`, params),
    ]);

    const kpi = kpiR.rows[0] || {};
    const totalPrem = regionR.rows
      .filter(r => r.region && r.region !== 'Other')
      .reduce((s, r) => s + Number(r.premium), 0);

    const regionMap = {};
    for (const r of regionR.rows) {
      if (!r.region || r.region === 'Other') continue;
      if (!regionMap[r.region]) regionMap[r.region] = { region: r.region, contracts: 0, premium: 0, exposure: 0 };
      regionMap[r.region].contracts += r.contracts;
      regionMap[r.region].premium   += Number(r.premium);
      regionMap[r.region].exposure  += Number(r.exposure);
    }
    const summaryByRegion = Object.values(regionMap).map(r => ({
      ...r, rol: 0, uwMargin: 0,
      portfolioPct: totalPrem > 0 ? r.premium / totalPrem : 0,
    }));

    const summaryByLob = cobR.rows.map(r => ({
      ...r, premium: Number(r.premium), exposure: Number(r.exposure),
      rol: 0, uwMargin: 0,
      portfolioPct: totalPrem > 0 ? Number(r.premium) / totalPrem : 0,
    }));

    return res.json({
      kpis: {
        contracts:   kpi.contracts || 0,
        premium:     Number(kpi.premium) || 0,
        exposure:    Number(kpi.exposure) || 0,
        balance:     0, avgRol: 0, avgUwMargin: 0,
      },
      summaryByRegion,
      summaryByLob,
      premiumRegionTreaty:   buildPivot(pivotR.rows,     'region', 'treaty_type', 'premium'),
      exposureRegionTreaty:  buildPivot(pivotR.rows,     'region', 'treaty_type', 'exposure'),
      premiumLobTreaty:      buildPivot(cobPivotR.rows,  'lob',    'treaty_type', 'premium'),
      exposureLobTreaty:     buildPivot(cobPivotR.rows,  'lob',    'treaty_type', 'exposure'),
      compositionLobTreaty:  buildPivot(cobPivotR.rows,  'lob',    'treaty_type', 'contracts'),
      premiumLobRegion:      buildPivot(cobRegionR.rows, 'lob',    'region',      'premium'),
    });
  }

  // ── portfolio-summary ─────────────────────────────────────────────────
  if (tab === 'portfolio-summary') {
    const [byYearR, regionYearR] = await Promise.all([
      pool.query(`SELECT c.uw_year AS "uwYear",
        COUNT(DISTINCT c.contract_id)::int AS contracts,
        COALESCE(SUM(${effPremUSD}),0) AS premium,
        COALESCE(SUM(${effLimUSD}),0)  AS exposure
        ${baseJoins} ${where} GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT ${regionBucket} AS region, c.uw_year::text AS uw_year,
        COALESCE(SUM(${effPremUSD}),0) AS premium
        ${baseJoins} ${where} GROUP BY 1,2 ORDER BY 1,2`, params),
    ]);
    return res.json({
      kpis: {},
      byYear:     byYearR.rows.map(r => ({ ...r, premium: Number(r.premium), exposure: Number(r.exposure) })),
      regionYear: buildPivot(regionYearR.rows, 'region', 'uw_year', 'premium'),
    });
  }

  // ── regional-analysis ────────────────────────────────────────────────
  if (tab === 'regional-analysis') {
    const [byYearR, byLobR] = await Promise.all([
      pool.query(`SELECT c.uw_year AS "uwYear",
        COUNT(DISTINCT c.contract_id)::int AS contracts,
        COALESCE(SUM(${effPremUSD}),0) AS premium,
        COALESCE(SUM(${effLimUSD}),0)  AS exposure
        ${baseJoins} ${where} GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT cob.class_of_business AS lob,
        COUNT(DISTINCT c.contract_id)::int AS contracts,
        COALESCE(SUM(${effPremUSD}),0) AS premium,
        COALESCE(SUM(${effLimUSD}),0)  AS exposure
        ${baseJoins}
        JOIN public.contract_class_of_business ccb ON ccb.contract_id=c.contract_id
        JOIN public.class_of_business cob ON cob.class_of_business_id=ccb.class_of_business_id
        ${where} GROUP BY 1 ORDER BY 3 DESC`, params),
    ]);
    return res.json({
      kpis: {},
      byYear: byYearR.rows.map(r => ({ ...r, premium: Number(r.premium), exposure: Number(r.exposure) })),
      byLob:  byLobR.rows.map(r => ({ ...r, premium: Number(r.premium), exposure: Number(r.exposure) })),
    });
  }

  res.json({ kpis: {}, rows: [] });
}));

// ── Pivot builder ─────────────────────────────────────────────────────────
function buildPivot(rows, rowKey, colKey, valKey) {
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

export default router;
