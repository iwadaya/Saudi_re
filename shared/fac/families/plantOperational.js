// shared/fac/families/plantOperational.js
//
// The PLANT_OPERATIONAL rating family — Machinery Breakdown, Electronic
// Equipment Insurance, Contractors' Plant & Machinery, Boiler Explosion.
//
// The thing that makes this family its own rather than a variant of schedule
// property is where the PML sits. A property schedule's PML is a site
// question: what fraction of this location burns in one fire. A machinery
// breakdown PML is an ITEM question: this turbine fails, that transformer
// does not, and the fire that would have linked them is not the peril. Rating
// a plant schedule at the site level either prices the whole site as one item
// or applies a site PML to a peril that has none.
//
//   lossCost = Σ_items  replacementValue_i × rate‰(machine type)
//                       × ageFactor × usageFactor × maintenanceFactor
//                       ÷ 1000
//   + deteriorationOfStock(stock value, indemnity months)
//
// The factors are multiplicative, unlike the construction family's additive
// loadings: a twenty-year-old machine running three shifts with deferred
// maintenance is not "base plus three loadings", it is a different risk.
//
// fac_plant_base_rate and fac_plant_factor ship empty (migration 137).

import { num, numOrNull } from '../num.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'PLANT_OPERATIONAL';

export const FACTOR_KINDS = ['AGE', 'USAGE', 'MAINTENANCE', 'ENVIRONMENT'];

/**
 * Read the item schedule off a section.
 *
 * A one-item risk can be stated on the section columns; a schedule goes in
 * `exposure_detail.items`.
 *
 * @param {object|null} section
 * @returns {object}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  const raw = Array.isArray(detail.items) && detail.items.length > 0
    ? detail.items
    : [{
      machine_type: detail.machine_type || null,
      replacement_value: numOrNull(section?.sum_insured) ?? numOrNull(detail.replacement_value),
      age_band: detail.age_band || null,
      usage: detail.usage || null,
      maintenance: detail.maintenance || null,
      environment: detail.environment || null,
      pml_pct: numOrNull(detail.pml_pct),
    }];

  const items = raw.map((item) => ({
    machineType: (item.machine_type || item.machineType || '').toUpperCase() || null,
    replacementValue: numOrNull(item.replacement_value ?? item.replacementValue),
    ageBand: (item.age_band || item.ageBand || '').toUpperCase() || null,
    usage: (item.usage || '').toUpperCase() || null,
    maintenance: (item.maintenance || '').toUpperCase() || null,
    environment: (item.environment || '').toUpperCase() || null,
    // Item-level PML, which is the whole reason this family exists. Absent,
    // the item is rated at full value — the conservative reading.
    pmlPct: numOrNull(item.pml_pct ?? item.pmlPct),
    description: item.description || null,
  }));

  return {
    items,
    totalValue: items.reduce((t, i) => t + num(i.replacementValue), 0),
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    stockValue: numOrNull(detail.stock_value),
    stockIndemnityMonths: numOrNull(detail.stock_indemnity_months),
    stockRatePm: numOrNull(detail.stock_rate_pm),
  };
}

/**
 * @param {Array<object>} rates fac_plant_base_rate rows
 * @param {{machineType: string|null, territory: string|null}} args
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function selectPlantRate(rates, { machineType, territory }) {
  const pool = (rates || []).filter(
    (r) => (r.machine_type || '').toUpperCase() === (machineType || '').toUpperCase(),
  );
  const exact = pool.find(
    (r) => (r.territory || '').toUpperCase() === (territory || '').toUpperCase(),
  );
  if (exact) return { rate: exact, fellBackToWorldwide: false };
  const worldwide = pool.find((r) => (r.territory || '').toUpperCase() === 'WORLDWIDE');
  return { rate: worldwide || null, fellBackToWorldwide: Boolean(worldwide) };
}

/**
 * @param {Array<object>} factors fac_plant_factor rows
 * @param {object} keys
 * @returns {{factor: number, applied: object, missing: string[]}}
 */
export function resolvePlantFactors(factors, keys) {
  const rows = factors || [];
  const applied = {};
  const missing = [];
  let product = 1;

  for (const kind of FACTOR_KINDS) {
    const key = keys[kind];
    if (key === null || key === undefined || key === '') continue;
    const row = rows.find(
      (f) => (f.factor_kind || '').toUpperCase() === kind
        && String(f.factor_key).toUpperCase() === String(key).toUpperCase(),
    );
    if (!row) { missing.push(`${kind}=${key}`); continue; }
    const f = num(row.factor);
    applied[kind] = { key: String(key), factor: f, source: row.source || null };
    product *= f;
  }
  return { factor: product, applied, missing };
}

/**
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {object} args.rates {plantBaseRates, plantFactors}
 * @returns {object}
 */
