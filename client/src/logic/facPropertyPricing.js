// client/src/logic/facPropertyPricing.js
//
// Pure-JS pricing engine for the facultative property workflow. Mirrors
// the math hard-coded in Saudi Re's Pricing_TOOL.xlsx (sheets Premium
// Calculator, Summary Sheet, Factors, Factors Weight, Capacity Sheet,
// BI Rates Template, Natural Perils Rate). No React, no network calls —
// the caller passes in reference data and inputs, the engine returns
// numbers.
//
// All rates are in per mille (‰ of sum insured).

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

function pct(v) {
  // Accepts 0.2 (decimal) or 20 (percent). Engine math expects decimals;
  // values > 1 are treated as percentages and divided by 100.
  const n = num(v);
  return Math.abs(n) > 1 ? n / 100 : n;
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
    pd_si_share_pct,
    indemnity_months,
    commission_pct,
    margin_pct,
    other_expenses_pct,
    extra_cover_loadings = [],
    bi_included = false,
  } = inputs || {};

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
  if (bi_included) {
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
    } else if (bi_included) {
      warnings.push('No BI_PLAN selection while BI is included; assuming 0 loading.');
    }
    bi_rate_pm = indemnityLoading * total_rate_pm * (1 + biPlanDl);
  }

  // 6. Net rate: PD-share weighted average of total and BI rates.
  const pdShare = pct(pd_si_share_pct);
  const safePdShare = Math.min(Math.max(pdShare, 0), 1);
  const net_rate_pm = bi_included
    ? safePdShare * total_rate_pm + (1 - safePdShare) * bi_rate_pm
    : total_rate_pm;

  // 7. Final net = net × (1 + Σ extra cover loadings).
  const extraSum = (extra_cover_loadings || []).reduce((acc, v) => acc + pct(v), 0);
  const final_net_rate_pm = net_rate_pm * (1 + extraSum);

  // 8. Final gross = final_net / (1 − commission − margin − other expenses).
  const comm = pct(commission_pct);
  const margin = pct(margin_pct);
  const other = pct(other_expenses_pct);
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
  // Bands are inclusive on min; "95-100" covers [95, 100], "Below 40"
  // has score_min=0. We pick the first band where score_min ≤ score ≤ score_max.
  const clamped = Math.max(0, Math.min(100, score));
  return (bands || []).find(
    (b) => clamped >= num(b.score_min) && clamped <= num(b.score_max)
  ) || null;
}

