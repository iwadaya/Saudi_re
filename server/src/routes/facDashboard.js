// server/src/routes/facDashboard.js — Facultative portfolio dashboard.
// The fac twin of dashboard.js: same tabs, same pivot/weighted-pivot shapes,
// same currency handling, aggregated over fac_risk instead of contract.
//
// Treaty → fac translation:
//   contract            → fac_risk (one calculation unit per risk, no layer fan)
//   treaty_type         → FAC type ('Proportional FAC' | 'XL FAC') from placement_type
//   class_of_business   → fac_class_of_business (the risk's class)
//   Balance (limit÷prem)→ Rate ‰ (premium ÷ sum insured × 1000) — the fac book
//                         prices in rate per mille, and a fac "balance" would sit
//                         in the hundreds; the rate is the same information in
//                         the unit fac underwriters use.
//   ROL                 → unchanged for XL fac (premium ÷ limit)
//   UW margin           → share of the final premium above the technical price:
//                         1 − technical_gross_rate_pm ÷ final_rate_per_mille.
//                         Risks priced before the technical build-up existed
//                         carry NULL and drop out of the weighted margin, same
//                         as treaty units without a priced margin.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncHandler } from "../helpers.js";
import {
  regionBucket, fxSub, bandCaseSql,
  buildPivot, buildWeightedPivot, normalizePivot,
} from "./dashboard.js";
const router = Router();

// Placement type → the display label the dashboard groups and filters by.
const FAC_TYPE_BY_PLACEMENT = { PROPORTIONAL: 'Proportional FAC', NON_PROPORTIONAL: 'XL FAC' };
const PLACEMENT_BY_FAC_TYPE = Object.fromEntries(
  Object.entries(FAC_TYPE_BY_PLACEMENT).map(([k, v]) => [v, k]),
);
const facTypeCase = `CASE WHEN r.placement_type = 'NON_PROPORTIONAL'
    THEN '${FAC_TYPE_BY_PLACEMENT.NON_PROPORTIONAL}' ELSE '${FAC_TYPE_BY_PLACEMENT.PROPORTIONAL}' END`;

// Premium-weighted aggregates over the fac `units` CTE. Identical to the treaty
// UNIT_AGGREGATES except the prop headline: `rate` (‰, Σprem ÷ ΣSI × 1000 over
// PROPORTIONAL units only) replaces `balance`. Rates are premium-weighted,
// never averaged naively.
export const FAC_UNIT_AGGREGATES = {
  premium:  'SUM(premium)',
  exposure: 'SUM(exposure)',
  avgRol:   'SUM(rol*premium)     FILTER (WHERE rol     IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE rol     IS NOT NULL),0)',
  rate:     "1000.0 * SUM(premium) FILTER (WHERE kind = 'PROP') / NULLIF(SUM(exposure) FILTER (WHERE kind = 'PROP'),0)",
  uwMargin: 'SUM(margin*premium)  FILTER (WHERE margin  IS NOT NULL) / NULLIF(SUM(premium) FILTER (WHERE margin  IS NOT NULL),0)',
};

// Banding for the technical-analysis tabs. XL fac keeps the treaty ROL bands;
// proportional fac bands on the achieved rate ‰ (the market benchmarks seeded
// in fac_market_rate run ≈0.35–1.3‰, so these edges split the realistic book).
// Order is meaningful — rows render in declared order — and null hi is open.
const ROL_BANDS = [
  { label: '0–5%',   lo: 0,    hi: 0.05 },
  { label: '5–10%',  lo: 0.05, hi: 0.10 },
  { label: '10–20%', lo: 0.10, hi: 0.20 },
  { label: '>20%',   lo: 0.20, hi: null },
];
const RATE_BANDS = [
  { label: '0–0.5‰', lo: 0,   hi: 0.5 },
  { label: '0.5–1‰', lo: 0.5, hi: 1 },
  { label: '1–2‰',   lo: 1,   hi: 2 },
  { label: '>2‰',    lo: 2,   hi: null },
];