export function plantLossCost({ exposure, rates = {} }) {
  if (!(exposure.totalValue > 0)) {
    return {
      available: false,
      unavailableReason: 'No replacement values. Plant rates per mille of each item\'s '
        + 'replacement value — enter the item schedule before pricing.',
      diagnostics: {},
    };
  }

  const priced = [];
  const unpriced = [];
  const missingFactors = new Set();
  let lossCost = 0;
  let fallbacks = 0;

  for (const item of exposure.items) {
    const value = num(item.replacementValue);
    const { rate, fellBackToWorldwide } = selectPlantRate(rates.plantBaseRates, {
      machineType: item.machineType, territory: exposure.territory,
    });
    if (!rate || !(value > 0)) {
      unpriced.push({
        machine_type: item.machineType,
        replacement_value: value,
        reason: rate ? 'No replacement value stated' : 'No rate loaded for this machine type',
      });
      continue;
    }
    if (fellBackToWorldwide) fallbacks += 1;

    const factors = resolvePlantFactors(rates.plantFactors, {
      AGE: item.ageBand,
      USAGE: item.usage,
      MAINTENANCE: item.maintenance,
      ENVIRONMENT: item.environment,
    });
    factors.missing.forEach((m) => missingFactors.add(m));

    const ratePm = num(rate.rate_pm) * factors.factor;
    // The PML is the item's, not the site's. Absent, the item is exposed in
    // full — an unstated PML is a total loss until somebody says otherwise.
    const exposed = value * (item.pmlPct ?? 1);
    const cost = (exposed * ratePm) / 1000;
    lossCost += cost;
    priced.push({
      machine_type: item.machineType,
      description: item.description,
      replacement_value: value,
      pml_pct: item.pmlPct,
      exposed_value: exposed,
      base_rate_pm: num(rate.rate_pm),
      factor_product: factors.factor,
      factors_applied: factors.applied,
      item_rate_pm: ratePm,
      loss_cost: cost,
      territory_fallback: fellBackToWorldwide,
    });
  }

  if (priced.length === 0) {
    return {
      available: false,
      unavailableReason: 'No plant base rate is loaded for any machine type on this schedule. '
        + 'Load the plant rate table before pricing.',
      diagnostics: { total_value: exposure.totalValue, unpriced },
    };
  }

  // Deterioration of stock — refrigerated or process stock spoiled by the
  // breakdown — is a distinct exposure on a distinct value, so it is added
  // and kept visible rather than folded into the machinery rate.
  let stockLoss = 0;
  const stockValue = num(exposure.stockValue);
  if (stockValue > 0 && exposure.stockRatePm !== null) {
    const months = exposure.stockIndemnityMonths === null
      ? 12 : Math.max(num(exposure.stockIndemnityMonths), 0);
    stockLoss = (stockValue * exposure.stockRatePm) / 1000 * (months / 12);
    lossCost += stockLoss;
  }

  const pricedValue = priced.reduce((t, i) => t + i.replacement_value, 0);
  const warnings = [];
  if (unpriced.length > 0) {
    warnings.push(
      `${unpriced.length} of ${exposure.items.length} items could not be rated, covering `
      + `${(((exposure.totalValue - pricedValue) / exposure.totalValue) * 100).toFixed(1)}% of `
      + 'the schedule value. The rate below is for the rated items only.',
    );
  }
  if (missingFactors.size > 0) {
    warnings.push(`No factor loaded for ${[...missingFactors].join(', ')} — treated as 1.00.`);
  }
  if (fallbacks > 0) warnings.push(`${fallbacks} item(s) fell back to a worldwide rate.`);
  if (stockValue > 0 && exposure.stockRatePm === null) {
    warnings.push('Stock values are stated but no deterioration rate is set — stock is not '
      + 'priced.');
  }
  if (priced.every((i) => i.pml_pct === null)) {
    warnings.push('No item PMLs stated, so every item is rated at full value. Item-level PML is '
      + 'the point of this family — a plant PML is not a site PML.');
  }

  return {
    available: true,
    lossCost,
    ratePm: (lossCost / exposure.totalValue) * 1000,
    diagnostics: {
      total_value: exposure.totalValue,
      rated_value: pricedValue,
      rated_share: pricedValue / exposure.totalValue,
      item_count: exposure.items.length,
      items: priced,
      unpriced,
      stock_loss_cost: stockLoss,
      warnings,
    },
  };
}

/**
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ section, rates = {} }) {
  return [{
    code: 'PLANT_RATE',
    result: plantLossCost({ exposure: readExposure(section), rates }),
  }];
}

/** @type {import('../registry.js').FacFamily} */
export const plantOperational = {
  ...metaFor('PLANT_OPERATIONAL'),
  readExposure,
  computeCandidates,
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + readExposure(s).totalValue, 0,
  ),
};

export default plantOperational;