function findMarketVsTechBand(ratio) {
  return MARKET_VS_TECH_BANDS.find((b) => ratio >= b.min) || MARKET_VS_TECH_BANDS[MARKET_VS_TECH_BANDS.length - 1];
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
    bi_included = false,
    market_rate_pm,
    region,
    top_location_si_sar,
  } = inputs || {};

  const occupancy = (referenceData.occupancies || []).find(
    (o) => Number(o.occupancy_code) === Number(occupancy_code)
  );
  if (!occupancy) {
    throw new Error(`Unknown occupancy_code: ${occupancy_code}`);
  }

  const scheme = bi_included ? 'WITH_BI' : 'WITHOUT_BI';
  const weights = referenceData.factorWeights?.[scheme] || {};

  // Build score table keyed by factor_code, including the implicit
  // HAZARD_GRADE / FREQUENCY_GRADE inputs.
  const hgMap = new Map(
    (referenceData.hazardGradeScore || []).map((r) => [Number(r.hazard_grade), num(r.score)])
  );
  const fqMap = new Map(
    (referenceData.frequencyScore || []).map((r) => [Number(r.frequency_category), num(r.score)])
  );

  // Compute the market-vs-tech score band first so it folds into the
  // weighted sum like any other factor.
  const finalNetRate = num(ratePathResult?.final_net_rate_pm);
  let market_vs_tech_pct = null;
  let market_vs_tech_band = null;
  if (market_rate_pm > 0 && finalNetRate > 0) {
    market_vs_tech_pct = num(market_rate_pm) / finalNetRate;
    market_vs_tech_band = findMarketVsTechBand(market_vs_tech_pct).label;
  } else {
    // Excel default: when accepted rate is blank, the IF cascade drops
    // to "Less than 40%".
    market_vs_tech_band = MARKET_VS_TECH_BANDS[MARKET_VS_TECH_BANDS.length - 1].label;
  }

  // Score each factor.
  const factorScores = {};

  // HAZARD_GRADE and FREQUENCY_GRADE come from the occupancy + dedicated
  // lookup tables, not from factor_option.
  const hgScore = hgMap.get(Number(occupancy.hazard_grade));
  if (hgScore != null) factorScores.HAZARD_GRADE = hgScore;
  else warnings.push(`No hazard-grade score for grade ${occupancy.hazard_grade}.`);

  const fqScore = fqMap.get(Number(occupancy.frequency_category));
  if (fqScore != null) factorScores.FREQUENCY_GRADE = fqScore;
  else warnings.push(`No frequency score for category ${occupancy.frequency_category}.`);

  // Every other factor: look up the selected option's score.
  for (const factor of referenceData.factors || []) {
    const code = factor.factor_code;
    if (code === 'HAZARD_GRADE' || code === 'FREQUENCY_GRADE') continue;
    if (!factor.affects_score) continue;
    let label;
    if (code === 'MARKET_VS_TECH') {
      label = market_vs_tech_band;
    } else {
      label = factor_selections[code];
    }
    if (!label) {
      warnings.push(`No selection for scoring factor ${code}; treating as 0.`);
      factorScores[code] = 0;
      continue;
    }
    const opt = findOption(factor, label);
    if (!opt) {
      warnings.push(`Option "${label}" not found for factor ${code}; treating as 0.`);
      factorScores[code] = 0;
      continue;
    }
    factorScores[code] = num(opt.score);
  }

  // Weighted sum (Excel SUM(AG21:AG46) or SUM(AH21:AH46)).
  let weighted = 0;
  for (const [code, score] of Object.entries(factorScores)) {
    const w = num(weights[code]);
    weighted += score * w;
  }
  const underwriting_score = Math.max(0, Math.min(100, weighted));

  // Capacity band lookup.
  const band = findCapacityBand(referenceData.capacityBands, underwriting_score);
  const capacity_grade = band?.grade ?? null;
  const max_capacity_pct = band ? num(band.max_capacity_pct) : 0;
  const uw_action = classifyUwAction(band?.underwriting_action);

  // Max capacity in SAR: clamped by territorial budget and by top-location SI.
  let territorialCap = null;
  if (region) {
    const trow = (referenceData.territorialCapacity || []).find((t) => t.region === region);
    if (trow) territorialCap = num(trow.max_capacity);
    else warnings.push(`No territorial capacity for region "${region}"; using 0.`);
  }
  const topLocCap = top_location_si_sar != null
    ? num(top_location_si_sar) * max_capacity_pct
    : null;
  let max_capacity_sar = null;
  if (territorialCap != null && topLocCap != null) {
    max_capacity_sar = Math.min(territorialCap, topLocCap);
  } else if (territorialCap != null) {
    max_capacity_sar = territorialCap * max_capacity_pct;
  } else if (topLocCap != null) {
    max_capacity_sar = topLocCap;
  }

  return {
    underwriting_score,
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
// 3. Single entry point for the UI
// ────────────────────────────────────────────────────────────────────────────

export function computeFacQuote(inputs, referenceData) {
  const rate = computeRatePath(inputs, referenceData);
  const score = computeScoreAndDecision(inputs, referenceData, rate);
  return {
    ...rate,
    ...score,
    // Merge warnings from both paths so the UI sees a single list.
    warnings: [...(rate.warnings || []), ...(score.warnings || [])],
  };
}
