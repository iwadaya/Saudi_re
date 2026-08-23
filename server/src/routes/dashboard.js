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

// Region bucketing on the joined country row (alias cnt). Shared with the
// facultative dashboard (facDashboard.js) so both books bucket identically.
export const regionBucket = `CASE
    WHEN cnt.region IN ('GCC','Levant','North Africa') THEN 'Middle East'
    WHEN cnt.region IN ('Sub-Saharan Africa')          THEN 'Africa'
    WHEN cnt.region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
    WHEN cnt.region = 'Europe'   THEN 'Europe'
    WHEN cnt.region = 'Americas' THEN 'Americas'
    ELSE 'Other'
  END`;

// Latest rate_to_usd per currency_code (alias fx).
export const fxSub = `(SELECT DISTINCT ON (currency_code)
                    currency_code, COALESCE(rate_to_usd, 1.0) AS rate_to_usd
                  FROM public.ref_exchange_rate
                  ORDER BY currency_code, effective_date DESC) fx`;

// Reinsurer signed share (signed line, else latest written line, else 100%)
// as a 0–1 fraction.
export const signedShare = `(COALESCE(c.signed_line_pct,
    (SELECT o.written_line_pct FROM public.contract_offer o
     WHERE o.contract_id=c.contract_id ORDER BY o.updated_at DESC LIMIT 1),
    100.0) / 100.0)`;

// Non-proportional detection from the treaty-type category.
export const isNp = `(COALESCE(tt.category,'') ILIKE '%NP%' OR COALESCE(tt.category,'') ILIKE '%NON%')`;

// Standard premium-weighted aggregate expressions over the `units` CTE, so a
// caller can `SELECT ${UNIT_AGGREGATES.avgRol} ... FROM units`. Rates (rol,
// balance, margin) are weighted by premium, never averaged naively.
export const UNIT_AGGREGATES = {
  premium:  'SUM(premium)',
  exposure: 'SUM(exposure)',
  avgRol:   'SUM(rol*premium)     FILTER (WHERE rol     IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE rol     IS NOT NULL),0)',
  // Balance = Σexposure ÷ Σpremium over PROPORTIONAL units only. Restricting
  // BOTH sides to kind='PROP' keeps NP premium out of the denominator; a group
  // with no prop units yields NULL → "—". (Intentionally prop-only, unlike the
  // headline Exposure/Premium which include NP.)
  balance:  "SUM(exposure) FILTER (WHERE kind = 'PROP') / NULLIF(SUM(premium) FILTER (WHERE kind = 'PROP'),0)",
  uwMargin: 'SUM(margin*premium)  FILTER (WHERE margin  IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE margin  IS NOT NULL),0)',
};

// ROL / balance banding for the technical-analysis tabs. Order is meaningful —
// rows render in declared order (not sorted) — and a null `hi` is open-ended.
const ROL_BANDS = [
  { label: '0–5%',   lo: 0,    hi: 0.05 },
  { label: '5–10%',  lo: 0.05, hi: 0.10 },
  { label: '10–20%', lo: 0.10, hi: 0.20 },
  { label: '>20%',   lo: 0.20, hi: null },   // null hi = open-ended
];
const BALANCE_BANDS = [
  { label: '0–1×', lo: 0, hi: 1 },
  { label: '1–3×', lo: 1, hi: 3 },
  { label: '3–8×', lo: 3, hi: 8 },
  { label: '>8×',  lo: 8, hi: null },        // edges were 0-1,1-3,3-8,>10; top set to >8 to avoid an 8–10 gap
];

// Build a half-open [lo, hi) banding CASE over a units column from a band list.
export function bandCaseSql(col, bands) {
  const whens = bands.map((b) => {
    const conds = [`${col} >= ${b.lo}`];
    if (b.hi != null) conds.push(`${col} < ${b.hi}`);
    return `WHEN ${conds.join(' AND ')} THEN '${b.label}'`;
  });
  return `CASE ${whens.join(' ')} ELSE NULL END`;
}

