// server/src/services/facClassAccumulationService.js
//
// Class accumulation for the Final Pricing screen: everything the carrier is
// already on risk for in the class being priced — every bound facultative risk,
// plus every inforce treaty covering it — so the underwriter can see what this
// line adds to.
//
// ── The class is the MAPPED class, not the fac class ────────────────────────
// The two taxonomies are different granularities: fac is fine (Industrial All
// Risks, Hull & Machinery — 29 of them), treaty is coarse (Property, Marine).
// fac_to_treaty_cob_map (migration 091) bridges them by fac category. The
// accumulation is therefore taken at the TREATY class level, so "that class"
// means the same thing on both halves and the two subtotals are commensurable:
// pricing an Industrial All Risks risk shows all PROPERTY fac risks alongside
// the Property treaties. Each row names its own fac class so the composition
// stays visible. A fac class with no mapping (CYBER has no treaty equivalent)
// returns no treaties and says so, rather than silently showing zero.
//
// ── Everything is at OUR SHARE, converted to USD ────────────────────────────
// The question is "how much of this class am I actually carrying", so:
//   fac exposure  = total_sum_insured × our_share_pct/100   (TSI is 100%)
//   fac premium   = ri_premium                              (ALREADY our share
//                   — the field is labelled "RI Premium (Our Share)" on the
//                   coverage-structure form, and the bound-premium KPI sums it
//                   raw; multiplying by the share again would understate it)
//   treaty        = the dashboard's own signed-share expressions, imported
//                   rather than restated so the portfolio and this modal can
//                   never drift apart.
// Mixed-currency books are normalised to USD through ref_exchange_rate, the
// same way the dashboard does it.
//
// ── NOTE on mv_fac_accumulation ─────────────────────────────────────────────
// The zone-based view in migration 137 multiplies sum insured by
// COALESCE(our_share_pct, ri_share_pct, 1) with no /100, while those columns
// hold 0–100 (a 15% line is stored as 15). That looks like a real bug — it
// would overstate committed exposure 15-fold — but it is a different feature
// with its own consumers, so it is flagged, not quietly changed here. This
// module divides by 100 deliberately.

import { pool } from '../db/pool.js';
import { fxSub, signedShare, isNp } from '../routes/dashboard.js';

// Live business only, matching the portfolio definition in routes/dashboard.js:
// DRAFT is not yet a position, DECLINED/NTU never went on risk.
const ACTIVE_TREATY = `c.uw_status NOT IN ('DRAFT','DECLINED','NTU')`;

// Only bound fac risks count as committed exposure — the same rule
// mv_fac_accumulation applies.
const BOUND_FAC = `r.status = 'BOUND'`;

/**
 * Resolve the class being priced: the risk's own fac class, and the treaty
 * class it maps to.
 * @returns {Promise<null|{facRiskId:string, facCobId:string|null, facClassName:string|null,
 *   category:string|null, classOfBusinessId:string|null, className:string|null}>}
 */
async function resolveClass(riskId) {
  const { rows } = await pool.query(
    `SELECT r.fac_risk_id, r.fac_cob_id,
            fcb.class_name AS fac_class_name, fcb.category,
            m.class_of_business_id,
            cob.class_of_business AS class_name
       FROM public.fac_risk r
       LEFT JOIN public.fac_class_of_business fcb ON fcb.fac_cob_id = r.fac_cob_id
       LEFT JOIN public.fac_to_treaty_cob_map m   ON m.fac_cob_id  = r.fac_cob_id
       LEFT JOIN public.class_of_business cob     ON cob.class_of_business_id = m.class_of_business_id
      WHERE r.fac_risk_id = $1`,
    [riskId],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    facRiskId: r.fac_risk_id,
    facCobId: r.fac_cob_id,
    facClassName: r.fac_class_name,
    category: r.category,
    classOfBusinessId: r.class_of_business_id,
    className: r.class_name,
  };
}