// One row per fac risk with premium/exposure on OUR share, in display currency:
//   PROP → premium = ri_premium (our share by definition);
//          exposure = TSI × RI share × our signed share.
//   XL   → premium = ri_premium;
//          exposure = layer limit × our share — risk-level np_limit ×
//          np_our_share_pct when set, else the summed fac_layer tower (each
//          layer at its own share) for risks structured with layers only.
// rol / rate are derived on our-share economics (the shares cancel, so they
// match the cedant-level rate). margin comes from fac_pricing, UNIQUE per risk
// so the join can never fan out. `where` must filter on alias r.
export function facUnitsBody(where, ccyDivisor) {
  return `
    SELECT u.*,
      CASE WHEN u.kind = 'NP'   AND u.exposure > 0 THEN u.premium / u.exposure          END AS rol,
      CASE WHEN u.kind = 'PROP' AND u.exposure > 0 THEN 1000.0 * u.premium / u.exposure END AS rate
    FROM (
      SELECT
        r.fac_risk_id,
        cob.class_name AS lob,
        ${regionBucket} AS region,
        ${facTypeCase} AS fac_type,
        CASE WHEN r.placement_type = 'NON_PROPORTIONAL' THEN 'NP' ELSE 'PROP' END::text AS kind,
        COALESCE(r.ri_premium,0) * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS premium,
        CASE WHEN r.placement_type = 'NON_PROPORTIONAL'
             THEN CASE WHEN COALESCE(r.np_limit,0) > 0
                       THEN r.np_limit * COALESCE(r.np_our_share_pct,100.0) / 100.0
                       ELSE COALESCE(lay.limit_share_sum,0) END
             ELSE COALESCE(r.total_sum_insured,0)
                  * COALESCE(r.ri_share_pct,100.0) / 100.0
                  * COALESCE(r.our_share_pct,100.0) / 100.0
        END * COALESCE(fx.rate_to_usd,1.0) / ${ccyDivisor} AS exposure,
        CASE WHEN p.final_rate_per_mille > 0 AND p.technical_gross_rate_pm > 0
             THEN 1.0 - (p.technical_gross_rate_pm / p.final_rate_per_mille) END AS margin,
        r.inception_date AS inception_date,
        r.uw_year AS uw_year
      FROM public.fac_risk r
      LEFT JOIN public.country cnt ON cnt.country_id = r.country_id
      LEFT JOIN public.fac_class_of_business cob ON cob.fac_cob_id = r.fac_cob_id
      LEFT JOIN public.currency cur ON cur.currency_id = r.currency_id
      LEFT JOIN ${fxSub} ON fx.currency_code = cur.currency_code
      LEFT JOIN public.fac_pricing p ON p.fac_risk_id = r.fac_risk_id
      LEFT JOIN (SELECT fac_risk_id,
                        SUM(COALESCE(limit_amount,0) * COALESCE(our_share_pct,100.0) / 100.0) AS limit_share_sum
                   FROM public.fac_layer GROUP BY fac_risk_id) lay ON lay.fac_risk_id = r.fac_risk_id
      ${where}
    ) u`;
}

// json_agg sub-select used to fan several aggregates out of ONE materialized
// `units` build (same pattern as dashboard.js).
const jsonAgg = (sql, order = '') =>
  `COALESCE((SELECT json_agg(t${order ? ` ORDER BY ${order}` : ''}) FROM (${sql}) t), '[]'::json)`;

// ── Filters ───────────────────────────────────────────────────────────────
router.get("/fac-dashboard/filters", asyncHandler(async (_req, res) => {
  const [years, regions, months] = await Promise.all([
    pool.query(`SELECT DISTINCT uw_year FROM public.fac_risk
                WHERE uw_year IS NOT NULL ORDER BY uw_year DESC LIMIT 10`),
    pool.query(`SELECT DISTINCT
      CASE WHEN region IN ('GCC','Levant','North Africa') THEN 'Middle East'
           WHEN region IN ('Sub-Saharan Africa')          THEN 'Africa'
           WHEN region IN ('South Asia','Southeast Asia','East Asia & Pacific') THEN 'Asia'
           WHEN region = 'Europe'   THEN 'Europe'
           WHEN region = 'Americas' THEN 'Americas'
           ELSE NULL END AS r
      FROM public.country WHERE region IS NOT NULL ORDER BY 1`),
    pool.query(`SELECT DISTINCT EXTRACT(MONTH FROM inception_date)::int AS m
                FROM public.fac_risk WHERE inception_date IS NOT NULL ORDER BY 1`),
  ]);
  res.json({
    uwYears:      years.rows.map(r => r.uw_year),
    regions:      regions.rows.map(r => r.r).filter(Boolean),
    facTypes:     Object.values(FAC_TYPE_BY_PLACEMENT),
    months:       months.rows.map(r => r.m),
    currencies:   ['USD','SAR','GBP'],
    defaultUwYear: years.rows[0]?.uw_year || null,
  });
}));