// One row per calculation unit so every tab aggregates prop and NP identically:
//   PROP → one row per contract (premium = signed × (QS+surplus EPI)).
//   NP   → one row per layer; uw_price is a ROL percent, so premium = signed ×
//          Σ(uw_price/100 × layer_limit) and rol is stored as a fraction.
// `where` is applied to BOTH halves of the UNION ALL. `withLob` adds the COB
// join (fanning rows out per class of business, as the legacy LOB queries do).
function buildUnitsBody(where, ccyDivisor, withLob) {
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
      ${signedShare} * (COALESCE(l.uw_price,0)/100.0 * COALESCE(l.layer_limit,0)) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS premium,
      ${signedShare} * COALESCE(l.layer_limit,0) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS exposure,
      l.uw_price / 100.0 AS rol,
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
  return `${prop}
    UNION ALL${np}`;
}

// One calculation unit per row (prop + NP). Exposed two ways so the heavy build
// is written once:
//   • unitsCte / unitsLobCte wrap it as `units AS (...)` for the per-tab queries
//   • unitsBody / unitsLobBody hand back the bare SELECT so the portfolio-overview
//     tab can inline it as `WITH units AS MATERIALIZED (...)` and share ONE build
//     across all its aggregates instead of recomputing the CTE per query.
//   WITH ${unitsCte(where, ccyDivisor)} SELECT ${UNIT_AGGREGATES.premium} FROM units
export const unitsBody    = (where, ccyDivisor) => buildUnitsBody(where, ccyDivisor, false);
export const unitsLobBody = (where, ccyDivisor) => buildUnitsBody(where, ccyDivisor, true);
export const unitsCte     = (where, ccyDivisor) => `units AS (${unitsBody(where, ccyDivisor)})`;
export const unitsLobCte  = (where, ccyDivisor) => `units AS (${unitsLobBody(where, ccyDivisor)})`;

