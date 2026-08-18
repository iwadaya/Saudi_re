// shared/fac/families/scheduleProperty.js
//
// The SCHEDULE_PROPERTY rating family — Property All Risks, Industrial All
// Risks, Assets All Risks, Buildings Combined, Business Interruption.
//
// Mirrors the math hard-coded in Saudi Re's Pricing_TOOL.xlsx (sheets
// Premium Calculator, Summary Sheet, Factors, Factors Weight, Capacity
// Sheet, BI Rates Template, Natural Perils Rate). No React, no network
// calls — the caller passes in reference data and inputs, the family
// returns numbers.
//
// All rates are in per mille (‰ of sum insured).
//
// ── Moved from client/src/logic/facPropertyPricing.js ──────────────────────
// It lives in shared/ now for the same reason shared/pricingMath.js does:
// the server has to be able to recompute what the browser sent. See
// POST /api/fac/risks/:id/price.
//
// ── Behaviour changes on the move (design doc §2, findings F5/F7/F8) ───────
// The rate path is arithmetically unchanged. Three things in the score and
// capacity path deliberately are not:
//
//   F5  A factor with no selection used to score 0. Because option scores
//       run from about −100 to +100, zero is mid-scale, not neutral — so a
//       half-filled form converged on a score near 0, which is grade K,
//       which reads as DECLINE. An incomplete submission was
//       indistinguishable from a bad risk. Unselected factors are now
//       UNSCORED: excluded from both sides of the weighted average, which
//       is renormalised over the weight actually selected. A risk that is
//       fully scored is unaffected (the weights sum to 1.0 either way).
//       Below `SCORE_COMPLETENESS_MIN` no grade is issued at all and
//       uw_action is INCOMPLETE.
//
//   F5b MARKET_VS_TECH used to fall through its band cascade to "Less than
//       40%" whenever no market rate had been entered — the worst band, a
//       −30 score against a 6% weight. Not having typed a number yet cost
//       roughly 1.8 points and could drop a borderline risk a grade. A
//       blank market rate is now simply unscored.
//
//   F7  max_capacity_sar had two branches that disagreed about whether the
//       territorial budget is scaled by the risk's grade: with a top
//       location it was not, without one it was. The territorial budget is
//       an absolute currency cap; the grade percentage applies to the
//       risk's own exposure. Both branches now say that.
//
// ── And one input-handling change ──────────────────────────────────────────
//   F8  The old pct() helper treated any |value| > 1 as a percentage and
//       divided by 100. A 150% loading entered as 1.5 became 1.5%; a 1%
//       loading entered as 1 became 100%. No input was unambiguous across
//       the range. Fractions are now taken at face value and an
//       out-of-range one is warned about, never silently transformed.

import { buildExposureProfile } from '../exposure.js';
import { exposureCurveLossCost } from '../methods/exposureCurve.js';
import { numOrNull } from '../num.js';

// ────────────────────────────────────────────────────────────────────────────
// Excel formula constants (Premium Calculator G24 / H24 / SUM(E16:E24))
//
// Tech rate uses every rate-affecting factor *except* BI_PLAN — BI_PLAN's
// discount/loading is folded into the BI rate via the C31 formula. Natcat
// loadings use a curated subset rather than the full rate D/L sum.
// ────────────────────────────────────────────────────────────────────────────
const TECH_RATE_FACTORS = [
  'CONSTRUCTION', 'AGE_OF_RISK', 'CLAIM_EXPERIENCE', 'FIRE_FIGHTING',
  'EXTERNAL_EXPOSURE', 'MANAGEMENT', 'SURVEY_RATING', 'DEDUCTIBLE_LEVEL',
  'TOP_OCCUPANCY_PCT',
];

const FLOOD_LOADING_FACTORS = [
  'CONSTRUCTION', 'AGE_OF_RISK', 'MANAGEMENT', 'SURVEY_RATING',
  'DEDUCTIBLE_LEVEL', 'TOP_OCCUPANCY_PCT',
];

const EQ_LOADING_FACTORS = [
  'CONSTRUCTION', 'AGE_OF_RISK', 'SURVEY_RATING', 'DEDUCTIBLE_LEVEL',
  'TOP_OCCUPANCY_PCT',
];