/** Bound fac risks whose class maps to the same treaty class, at our share, in USD. */
async function facLines(classOfBusinessId, excludeRiskId) {
  const { rows } = await pool.query(
    `SELECT r.fac_risk_id, r.fac_ref, r.insured_name, r.uw_year, r.status,
            co.company_name AS cedant_name,
            fcb.class_name  AS fac_class_name,
            cur.currency_code,
            COALESCE(r.total_sum_insured, 0)
              * COALESCE(r.our_share_pct, r.ri_share_pct, 100) / 100.0
              * COALESCE(fx.rate_to_usd, 1.0)                       AS exposure_usd,
            COALESCE(r.ri_premium, 0)
              * COALESCE(fx.rate_to_usd, 1.0)                       AS premium_usd
       FROM public.fac_risk r
       JOIN public.fac_to_treaty_cob_map m ON m.fac_cob_id = r.fac_cob_id
       LEFT JOIN public.fac_class_of_business fcb ON fcb.fac_cob_id = r.fac_cob_id
       LEFT JOIN public.companies co  ON co.company_id  = r.cedant_id
       LEFT JOIN public.currency cur  ON cur.currency_id = r.currency_id
       LEFT JOIN ${fxSub}             ON fx.currency_code = cur.currency_code
      WHERE m.class_of_business_id = $1
        AND ${BOUND_FAC}
        AND r.fac_risk_id <> $2
      ORDER BY exposure_usd DESC NULLS LAST, r.insured_name`,
    [classOfBusinessId, excludeRiskId],
  );
  return rows.map((x) => ({
    facRiskId: x.fac_risk_id,
    facRef: x.fac_ref,
    insuredName: x.insured_name,
    cedantName: x.cedant_name,
    facClassName: x.fac_class_name,
    uwYear: x.uw_year,
    currencyCode: x.currency_code,
    exposureUsd: Number(x.exposure_usd) || 0,
    premiumUsd: Number(x.premium_usd) || 0,
  }));
}

/**
 * Inforce treaties covering the class, at our signed share, in USD.
 *
 * Proportional exposure is the declared capacity and premium the QS + surplus
 * EPI; non-proportional exposure is the sum of layer limits and premium the sum
 * of layer (uw_price × limit). Both mirror routes/dashboard.js unitsBody.
 */
async function treatyLines(classOfBusinessId) {
  const { rows } = await pool.query(
    `SELECT c.contract_id, c.uw_year, c.uw_status,
            co.company_name AS cedant_name,
            COALESCE(tt.treaty_type, 'Unknown') AS treaty_type,
            ${isNp} AS is_np,
            cur.currency_code,
            CASE WHEN ${isNp}
              THEN COALESCE((SELECT SUM(COALESCE(l.layer_limit, 0))
                               FROM public.contract_np_layers l
                              WHERE l.contract_id = c.contract_id), 0)
              ELSE COALESCE(pd.total_capacity, 0)
            END * ${signedShare} * COALESCE(fx.rate_to_usd, 1.0)     AS exposure_usd,
            CASE WHEN ${isNp}
              THEN COALESCE((SELECT SUM(COALESCE(l.uw_price, 0) / 100.0 * COALESCE(l.layer_limit, 0))
                               FROM public.contract_np_layers l
                              WHERE l.contract_id = c.contract_id), 0)
              ELSE COALESCE(pd.quota_share_epi, 0) + COALESCE(pd.surplus_epi, 0)
            END * ${signedShare} * COALESCE(fx.rate_to_usd, 1.0)     AS premium_usd
       FROM public.contract c
       LEFT JOIN public.treaty_type tt           ON tt.treaty_type_id = c.treaty_type_id
       LEFT JOIN public.companies co             ON co.company_id     = c.cedant_id
       LEFT JOIN public.contract_prop_details pd ON pd.contract_id    = c.contract_id
       LEFT JOIN public.currency cur             ON cur.currency_id   = c.currency_id
       LEFT JOIN ${fxSub}                        ON fx.currency_code  = cur.currency_code
      WHERE ${ACTIVE_TREATY}
        AND EXISTS (
          SELECT 1 FROM public.contract_class_of_business ccob
           WHERE ccob.contract_id = c.contract_id
             AND ccob.class_of_business_id = $1
        )
      ORDER BY exposure_usd DESC NULLS LAST`,
    [classOfBusinessId],
  );
  return rows.map((x) => ({
    contractId: x.contract_id,
    cedantName: x.cedant_name,
    treatyType: x.treaty_type,
    isNp: x.is_np === true,
    uwYear: x.uw_year,
    uwStatus: x.uw_status,
    currencyCode: x.currency_code,
    exposureUsd: Number(x.exposure_usd) || 0,
    premiumUsd: Number(x.premium_usd) || 0,
  }));
}