// json_agg sub-select used to fan several aggregates out of ONE materialized
// `units` build; an optional ORDER BY inside json_agg preserves row order
// through the rollup. Shared by the overview/summary/regional/technical tabs.
const jsonAgg = (sql, order = '') =>
  `COALESCE((SELECT json_agg(t${order ? ` ORDER BY ${order}` : ''}) FROM (${sql}) t), '[]'::json)`;

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
  // public.contract ONLY. Quotes never feed exposure directly; a SIGNED quote
  // enters the portfolio by BINDING into a contract (POST /api/quotes/:id/bind →
  // services/quoteBind.js), which creates the contract row this aggregation picks
  // up. The quote itself stays a frozen as-quoted snapshot.
  //
  // Response coercion: keep a SQL NULL (e.g. a premium-weighted rate with no
  // contributing rows) as null rather than turning it into 0.
  const num = (v) => (v == null ? null : Number(v));

  // ── portfolio-overview ────────────────────────────────────────────────
  if (tab === 'portfolio-overview') {
    // Every metric is computed over the shared units / unitsLob CTEs so prop
    // and NP roll up consistently. mw_num / mw_den are the premium-weighted
    // margin numerator/denominator feeding buildWeightedPivot.
    const unitsW   = unitsBody(where, ccyDivisor);
    const unitsLob = unitsLobBody(where, ccyDivisor);
    const mwNum = 'COALESCE(SUM(margin*premium) FILTER (WHERE margin IS NOT NULL),0) AS mw_num';
    const mwDen = 'COALESCE(SUM(premium)        FILTER (WHERE margin IS NOT NULL),0) AS mw_den';

    // Build the heavy prop+NP `units` set ONCE per query: a MATERIALIZED CTE is
    // evaluated a single time and shared by every reference, so the seven aggregates
    // fan out from one build instead of recomputing the union seven times.

    // Two queries — one over `units`, one over the LOB-fanned `units` — run in
    // parallel, replacing seven independent CTE rebuilds (and seven pooled
    // connections) with two while returning byte-identical aggregates.
    const [aRes, bRes] = await Promise.all([
      pool.query(`WITH units AS MATERIALIZED (${unitsW})
        SELECT
          (SELECT json_build_object(
             'contracts',   COUNT(DISTINCT contract_id)::int,
             'premium',     ${UNIT_AGGREGATES.premium},
             'exposure',    ${UNIT_AGGREGATES.exposure},
             'balance',     ${UNIT_AGGREGATES.balance},
             'avgRol',      ${UNIT_AGGREGATES.avgRol},
             'avgUwMargin', ${UNIT_AGGREGATES.uwMargin}
           ) FROM units) AS kpi,
          ${jsonAgg(`SELECT region,
              COUNT(DISTINCT contract_id)::int        AS contracts,
              ${UNIT_AGGREGATES.premium}  AS premium,
              ${UNIT_AGGREGATES.exposure} AS exposure,
              ${UNIT_AGGREGATES.avgRol}               AS rol,
              ${UNIT_AGGREGATES.balance}              AS balance,
              ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
            FROM units GROUP BY region`, 'premium DESC')} AS region_rows,
          ${jsonAgg(`SELECT to_char(inception_date,'YYYY-MM') AS month, COALESCE(SUM(premium),0) AS value
            FROM units WHERE inception_date IS NOT NULL GROUP BY 1`, 'month')} AS month_rows,
          ${jsonAgg(`SELECT region, treaty_type,
              COALESCE(SUM(premium),0)  AS premium,
              COALESCE(SUM(exposure),0) AS exposure,
              ${mwNum}, ${mwDen}
            FROM units GROUP BY region, treaty_type`)} AS regtreaty_rows`, params),

      pool.query(`WITH units AS MATERIALIZED (${unitsLob})
        SELECT
          ${jsonAgg(`SELECT lob,
              COUNT(DISTINCT contract_id)::int        AS contracts,
              ${UNIT_AGGREGATES.premium}  AS premium,
              ${UNIT_AGGREGATES.exposure} AS exposure,
              ${UNIT_AGGREGATES.avgRol}               AS rol,
              ${UNIT_AGGREGATES.balance}              AS balance,
              ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
            FROM units WHERE lob IS NOT NULL GROUP BY lob`, 'premium DESC')} AS lob_rows,
          ${jsonAgg(`SELECT lob, treaty_type,
              COALESCE(SUM(premium),0)  AS premium,
              COALESCE(SUM(exposure),0) AS exposure,
              ${mwNum}, ${mwDen}
            FROM units WHERE lob IS NOT NULL GROUP BY lob, treaty_type`)} AS lobtreaty_rows,
          ${jsonAgg(`SELECT lob, region,
              COALESCE(SUM(premium),0)  AS premium,
              ${mwNum}, ${mwDen}
            FROM units WHERE lob IS NOT NULL GROUP BY lob, region`)} AS lobregion_rows`, params),
    ]);

    const a = aRes.rows[0] || {};
    const b = bRes.rows[0] || {};
    const kpi           = a.kpi            || {};
    const regionAgg     = a.region_rows    || [];
    const monthAgg      = a.month_rows     || [];
    const regTreatyAgg  = a.regtreaty_rows || [];
    const lobAgg        = b.lob_rows       || [];
    const lobTreatyAgg  = b.lobtreaty_rows || [];
    const lobRegionAgg  = b.lobregion_rows || [];

    // Region rows: drop the 'Other' bucket; portfolioPct is each region's share
    // of the shown region premium so the column sums to ~100%.
    const regionRows = regionAgg.filter(r => r.region && r.region !== 'Other');
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
    const totalLobPrem = lobAgg.reduce((s, r) => s + Number(r.premium), 0);
    const summaryByLob = lobAgg.map(r => ({
      lob:       r.lob,
      contracts: r.contracts,
      premium:   Number(r.premium),
      exposure:  Number(r.exposure),
      rol:       num(r.rol),
      balance:   num(r.balance),
      uwMargin:  num(r.uwMargin),
      portfolioPct: totalLobPrem > 0 ? Number(r.premium) / totalLobPrem : 0,
    }));

    const premiumRegionTreaty = buildPivot(regTreatyAgg, 'region', 'treaty_type', 'premium');
    const premiumLobTreaty    = buildPivot(lobTreatyAgg, 'lob',    'treaty_type', 'premium');

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
        premiumByMonth: monthAgg.map(r => ({ month: r.month, value: Number(r.value) || 0 })),
      },
      premiumRegionTreaty,
      exposureRegionTreaty:    buildPivot(regTreatyAgg, 'region', 'treaty_type', 'exposure'),
      uwMarginRegionTreaty:    buildWeightedPivot(regTreatyAgg, 'region', 'treaty_type', 'mw_num', 'mw_den'),
      compositionRegionTreaty: normalizePivot(premiumRegionTreaty),
      premiumLobTreaty,
      exposureLobTreaty:       buildPivot(lobTreatyAgg, 'lob', 'treaty_type', 'exposure'),
      uwMarginLobTreaty:       buildWeightedPivot(lobTreatyAgg, 'lob', 'treaty_type', 'mw_num', 'mw_den'),
      compositionLobTreaty:    normalizePivot(premiumLobTreaty),
      premiumLobRegion:        buildPivot(lobRegionAgg, 'lob', 'region', 'premium'),
      uwMarginLobRegion:       buildWeightedPivot(lobRegionAgg, 'lob', 'region', 'mw_num', 'mw_den'),
    });
  }

  // ── portfolio-summary ─────────────────────────────────────────────────
  if (tab === 'portfolio-summary') {
    // ONE materialized `units` build shared by both aggregates (same pattern
    // as portfolio-overview) instead of two independent CTE rebuilds.
    const { rows: [s] } = await pool.query(`WITH units AS MATERIALIZED (${unitsBody(where, ccyDivisor)})
      SELECT
        ${jsonAgg(`SELECT uw_year AS "uwYear",
            COUNT(DISTINCT contract_id)::int        AS contracts,
            ${UNIT_AGGREGATES.premium}  AS premium,
            ${UNIT_AGGREGATES.exposure} AS exposure,
            ${UNIT_AGGREGATES.balance}              AS balance,
            ${UNIT_AGGREGATES.avgRol}               AS rol,
            ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
          FROM units GROUP BY uw_year`, '"uwYear"')} AS by_year_rows,
        ${jsonAgg(`SELECT region, uw_year::text AS uw_year, COALESCE(SUM(premium),0) AS premium
          FROM units GROUP BY region, uw_year`, 'region, uw_year')} AS region_year_rows`, params);
    return res.json({
      kpis: {},
      byYear: (s?.by_year_rows || []).map(r => ({
        ...r,
        premium: Number(r.premium), exposure: Number(r.exposure),
        balance: num(r.balance), rol: num(r.rol), uwMargin: num(r.uwMargin),
      })),
      regionYear: buildPivot(s?.region_year_rows || [], 'region', 'uw_year', 'premium'),
    });
  }

  // ── regional-analysis ────────────────────────────────────────────────
  // Region-scoped: the region filter is already in `where`, so every unit
  // here belongs to the selected region and portfolioPct is within-region.
  if (tab === 'regional-analysis') {
    const mwNum = 'COALESCE(SUM(margin*premium) FILTER (WHERE margin IS NOT NULL),0) AS mw_num';
    const mwDen = 'COALESCE(SUM(premium)        FILTER (WHERE margin IS NOT NULL),0) AS mw_den';
    // Two queries: the by-year rollup over `units`, and ONE materialized
    // LOB-fanned build shared by both LOB aggregates (previously two
    // independent rebuilds of the heavy union).
    const [byYearR, lobRes] = await Promise.all([
      pool.query(`WITH ${unitsCte(where, ccyDivisor)}
        SELECT uw_year AS "uwYear",
          COUNT(DISTINCT contract_id)::int        AS contracts,
          ${UNIT_AGGREGATES.premium}  AS premium,
          ${UNIT_AGGREGATES.exposure} AS exposure,
          ${UNIT_AGGREGATES.balance}              AS balance,
          ${UNIT_AGGREGATES.avgRol}               AS rol,
          ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
        FROM units GROUP BY uw_year ORDER BY uw_year`, params),
      pool.query(`WITH units AS MATERIALIZED (${unitsLobBody(where, ccyDivisor)})
        SELECT
          ${jsonAgg(`SELECT lob,
              COUNT(DISTINCT contract_id)::int        AS contracts,
              ${UNIT_AGGREGATES.premium}  AS premium,
              ${UNIT_AGGREGATES.exposure} AS exposure,
              ${UNIT_AGGREGATES.balance}              AS balance,
              ${UNIT_AGGREGATES.avgRol}               AS rol,
              ${UNIT_AGGREGATES.uwMargin}             AS "uwMargin"
            FROM units WHERE lob IS NOT NULL GROUP BY lob`, 'premium DESC, lob')} AS by_lob_rows,
          ${jsonAgg(`SELECT lob, treaty_type,
              COALESCE(SUM(premium),0)  AS premium,
              COALESCE(SUM(exposure),0) AS exposure,
              ${mwNum}, ${mwDen}
            FROM units WHERE lob IS NOT NULL GROUP BY lob, treaty_type`)} AS lob_treaty_rows`, params),
    ]);
    const byLobRows = lobRes.rows[0]?.by_lob_rows || [];
    const lobTreatyRows = lobRes.rows[0]?.lob_treaty_rows || [];
    const totalLobPrem = byLobRows.reduce((s, r) => s + Number(r.premium), 0);
    const lobTreatyPremium = buildPivot(lobTreatyRows, 'lob', 'treaty_type', 'premium');
    return res.json({
      kpis: {},
      byYear: byYearR.rows.map(r => ({
        ...r,
        premium: Number(r.premium), exposure: Number(r.exposure),
        balance: num(r.balance), rol: num(r.rol), uwMargin: num(r.uwMargin),
      })),
      byLob: byLobRows.map(r => ({
        lob: r.lob, contracts: r.contracts,
        premium: Number(r.premium), exposure: Number(r.exposure),
        rol: num(r.rol), balance: num(r.balance), uwMargin: num(r.uwMargin),
        portfolioPct: totalLobPrem > 0 ? Number(r.premium) / totalLobPrem : 0,
      })),
      lobTreatyPremium,
      lobTreatyExposure:    buildPivot(lobTreatyRows, 'lob', 'treaty_type', 'exposure'),
      lobTreatyComposition: normalizePivot(lobTreatyPremium),
      lobTreatyUwMargin:    buildWeightedPivot(lobTreatyRows, 'lob', 'treaty_type', 'mw_num', 'mw_den'),
    });
  }

  // ── technical-analysis (portfolio + regional) ─────────────────────────
  // Both tabs are identical apart from the region filter, which is already in
  // `where`; the regional tab is gated client-side on a region selection.
  if (tab === 'portfolio-technical-analysis' || tab === 'regional-technical-analysis') {
    // ONE materialized `units` build shared by all four aggregates (previously
    // four independent rebuilds of the heavy prop+NP union per request).
    const { rows: [tRow] } = await pool.query(`WITH units AS MATERIALIZED (${unitsBody(where, ccyDivisor)})
      SELECT
        ${jsonAgg(`SELECT ${bandCaseSql('rol', ROL_BANDS)} AS band,
            COUNT(DISTINCT contract_id)::int AS contracts,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${UNIT_AGGREGATES.avgRol}   AS rol,
            ${UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units WHERE kind = 'NP' GROUP BY 1`)} AS rol_band_rows,
        ${jsonAgg(`SELECT ${bandCaseSql('balance', BALANCE_BANDS)} AS band,
            COUNT(DISTINCT contract_id)::int AS contracts,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${UNIT_AGGREGATES.balance}  AS balance,
            ${UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units WHERE kind = 'PROP' GROUP BY 1`)} AS balance_band_rows,
        ${jsonAgg(`SELECT treaty_type AS "treatyType",
            CASE WHEN COALESCE(SUM(premium) FILTER (WHERE kind = 'NP'),0)
                    >  COALESCE(SUM(premium) FILTER (WHERE kind = 'PROP'),0)
                 THEN 'NP' ELSE 'PROP' END AS kind,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${UNIT_AGGREGATES.avgRol}   AS rol,
            ${UNIT_AGGREGATES.balance}  AS balance,
            ${UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units GROUP BY treaty_type`, 'premium DESC, "treatyType"')} AS treaty_rows,
        ${jsonAgg(`SELECT treaty_type, uw_year::text AS uw_year,
            COALESCE(SUM(premium),0) AS premium,
            COALESCE(SUM(exposure) FILTER (WHERE kind = 'PROP'),0) AS bal_num,
            COALESCE(SUM(premium)  FILTER (WHERE kind = 'PROP'),0) AS bal_den,
            COALESCE(SUM(rol*premium)     FILTER (WHERE rol     IS NOT NULL),0) AS rol_num,
            COALESCE(SUM(premium)         FILTER (WHERE rol     IS NOT NULL),0) AS rol_den,
            COALESCE(SUM(margin*premium)  FILTER (WHERE margin  IS NOT NULL),0) AS mw_num,
            COALESCE(SUM(premium)         FILTER (WHERE margin  IS NOT NULL),0) AS mw_den
          FROM units GROUP BY treaty_type, uw_year`)} AS treaty_year_rows`, params);
    const rolBandsR     = { rows: tRow?.rol_band_rows || [] };
    const balanceBandsR = { rows: tRow?.balance_band_rows || [] };
    const treatyR       = { rows: tRow?.treaty_rows || [] };
    const treatyYearR   = { rows: tRow?.treaty_year_rows || [] };

    // Re-key band aggregates and emit one row per declared band (zero-filling
    // empty bands), preserving declared order.
    const rolByBand = new Map(rolBandsR.rows.map(r => [r.band, r]));
    const rolBands = ROL_BANDS.map(b => {
      const r = rolByBand.get(b.label);
      return {
        band: b.label,
        contracts: r ? Number(r.contracts) : 0,
        premium:  r ? Number(r.premium) : 0,
        exposure: r ? Number(r.exposure) : 0,
        rol:      r ? num(r.rol) : null,
        uwMargin: r ? num(r.uwMargin) : null,
      };
    });

    const balByBand = new Map(balanceBandsR.rows.map(r => [r.band, r]));
    const balanceBands = BALANCE_BANDS.map(b => {
      const r = balByBand.get(b.label);
      return {
        band: b.label,
        contracts: r ? Number(r.contracts) : 0,
        premium:  r ? Number(r.premium) : 0,
        exposure: r ? Number(r.exposure) : 0,
        balance:  r ? num(r.balance) : null,
        uwMargin: r ? num(r.uwMargin) : null,
      };
    });

    const byTreatyType = treatyR.rows.map(r => ({
      treatyType: r.treatyType,
      kind:     r.kind === 'NP' ? 'NP' : 'PROP',
      premium:  Number(r.premium),
      exposure: Number(r.exposure),
      rol:      num(r.rol),
      balance:  num(r.balance),
      uwMargin: num(r.uwMargin),
    }));

    return res.json({
      kpis: {},
      rolBands,
      balanceBands,
      byTreatyType,
      // treatyType → 'NP'|'PROP' so the client diagonal matrix can pick Balance
      // (prop) vs ROL (NP) for each cell and colour the row stripe.
      treatyKindByType: buildTreatyKindMap(byTreatyType),
      // xolBandLayerPremium is intentionally omitted (pending the premium-band
      // definition); the client no-ops on an undefined pivot.
      treatyPremiumByYear:  buildPivot(treatyYearR.rows, 'treaty_type', 'uw_year', 'premium'),
      treatyBalanceByYear:  buildWeightedPivot(treatyYearR.rows, 'treaty_type', 'uw_year', 'bal_num', 'bal_den'),
      treatyRolByYear:      buildWeightedPivot(treatyYearR.rows, 'treaty_type', 'uw_year', 'rol_num', 'rol_den'),
      treatyUwMarginByYear: buildWeightedPivot(treatyYearR.rows, 'treaty_type', 'uw_year', 'mw_num', 'mw_den'),
    });
  }

  res.json({ kpis: {}, rows: [] });
}));