// Excel: if the rate D/L sum drops below -50% the rate is floored at 50%
// of the base instead of base*(1+sum). Same rule for flood and EQ.
const FLOOR_THRESHOLD = -0.5;
const FLOOR_MULTIPLIER = 0.5;

/**
 * Share of the scoring weight that has to be selected before a capacity
 * grade is issued. Below this the score is reported as provisional and
 * uw_action is INCOMPLETE — never a grade, and never DECLINE.
 */
export const SCORE_COMPLETENESS_MIN = 0.80;

export const FAMILY_CODE = 'SCHEDULE_PROPERTY';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function indexFactorsByCode(factors) {
  const map = new Map();
  for (const f of factors || []) map.set(f.factor_code, f);
  return map;
}

function findOption(factor, optionLabel) {
  if (!factor || !optionLabel) return null;
  const target = String(optionLabel).trim();
  return (factor.options || []).find(
    (o) => String(o.option_label).trim() === target
  ) || null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read a value that is stored as a fraction (0.20 = 20%).
 *
 * There is deliberately no percent-vs-decimal heuristic here (F8). A value
 * outside 0..1 is almost always a percentage typed into a fraction field,
 * so we say so — loudly, in the warnings the underwriter already reads —
 * but we do not rewrite the number. Silently dividing by 100 is how a
 * legitimate 150% loading became 1.5%.
 *
 * @param {unknown} v
 * @param {string} field  Field name for the warning message.
 * @param {string[]} warnings
 */
function fraction(v, field, warnings) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    warnings.push(`${field} is not a number ("${v}"); treated as 0.`);
    return 0;
  }
  if (Math.abs(n) > 1) {
    warnings.push(
      `${field} = ${n} reads as ${(n * 100).toFixed(2)}% — this field is a `
      + 'fraction (enter 0.15 for 15%). Value used as entered.',
    );
  }
  return n;
}

function sumDlForSubset(factorCodes, factorSelections, factorIndex, warnings) {
  let sum = 0;
  for (const code of factorCodes) {
    const factor = factorIndex.get(code);
    const label = factorSelections?.[code];
    if (!factor) continue;
    if (!label) {
      warnings.push(`No selection for rate-affecting factor ${code}; skipping its discount/loading.`);
      continue;
    }
    const opt = findOption(factor, label);
    if (!opt) {
      warnings.push(`Option "${label}" not found for factor ${code}; skipping.`);
      continue;
    }
    if (opt.discount_loading == null) continue;
    sum += num(opt.discount_loading);
  }
  return sum;
}

function normalizeBiIndemnity(biIndemnity) {
  // Engine accepts either the flat map { '12': 1.25 } or the API envelope
  // { loadings: { '12': 1.25 } }. Normalising here keeps the call sites
  // simple.
  if (biIndemnity && typeof biIndemnity === 'object' && biIndemnity.loadings) {
    return biIndemnity.loadings;
  }
  return biIndemnity || {};
}

function normalizeNatcatRates(natcatRates) {
  // Accept either an array (from the API) or a pre-built map keyed by zone.
  if (Array.isArray(natcatRates)) {
    const map = new Map();
    for (const r of natcatRates) map.set(r.country_zone, r);
    return map;
  }
  const map = new Map();
  for (const [k, v] of Object.entries(natcatRates || {})) map.set(k, v);
  return map;
}

/**
 * PD share and BI-inclusion come from the one exposure profile when the
 * caller supplies it, and from the legacy loose inputs otherwise. Keeping
 * the fallback means the score-only call sites (the UW factors panel) do
 * not have to build a profile they have no use for.
 */