/** The risk being priced, shown on its own line — never inside a subtotal. */
async function currentRiskLine(riskId) {
  const { rows } = await pool.query(
    `SELECT r.fac_risk_id, r.fac_ref, r.insured_name, r.status, r.uw_year,
            co.company_name AS cedant_name,
            fcb.class_name AS fac_class_name,
            cur.currency_code,
            COALESCE(r.total_sum_insured, 0)
              * COALESCE(r.our_share_pct, r.ri_share_pct, 100) / 100.0
              * COALESCE(fx.rate_to_usd, 1.0) AS exposure_usd,
            COALESCE(r.ri_premium, 0) * COALESCE(fx.rate_to_usd, 1.0) AS premium_usd
       FROM public.fac_risk r
       LEFT JOIN public.fac_class_of_business fcb ON fcb.fac_cob_id = r.fac_cob_id
       LEFT JOIN public.companies co  ON co.company_id  = r.cedant_id
       LEFT JOIN public.currency cur  ON cur.currency_id = r.currency_id
       LEFT JOIN ${fxSub}             ON fx.currency_code = cur.currency_code
      WHERE r.fac_risk_id = $1`,
    [riskId],
  );
  if (!rows.length) return null;
  const x = rows[0];
  return {
    facRiskId: x.fac_risk_id,
    facRef: x.fac_ref,
    insuredName: x.insured_name,
    cedantName: x.cedant_name,
    facClassName: x.fac_class_name,
    uwYear: x.uw_year,
    status: x.status,
    currencyCode: x.currency_code,
    exposureUsd: Number(x.exposure_usd) || 0,
    premiumUsd: Number(x.premium_usd) || 0,
  };
}

/** Sum a set of lines into an exposure/premium/count triple. */
export function subtotal(lines) {
  return (lines || []).reduce(
    (t, l) => ({
      exposureUsd: t.exposureUsd + (Number(l.exposureUsd) || 0),
      premiumUsd: t.premiumUsd + (Number(l.premiumUsd) || 0),
      count: t.count + 1,
    }),
    { exposureUsd: 0, premiumUsd: 0, count: 0 },
  );
}

/**
 * Everything the modal renders.
 *
 * @param {string} riskId
 * @returns {Promise<null|object>} null when the risk does not exist.
 */
export async function getClassAccumulation(riskId) {
  const cls = await resolveClass(riskId);
  if (!cls) return null;

  const currentRisk = await currentRiskLine(riskId);

  // No fac class picked yet, or a class with no treaty equivalent (CYBER).
  // Answer honestly with an empty accumulation and a reason the UI can show,
  // rather than a zero that reads as "nothing accumulated here".
  if (!cls.classOfBusinessId) {
    return {
      class: cls,
      unavailableReason: cls.facCobId
        ? `${cls.facClassName || 'This class'} is not mapped to a treaty class of business, so treaty exposure cannot be matched. Add a row to fac_to_treaty_cob_map to include it.`
        : 'No class of business is set on this risk yet.',
      facRisks: [], treaties: [],
      facSubtotal: subtotal([]), treatySubtotal: subtotal([]),
      total: subtotal([]),
      currentRisk,
    };
  }

  const [facRisks, treaties] = await Promise.all([
    facLines(cls.classOfBusinessId, riskId),
    treatyLines(cls.classOfBusinessId),
  ]);

  const facSubtotal = subtotal(facRisks);
  const treatySubtotal = subtotal(treaties);

  return {
    class: cls,
    unavailableReason: null,
    facRisks,
    treaties,
    facSubtotal,
    treatySubtotal,
    total: {
      exposureUsd: facSubtotal.exposureUsd + treatySubtotal.exposureUsd,
      premiumUsd: facSubtotal.premiumUsd + treatySubtotal.premiumUsd,
      count: facSubtotal.count + treatySubtotal.count,
    },
    currentRisk,
  };
}