// ── Treaty-class map ────────────────────────────────────────────────────────
// Collapse the byTreatyType rows to a { treatyType: 'NP'|'PROP' } lookup. The
// technical-analysis matrix reads this to choose Balance (prop) vs ROL (NP) per
// cell and to colour each row's class stripe. Anything not flagged NP is PROP.
export function buildTreatyKindMap(byTreatyType) {
  const map = {};
  for (const r of byTreatyType || []) {
    if (r && r.treatyType != null) map[r.treatyType] = r.kind === 'NP' ? 'NP' : 'PROP';
  }
  return map;
}

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
// → NULL, surfaced as N/A — never 0). Crucially the row total and grand totals
// are ALSO Σnum / Σden over the cell's members — never a sum or average of
// per-cell ratios. Use for ROL / margin / balance pivots where summing rates
// would be meaningless.
export function buildWeightedPivot(rows, rowKey, colKey, numKey, denKey) {
  const div = (n, d) => (d ? n / d : null);
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
      for (const c of columns) values[c] = r.cells[c] ? div(r.cells[c].num, r.cells[c].den) : null;
      const out = { key, values, total: div(r.num, r.den) };
      out[rowKey === 'lob' ? 'lob' : 'region'] = key;
      return out;
    })
    .sort((a, b) => (b.total || 0) - (a.total || 0));
  const totals = { values: {}, total: div(grandNum, grandDen) };
  for (const c of columns) totals.values[c] = colTotals[c] ? div(colTotals[c].num, colTotals[c].den) : null;
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