function resolveExposure(inputs) {
  if (inputs?.exposure) {
    const e = inputs.exposure;
    return {
      pd_si_share: Math.min(Math.max(num(e.pd_si_share), 0), 1),
      bi_included: Boolean(e.bi_included),
      total_si: num(e.total_si),
      top_location_si: e.top_location_si == null ? null : num(e.top_location_si),
      basis: e.basis || 'NONE',
    };
  }
  const share = inputs?.pd_si_share_pct;
  return {
    pd_si_share: share == null ? 1 : Math.min(Math.max(num(share), 0), 1),
    bi_included: Boolean(inputs?.bi_included),
    total_si: num(inputs?.total_si),
    top_location_si: inputs?.top_location_si_sar == null
      ? null
      : num(inputs.top_location_si_sar),
    basis: 'NONE',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Rate path
// ────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} inputs
 * @param {object} referenceData { occupancies, factors, biIndemnity, natcatRates }
 * @returns {object} ratePathResult — all rates in per mille
 */
export function computeRatePath(inputs, referenceData) {
  const warnings = [];

  const {
    occupancy_code,
    country_zone,
    factor_selections = {},
    indemnity_months,
    commission_pct,
    margin_pct,
    other_expenses_pct,
    extra_cover_loadings = [],
  } = inputs || {};

  const exposure = resolveExposure(inputs);
  const biIncluded = exposure.bi_included;

  const occupancy = (referenceData.occupancies || []).find(
    (o) => Number(o.occupancy_code) === Number(occupancy_code)
  );
  if (!occupancy) {
    throw new Error(`Unknown occupancy_code: ${occupancy_code}`);
  }

  const natcatMap = normalizeNatcatRates(referenceData.natcatRates);
  const natcat = natcatMap.get(country_zone);
  if (!natcat) {
    throw new Error(`Unknown country_zone: ${country_zone}`);
  }

  const factorIndex = indexFactorsByCode(referenceData.factors);

  // 1. FLEXA base rate (Excel: VLOOKUP(occ_code, Occupancies!I))
  const flexa_base_rate_pm = num(occupancy.flexa_base_rate_pm);

  // 2. Tech rate (no natcat) = base × (1 + Σ rate D/L), excluding BI_PLAN.
  //    Floor at base × 0.5 when Σ D/L ≤ −50% (Excel C26).
  const techDlSum = sumDlForSubset(
    TECH_RATE_FACTORS, factor_selections, factorIndex, warnings
  );
  const technical_rate_no_natcat_pm = techDlSum <= FLOOR_THRESHOLD
    ? flexa_base_rate_pm * FLOOR_MULTIPLIER
    : flexa_base_rate_pm * (1 + techDlSum);

  // 3. Natcat rates: flood and EQ each load by a curated subset of factor
  //    D/Ls (Excel G24 / H24). Same −50% floor rule applies.
  const floodDlSum = sumDlForSubset(
    FLOOD_LOADING_FACTORS, factor_selections, factorIndex, warnings
  );
  const eqDlSum = sumDlForSubset(
    EQ_LOADING_FACTORS, factor_selections, factorIndex, warnings
  );
  const flood_storm_rate_loaded_pm = floodDlSum <= FLOOR_THRESHOLD
    ? num(natcat.flood_storm_rate) * FLOOR_MULTIPLIER
    : num(natcat.flood_storm_rate) * (1 + floodDlSum);
  const earthquake_rate_loaded_pm = eqDlSum <= FLOOR_THRESHOLD
    ? num(natcat.earthquake_rate) * FLOOR_MULTIPLIER
    : num(natcat.earthquake_rate) * (1 + eqDlSum);

  // 4. Total rate = tech (no natcat) + flood + EQ.
  const total_rate_pm
    = technical_rate_no_natcat_pm + flood_storm_rate_loaded_pm + earthquake_rate_loaded_pm;

  // 5. BI rate = indemnity loading × total rate × (1 + BI_PLAN D/L)
  //    Excel C31. BI_PLAN's D/L lives here, not in tech rate.
  let bi_rate_pm = 0;
  if (biIncluded) {
    const biLoadingsMap = normalizeBiIndemnity(referenceData.biIndemnity);
    const indemKey = String(indemnity_months ?? 12);
    const indemnityLoading = num(biLoadingsMap[indemKey]);
    if (!indemnityLoading) {
      warnings.push(`No BI indemnity loading for ${indemKey} months; using 0.`);
    }
    const biPlanFactor = factorIndex.get('BI_PLAN');
    const biPlanLabel = factor_selections.BI_PLAN;
    let biPlanDl = 0;
    if (biPlanFactor && biPlanLabel) {
      const opt = findOption(biPlanFactor, biPlanLabel);
      if (opt && opt.discount_loading != null) biPlanDl = num(opt.discount_loading);
    } else {
      warnings.push('No BI_PLAN selection while BI is included; assuming 0 loading.');
    }
    bi_rate_pm = indemnityLoading * total_rate_pm * (1 + biPlanDl);
  }

  // 6. Net rate: PD-share weighted average of total and BI rates. The share
  //    and the BI flag come from the same exposure profile, so a BI rate can
  //    no longer be computed and then weighted at zero (F10).
  const safePdShare = exposure.pd_si_share;
  const net_rate_pm = biIncluded
    ? safePdShare * total_rate_pm + (1 - safePdShare) * bi_rate_pm
    : total_rate_pm;

  // 7. Final net = net × (1 + Σ extra cover loadings).
  const extraSum = (extra_cover_loadings || []).reduce((acc, v, i) => {
    // Accept both the bare number and the { label, pct } row the UI stores.
    const value = (v && typeof v === 'object') ? v.pct : v;
    const label = (v && typeof v === 'object' && v.label) ? v.label : `extra cover loading #${i + 1}`;
    return acc + fraction(value, label, warnings);
  }, 0);
  const final_net_rate_pm = net_rate_pm * (1 + extraSum);

  // 8. Final gross = final_net / (1 − commission − margin − other expenses).
  const comm = fraction(commission_pct, 'Commission', warnings);
  const margin = fraction(margin_pct, 'Margin', warnings);
  const other = fraction(other_expenses_pct, 'Other expenses', warnings);
  const denom = 1 - comm - margin - other;
  let final_gross_rate_pm;
  if (denom <= 0) {
    warnings.push(`Commission + margin + other expenses ≥ 100% (denominator=${denom.toFixed(4)}); using final net as final gross.`);
    final_gross_rate_pm = final_net_rate_pm;
  } else {
    final_gross_rate_pm = final_net_rate_pm / denom;
  }

  return {
    flexa_base_rate_pm,
    technical_rate_no_natcat_pm,
    flood_storm_rate_loaded_pm,
    earthquake_rate_loaded_pm,
    total_rate_pm,
    bi_rate_pm,
    net_rate_pm,
    final_net_rate_pm,
    final_gross_rate_pm,
    extra_cover_loading_total: extraSum,
    warnings,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Score + decision path
// ────────────────────────────────────────────────────────────────────────────

const MARKET_VS_TECH_BANDS = [
  { min: 0.80, label: 'More than Equal to 80%' },
  { min: 0.70, label: 'Between 70% to 80%' },
  { min: 0.60, label: 'Between 60% to 70%' },
  { min: 0.50, label: 'Between 50% to 60%' },
  { min: 0.40, label: 'Between 40% to 50%' },
  { min: -Infinity, label: 'Less than 40%' },
];

function classifyUwAction(actionText) {
  if (!actionText) return 'REFER';
  const a = String(actionText).toUpperCase();
  if (a.includes('DECLINE')) return 'DECLINE';
  if (a.includes('EXCEPTIONAL')) return 'REFER';
  if (a.includes('CAUTION')) return 'ACCEPT_WITH_CAUTION';
  if (a.includes('ACCEPT')) return 'ACCEPT';
  return 'REFER';
}

function findCapacityBand(bands, score) {
  // Bands are inclusive on both ends, so adjacent bands share a boundary
  // (95 belongs to both "90-95" and "95-100"). Pick the highest matching
  // band rather than the first, so the answer does not depend on the order
  // the reference query happened to return.
  const clamped = Math.max(0, Math.min(100, score));
  let best = null;
  for (const b of bands || []) {
    if (clamped >= num(b.score_min) && clamped <= num(b.score_max)) {
      if (!best || num(b.score_min) > num(best.score_min)) best = b;
    }
  }
  return best;
}

function findMarketVsTechBand(ratio) {
  return MARKET_VS_TECH_BANDS.find((b) => ratio >= b.min)
    || MARKET_VS_TECH_BANDS[MARKET_VS_TECH_BANDS.length - 1];
}

/**
 * @param {object} inputs
 * @param {object} referenceData { occupancies, factors, factorWeights,
 *   hazardGradeScore, frequencyScore, capacityBands, territorialCapacity }
 * @param {object} ratePathResult — output of computeRatePath
 * @returns {object} scoreResult
 */
export function computeScoreAndDecision(inputs, referenceData, ratePathResult) {
  const warnings = [];

  const {
    occupancy_code,
    factor_selections = {},
    market_rate_pm,
    region,
  } = inputs || {};

  const exposure = resolveExposure(inputs);

  const occupancy = (referenceData.occupancies || []).find(
    (o) => Number(o.occupancy_code) === Number(occupancy_code)
  );
  if (!occupancy) {
    throw new Error(`Unknown occupancy_code: ${occupancy_code}`);
  }

  const scheme = exposure.bi_included ? 'WITH_BI' : 'WITHOUT_BI';
  const weights = referenceData.factorWeights?.[scheme] || {};

  const hgMap = new Map(
    (referenceData.hazardGradeScore || []).map((r) => [Number(r.hazard_grade), num(r.score)])
  );
  const fqMap = new Map(
    (referenceData.frequencyScore || []).map((r) => [Number(r.frequency_category), num(r.score)])
  );

  // Market-vs-technical band, scored like any other factor. A blank market
  // rate leaves it UNSCORED rather than dropping to the worst band (F5b).
  const finalNetRate = num(ratePathResult?.final_net_rate_pm);
  let market_vs_tech_pct = null;
  let market_vs_tech_band = null;
  if (num(market_rate_pm) > 0 && finalNetRate > 0) {
    market_vs_tech_pct = num(market_rate_pm) / finalNetRate;
    market_vs_tech_band = findMarketVsTechBand(market_vs_tech_pct).label;
  }

  const factorIndex = indexFactorsByCode(referenceData.factors);

  // ── Score each factor that carries weight ────────────────────────────
  // Three outcomes per factor, and they are deliberately distinct:
  //   scored    — a value was found; it contributes to the average
  //   unscored  — the factor applies but nothing has been selected; it
  //               contributes to neither side, and lowers completeness
  //   excluded  — the factor is not part of this reference set at all; it
  //               is not the underwriter's omission, so completeness is
  //               not penalised for it
  const factorScores = {};
  const unscoredFactors = [];
  let scoredWeight = 0;
  let applicableWeight = 0;
  let weighted = 0;

  for (const [code, rawWeight] of Object.entries(weights)) {
    const w = num(rawWeight);
    if (w === 0) continue;

    let value = null;

    if (code === 'HAZARD_GRADE') {
      const hg = hgMap.get(Number(occupancy.hazard_grade));
      if (hg == null) warnings.push(`No hazard-grade score for grade ${occupancy.hazard_grade}.`);
      else value = hg;
    } else if (code === 'FREQUENCY_GRADE') {
      const fq = fqMap.get(Number(occupancy.frequency_category));
      if (fq == null) warnings.push(`No frequency score for category ${occupancy.frequency_category}.`);
      else value = fq;
    } else if (code === 'MARKET_VS_TECH') {
      if (market_vs_tech_band) {
        const factor = factorIndex.get(code);
        const opt = findOption(factor, market_vs_tech_band);
        if (opt) value = num(opt.score);
        else warnings.push(`No option "${market_vs_tech_band}" for MARKET_VS_TECH; not scored.`);
      }
      // No market rate → unscored, not "Less than 40%".
    } else {
      const factor = factorIndex.get(code);
      if (!factor) {
        // Weighted but absent from the factor catalogue — a reference-data
        // gap, not a missing underwriter input. Excluded entirely.
        warnings.push(`Factor ${code} carries weight but is missing from the factor catalogue; excluded from the score.`);
        continue;
      }
      if (!factor.affects_score) continue;
      const label = factor_selections[code];
      if (label) {
        const opt = findOption(factor, label);
        if (opt) value = num(opt.score);
        else warnings.push(`Option "${label}" not found for factor ${code}; not scored.`);
      }
    }

    applicableWeight += w;
    if (value == null) {
      unscoredFactors.push(code);
    } else {
      factorScores[code] = value;
      scoredWeight += w;
      weighted += value * w;
    }
  }

  // Renormalise over the weight actually scored. When everything is
  // selected the weights sum to 1.0 and this is a no-op, so a completed
  // risk prices exactly as it did before.
  const score_completeness = applicableWeight > 0 ? scoredWeight / applicableWeight : 0;
  const rawScore = scoredWeight > 0 ? weighted / scoredWeight : 0;
  const underwriting_score = Math.max(0, Math.min(100, rawScore));

  const complete = score_completeness >= SCORE_COMPLETENESS_MIN;
  if (!complete) {
    warnings.push(
      `Underwriting score is provisional — ${(score_completeness * 100).toFixed(0)}% of the `
      + `scoring weight is selected (${(SCORE_COMPLETENESS_MIN * 100).toFixed(0)}% needed for a grade). `
      + `Unscored: ${unscoredFactors.join(', ') || 'none'}.`,
    );
  } else if (unscoredFactors.length > 0) {
    warnings.push(`Scored on ${(score_completeness * 100).toFixed(0)}% of the weight; unscored: ${unscoredFactors.join(', ')}.`);
  }

  const band = complete ? findCapacityBand(referenceData.capacityBands, underwriting_score) : null;
  const capacity_grade = band?.grade ?? null;
  const max_capacity_pct = band ? num(band.max_capacity_pct) : 0;
  // INCOMPLETE is its own verdict. It must never render as DECLINE — that
  // was the whole point of F5.
  const uw_action = complete ? classifyUwAction(band?.underwriting_action) : 'INCOMPLETE';

  // ── Capacity ─────────────────────────────────────────────────────────
  // The territorial budget is an absolute currency cap on the line. The
  // grade percentage applies to the risk's own top exposure. Whichever
  // binds first wins; when only one is known, that one is the answer.
  let territorialCap = null;
  if (region) {
    const trow = (referenceData.territorialCapacity || []).find((t) => t.region === region);
    if (trow) territorialCap = num(trow.max_capacity);
    else warnings.push(`No territorial capacity for region "${region}"; not applied.`);
  }
  const lineBasis = exposure.top_location_si;
  const gradeCap = lineBasis == null ? null : lineBasis * max_capacity_pct;

  let max_capacity_sar = null;
  if (complete) {
    if (territorialCap != null && gradeCap != null) max_capacity_sar = Math.min(territorialCap, gradeCap);
    else if (gradeCap != null) max_capacity_sar = gradeCap;
    else if (territorialCap != null) max_capacity_sar = territorialCap;
  }

  return {
    underwriting_score,
    score_completeness,
    unscored_factors: unscoredFactors,
    factor_scores: factorScores,
    factor_weights_scheme: scheme,
    capacity_grade,
    capacity_band: band
      ? {
        description: band.description,
        min_tech_rate_pm: num(band.min_tech_rate_pm),
        max_capacity_pct,
        underwriting_action: band.underwriting_action,
      }
      : null,
    uw_action,
    max_capacity_pct,
    max_capacity_sar,
    market_vs_tech_pct,
    market_vs_tech_band,
    warnings,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Premiums
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rates are per mille; premiums need a sum insured. That sum insured comes
 * from the exposure profile and nowhere else — the screen used to pick
 * between the location total and the risk header depending on whether any
 * location happened to exist, which silently moved the premium basis (F11).
 *
 * @param {object} ratePath  output of computeRatePath
 * @param {object} exposure  output of buildExposureProfile
 */
export function computePremiums(ratePath, exposure) {
  const si = num(exposure?.total_si);
  if (!(si > 0) || !ratePath) {
    return { technical: null, expected: null, exposure_basis: exposure?.basis || 'NONE', sum_insured: si };
  }
  const rate = (pm) => (pm == null ? null : (num(pm) * si) / 1000);
  return {
    technical: rate(ratePath.technical_rate_no_natcat_pm),
    expected: rate(ratePath.final_gross_rate_pm),
    exposure_basis: exposure?.basis || 'NONE',
    sum_insured: si,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Single entry point
// ────────────────────────────────────────────────────────────────────────────

export function computeFacQuote(inputs, referenceData) {
  const rate = computeRatePath(inputs, referenceData);
  const score = computeScoreAndDecision(inputs, referenceData, rate);
  const premiums = inputs?.exposure ? computePremiums(rate, inputs.exposure) : null;
  return {
    ...rate,
    ...score,
    premiums,
    exposure_basis: inputs?.exposure?.basis || null,
    // Merge warnings from every path so the UI sees a single list.
    warnings: [
      ...(inputs?.exposure?.warnings || []),
      ...(rate.warnings || []),
      ...(score.warnings || []),
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Family descriptor
// ────────────────────────────────────────────────────────────────────────────

/**
 * This family's loss-cost candidates.
 *
 * Property is the one family whose exposure view comes out of an engine
 * rather than a rate table: the workbook's own build-up, which the pipeline
 * takes as a NET rate and grosses up once. The exposure-curve candidate is
 * the same ground-up rate re-cut across the tower, so it only has anything
 * to say when a curve is banded for this risk's size.
 *
 * Every family exposes this shape, so `priceFacRiskFull` never asks which
 * family it is holding.
 *
 * @param {object} args
 * @param {object} args.engine        the computeQuote result
 * @param {object} args.exposure      buildExposureProfile output
 * @param {object} args.structure     {attachment, limit, isNonProportional}
 * @param {object} args.rates         {curveBands}
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ engine, exposure, structure = {}, rates = {} }) {
  const candidates = [{
    code: 'WORKBOOK_RATE',
    result: { available: true, ratePm: engine?.final_net_rate_pm ?? null },
  }];

  candidates.push({
    code: 'EXPOSURE_CURVE',
    result: exposureCurveLossCost({
      bands: buildCurveBands({ exposure, curveBands: rates.curveBands, engine }),
      attachment: structure.attachment ?? 0,
      limit: structure.limit ?? Infinity,
      exposureTotal: exposure?.total_si,
    }),
  });

  return candidates;
}

/**
 * Match each exposure band to the curve configured for its size, and give
 * it the ground-up burn rate the engine derived.
 *
 * Bands come from the location schedule when there is one — that is what
 * "band the schedule by size" means — and from the whole risk otherwise.
 */
function buildCurveBands({ exposure, curveBands, engine }) {
  if (!Array.isArray(curveBands) || curveBands.length === 0) return [];
  const pick = (amount) => curveBands.find(
    (b) => amount >= (numOrNull(b.min_exposure) ?? 0)
      && (b.max_exposure == null || amount < numOrNull(b.max_exposure)),
  );
  // The engine's technical rate is the ground-up burn rate for the risk;
  // exposure rating says how it splits across the tower, not how big it is.
  const groundUpRatePm = numOrNull(engine?.technical_rate_no_natcat_pm) ?? 0;
  const total = numOrNull(exposure?.total_si) ?? 0;
  if (!(total > 0)) return [];
  const band = pick(total);
  if (!band?.curve) return [];
  return [{
    exposure: total,
    pmlPct: numOrNull(exposure.pml_pct) ?? 1,
    groundUpRatePm,
    curve: band.curve,
  }];
}

/** @type {import('../registry.js').FacFamily} */
export const scheduleProperty = {
  code: FAMILY_CODE,
  label: 'Schedule Property',
  segment: 'NON_MARINE_PROPERTY',
  ratingBasis: 'SI_PER_MILLE',
  periodBasis: 'ANNUAL',
  // Only the workbook's own rate build-up is implemented today. The other
  // methods in the design are declared where they land so the pipeline can
  // report what a family is capable of before it is capable of it.
  methods: ['WORKBOOK_RATE', 'BURNING_COST', 'EXPOSURE_CURVE', 'BENCHMARK'],
  // Property attritional experience develops fast and is comparatively
  // stable, so it can carry most of the weight once there are enough
  // claims — half weight at 6, capped at 80%.
  credibility: { k: 6, maxZ: 0.80, unit: 'CLAIM_COUNT' },
  scoreCompletenessMin: SCORE_COMPLETENESS_MIN,
  requires: ['occupancy_code', 'risk_country_zone'],
  wizardSteps: ['FAC_LOCATIONS', 'FAC_COPE'],
  implemented: true,
  buildExposureProfile,
  computeRatePath,
  computeScoreAndDecision,
  computePremiums,
  computeQuote: computeFacQuote,
  computeCandidates,
};

export default scheduleProperty;