// ── Main page data ────────────────────────────────────────────────────────
router.get("/fac-dashboard/page/:tab", asyncHandler(async (req, res) => {
  const { tab } = req.params;
  const { uwYear, month, region, facType, currency: reqCurrency } = req.query;

  // Target display currency (default USD)
  const ALLOWED = ['USD','SAR','GBP'];
  const displayCcy = ALLOWED.includes(reqCurrency) ? reqCurrency : 'USD';

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
  const ccyDivisor = targetRateToUsd;

  // WHERE — live book only: DRAFT is not yet a position; DECLINED/NTU/CANCELLED
  // never went (or stopped being) on risk. QUOTED/REFERRED/BOUND/RENEWED stay,
  // mirroring the treaty dashboard's active-portfolio filter.
  const conds = ["r.status NOT IN ('DRAFT','DECLINED','NTU','CANCELLED')"];
  const params = [];
  let i = 1;
  if (uwYear) { conds.push(`r.uw_year = $${i++}`); params.push(Number(uwYear)); }
  if (month)  { conds.push(`EXTRACT(MONTH FROM r.inception_date) = $${i++}`); params.push(Number(month)); }
  if (facType && PLACEMENT_BY_FAC_TYPE[facType]) {
    conds.push(`r.placement_type = $${i++}`); params.push(PLACEMENT_BY_FAC_TYPE[facType]);
  }
  if (region) { conds.push(`(${regionBucket}) = $${i++}`); params.push(region); }
  const where = `WHERE ${conds.join(' AND ')}`;

  // Keep a SQL NULL (a weighted rate with no contributing rows) as null.
  const num = (v) => (v == null ? null : Number(v));

  // ── portfolio-overview ────────────────────────────────────────────────
  if (tab === 'portfolio-overview') {
    // Fac units carry their class inline (no COB fan-out), so ONE materialized
    // build feeds every aggregate on this tab.
    const mwNum = 'COALESCE(SUM(margin*premium) FILTER (WHERE margin IS NOT NULL),0) AS mw_num';
    const mwDen = 'COALESCE(SUM(premium)        FILTER (WHERE margin IS NOT NULL),0) AS mw_den';
    const { rows: [a] } = await pool.query(`WITH units AS MATERIALIZED (${facUnitsBody(where, ccyDivisor)})
      SELECT
        (SELECT json_build_object(
           'risks',       COUNT(DISTINCT fac_risk_id)::int,
           'premium',     ${FAC_UNIT_AGGREGATES.premium},
           'exposure',    ${FAC_UNIT_AGGREGATES.exposure},
           'rate',        ${FAC_UNIT_AGGREGATES.rate},
           'avgRol',      ${FAC_UNIT_AGGREGATES.avgRol},
           'avgUwMargin', ${FAC_UNIT_AGGREGATES.uwMargin}
         ) FROM units) AS kpi,
        ${jsonAgg(`SELECT region,
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            ${FAC_UNIT_AGGREGATES.premium}  AS premium,
            ${FAC_UNIT_AGGREGATES.exposure} AS exposure,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units GROUP BY region`, 'premium DESC')} AS region_rows,
        ${jsonAgg(`SELECT to_char(inception_date,'YYYY-MM') AS month, COALESCE(SUM(premium),0) AS value
          FROM units WHERE inception_date IS NOT NULL GROUP BY 1`, 'month')} AS month_rows,
        ${jsonAgg(`SELECT region, fac_type,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${mwNum}, ${mwDen}
          FROM units GROUP BY region, fac_type`)} AS regtype_rows,
        ${jsonAgg(`SELECT lob,
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            ${FAC_UNIT_AGGREGATES.premium}  AS premium,
            ${FAC_UNIT_AGGREGATES.exposure} AS exposure,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units WHERE lob IS NOT NULL GROUP BY lob`, 'premium DESC')} AS lob_rows,
        ${jsonAgg(`SELECT lob, fac_type,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${mwNum}, ${mwDen}
          FROM units WHERE lob IS NOT NULL GROUP BY lob, fac_type`)} AS lobtype_rows,
        ${jsonAgg(`SELECT lob, region,
            COALESCE(SUM(premium),0) AS premium,
            ${mwNum}, ${mwDen}
          FROM units WHERE lob IS NOT NULL GROUP BY lob, region`)} AS lobregion_rows`, params);

    const kpi          = a?.kpi            || {};
    const regionAgg    = a?.region_rows    || [];
    const monthAgg     = a?.month_rows     || [];
    const regTypeAgg   = a?.regtype_rows   || [];
    const lobAgg       = a?.lob_rows       || [];
    const lobTypeAgg   = a?.lobtype_rows   || [];
    const lobRegionAgg = a?.lobregion_rows || [];

    const regionRows = regionAgg.filter(r => r.region && r.region !== 'Other');
    const totalRegionPrem = regionRows.reduce((s, r) => s + Number(r.premium), 0);
    const summaryByRegion = regionRows.map(r => ({
      region:   r.region,
      risks:    r.risks,
      premium:  Number(r.premium),
      exposure: Number(r.exposure),
      rol:      num(r.rol),
      rate:     num(r.rate),
      uwMargin: num(r.uwMargin),
      portfolioPct: totalRegionPrem > 0 ? Number(r.premium) / totalRegionPrem : 0,
    }));

    const totalLobPrem = lobAgg.reduce((s, r) => s + Number(r.premium), 0);
    const summaryByLob = lobAgg.map(r => ({
      lob:      r.lob,
      risks:    r.risks,
      premium:  Number(r.premium),
      exposure: Number(r.exposure),
      rol:      num(r.rol),
      rate:     num(r.rate),
      uwMargin: num(r.uwMargin),
      portfolioPct: totalLobPrem > 0 ? Number(r.premium) / totalLobPrem : 0,
    }));

    const premiumRegionFacType = buildPivot(regTypeAgg, 'region', 'fac_type', 'premium');
    const premiumLobFacType    = buildPivot(lobTypeAgg, 'lob',    'fac_type', 'premium');

    return res.json({
      kpis: {
        risks:       kpi.risks || 0,
        premium:     Number(kpi.premium) || 0,
        exposure:    Number(kpi.exposure) || 0,
        rate:        num(kpi.rate),
        avgRol:      num(kpi.avgRol),
        avgUwMargin: num(kpi.avgUwMargin),
      },
      summaryByRegion,
      summaryByLob,
      series: {
        premiumByMonth: monthAgg.map(r => ({ month: r.month, value: Number(r.value) || 0 })),
      },
      premiumRegionFacType,
      exposureRegionFacType:    buildPivot(regTypeAgg, 'region', 'fac_type', 'exposure'),
      uwMarginRegionFacType:    buildWeightedPivot(regTypeAgg, 'region', 'fac_type', 'mw_num', 'mw_den'),
      compositionRegionFacType: normalizePivot(premiumRegionFacType),
      premiumLobFacType,
      exposureLobFacType:       buildPivot(lobTypeAgg, 'lob', 'fac_type', 'exposure'),
      uwMarginLobFacType:       buildWeightedPivot(lobTypeAgg, 'lob', 'fac_type', 'mw_num', 'mw_den'),
      compositionLobFacType:    normalizePivot(premiumLobFacType),
      premiumLobRegion:         buildPivot(lobRegionAgg, 'lob', 'region', 'premium'),
      uwMarginLobRegion:        buildWeightedPivot(lobRegionAgg, 'lob', 'region', 'mw_num', 'mw_den'),
    });
  }

  // ── portfolio-summary ─────────────────────────────────────────────────
  if (tab === 'portfolio-summary') {
    const { rows: [s] } = await pool.query(`WITH units AS MATERIALIZED (${facUnitsBody(where, ccyDivisor)})
      SELECT
        ${jsonAgg(`SELECT uw_year AS "uwYear",
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            ${FAC_UNIT_AGGREGATES.premium}  AS premium,
            ${FAC_UNIT_AGGREGATES.exposure} AS exposure,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units GROUP BY uw_year`, '"uwYear"')} AS by_year_rows,
        ${jsonAgg(`SELECT region, uw_year::text AS uw_year, COALESCE(SUM(premium),0) AS premium
          FROM units GROUP BY region, uw_year`, 'region, uw_year')} AS region_year_rows`, params);
    return res.json({
      kpis: {},
      byYear: (s?.by_year_rows || []).map(r => ({
        ...r,
        premium: Number(r.premium), exposure: Number(r.exposure),
        rate: num(r.rate), rol: num(r.rol), uwMargin: num(r.uwMargin),
      })),
      regionYear: buildPivot(s?.region_year_rows || [], 'region', 'uw_year', 'premium'),
    });
  }

  // ── regional-analysis ────────────────────────────────────────────────
  // Region-scoped: the region filter is already in `where`, so portfolioPct
  // is within-region. Gated client-side on a region selection.
  if (tab === 'regional-analysis') {
    const mwNum = 'COALESCE(SUM(margin*premium) FILTER (WHERE margin IS NOT NULL),0) AS mw_num';
    const mwDen = 'COALESCE(SUM(premium)        FILTER (WHERE margin IS NOT NULL),0) AS mw_den';
    const { rows: [s] } = await pool.query(`WITH units AS MATERIALIZED (${facUnitsBody(where, ccyDivisor)})
      SELECT
        ${jsonAgg(`SELECT uw_year AS "uwYear",
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            ${FAC_UNIT_AGGREGATES.premium}  AS premium,
            ${FAC_UNIT_AGGREGATES.exposure} AS exposure,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units GROUP BY uw_year`, '"uwYear"')} AS by_year_rows,
        ${jsonAgg(`SELECT lob,
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            ${FAC_UNIT_AGGREGATES.premium}  AS premium,
            ${FAC_UNIT_AGGREGATES.exposure} AS exposure,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units WHERE lob IS NOT NULL GROUP BY lob`, 'premium DESC, lob')} AS by_lob_rows,
        ${jsonAgg(`SELECT lob, fac_type,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${mwNum}, ${mwDen}
          FROM units WHERE lob IS NOT NULL GROUP BY lob, fac_type`)} AS lob_type_rows`, params);
    const byLobRows = s?.by_lob_rows || [];
    const lobTypeRows = s?.lob_type_rows || [];
    const totalLobPrem = byLobRows.reduce((t, r) => t + Number(r.premium), 0);
    const lobFacTypePremium = buildPivot(lobTypeRows, 'lob', 'fac_type', 'premium');
    return res.json({
      kpis: {},
      byYear: (s?.by_year_rows || []).map(r => ({
        ...r,
        premium: Number(r.premium), exposure: Number(r.exposure),
        rate: num(r.rate), rol: num(r.rol), uwMargin: num(r.uwMargin),
      })),
      byLob: byLobRows.map(r => ({
        lob: r.lob, risks: r.risks,
        premium: Number(r.premium), exposure: Number(r.exposure),
        rol: num(r.rol), rate: num(r.rate), uwMargin: num(r.uwMargin),
        portfolioPct: totalLobPrem > 0 ? Number(r.premium) / totalLobPrem : 0,
      })),
      lobFacTypePremium,
      lobFacTypeExposure:    buildPivot(lobTypeRows, 'lob', 'fac_type', 'exposure'),
      lobFacTypeComposition: normalizePivot(lobFacTypePremium),
      lobFacTypeUwMargin:    buildWeightedPivot(lobTypeRows, 'lob', 'fac_type', 'mw_num', 'mw_den'),
    });
  }

  // ── technical-analysis (portfolio + regional) ─────────────────────────
  if (tab === 'portfolio-technical-analysis' || tab === 'regional-technical-analysis') {
    const { rows: [tRow] } = await pool.query(`WITH units AS MATERIALIZED (${facUnitsBody(where, ccyDivisor)})
      SELECT
        ${jsonAgg(`SELECT ${bandCaseSql('rol', ROL_BANDS)} AS band,
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units WHERE kind = 'NP' GROUP BY 1`)} AS rol_band_rows,
        ${jsonAgg(`SELECT ${bandCaseSql('rate', RATE_BANDS)} AS band,
            COUNT(DISTINCT fac_risk_id)::int AS risks,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units WHERE kind = 'PROP' GROUP BY 1`)} AS rate_band_rows,
        ${jsonAgg(`SELECT fac_type AS "facType",
            CASE WHEN COALESCE(SUM(premium) FILTER (WHERE kind = 'NP'),0)
                    >  COALESCE(SUM(premium) FILTER (WHERE kind = 'PROP'),0)
                 THEN 'NP' ELSE 'PROP' END AS kind,
            COALESCE(SUM(premium),0)  AS premium,
            COALESCE(SUM(exposure),0) AS exposure,
            ${FAC_UNIT_AGGREGATES.avgRol}   AS rol,
            ${FAC_UNIT_AGGREGATES.rate}     AS rate,
            ${FAC_UNIT_AGGREGATES.uwMargin} AS "uwMargin"
          FROM units GROUP BY fac_type`, 'premium DESC, "facType"')} AS type_rows,
        ${jsonAgg(`SELECT fac_type, uw_year::text AS uw_year,
            COALESCE(SUM(premium),0) AS premium,
            1000.0 * COALESCE(SUM(premium)  FILTER (WHERE kind = 'PROP'),0) AS rate_num,
            COALESCE(SUM(exposure) FILTER (WHERE kind = 'PROP'),0) AS rate_den,
            COALESCE(SUM(rol*premium)     FILTER (WHERE rol     IS NOT NULL),0) AS rol_num,
            COALESCE(SUM(premium)         FILTER (WHERE rol     IS NOT NULL),0) AS rol_den,
            COALESCE(SUM(margin*premium)  FILTER (WHERE margin  IS NOT NULL),0) AS mw_num,
            COALESCE(SUM(premium)         FILTER (WHERE margin  IS NOT NULL),0) AS mw_den
          FROM units GROUP BY fac_type, uw_year`)} AS type_year_rows`, params);

    const rolBandRows  = tRow?.rol_band_rows  || [];
    const rateBandRows = tRow?.rate_band_rows || [];
    const typeRows     = tRow?.type_rows      || [];
    const typeYearRows = tRow?.type_year_rows || [];

    // One row per declared band (zero-filling empty bands), declared order.
    const rolByBand = new Map(rolBandRows.map(r => [r.band, r]));
    const rolBands = ROL_BANDS.map(b => {
      const r = rolByBand.get(b.label);
      return {
        band: b.label,
        risks:    r ? Number(r.risks) : 0,
        premium:  r ? Number(r.premium) : 0,
        exposure: r ? Number(r.exposure) : 0,
        rol:      r ? num(r.rol) : null,
        uwMargin: r ? num(r.uwMargin) : null,
      };
    });

    const rateByBand = new Map(rateBandRows.map(r => [r.band, r]));
    const rateBands = RATE_BANDS.map(b => {
      const r = rateByBand.get(b.label);
      return {
        band: b.label,
        risks:    r ? Number(r.risks) : 0,
        premium:  r ? Number(r.premium) : 0,
        exposure: r ? Number(r.exposure) : 0,
        rate:     r ? num(r.rate) : null,
        uwMargin: r ? num(r.uwMargin) : null,
      };
    });

    const byFacType = typeRows.map(r => ({
      facType:  r.facType,
      kind:     r.kind === 'NP' ? 'NP' : 'PROP',
      premium:  Number(r.premium),
      exposure: Number(r.exposure),
      rol:      num(r.rol),
      rate:     num(r.rate),
      uwMargin: num(r.uwMargin),
    }));

    // facType → 'NP'|'PROP' so the client diagonal matrix can pick Rate ‰
    // (prop) vs ROL % (XL) per cell and colour the row stripe.
    const facKindByType = {};
    for (const r of byFacType) if (r.facType != null) facKindByType[r.facType] = r.kind;

    return res.json({
      kpis: {},
      rolBands,
      rateBands,
      byFacType,
      facKindByType,
      facTypePremiumByYear:  buildPivot(typeYearRows, 'fac_type', 'uw_year', 'premium'),
      facTypeRateByYear:     buildWeightedPivot(typeYearRows, 'fac_type', 'uw_year', 'rate_num', 'rate_den'),
      facTypeRolByYear:      buildWeightedPivot(typeYearRows, 'fac_type', 'uw_year', 'rol_num', 'rol_den'),
      facTypeUwMarginByYear: buildWeightedPivot(typeYearRows, 'fac_type', 'uw_year', 'mw_num', 'mw_den'),
    });
  }

  // Return-analysis tabs mirror the treaty dashboard, where they are also
  // pending a metric definition: the client renders empty pivots.
  res.json({ kpis: {}, rows: [] });
}));

export default router;
