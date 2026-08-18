// shared/fac/families/transitValues.js
//
// The TRANSIT_VALUES rating family — Cargo, Goods in Transit, Stock
// Throughput and standalone Project Cargo.
//
// Cargo does not rate off a sum insured. The sum insured on a cargo slip is
// the maximum any-one-conveyance limit, and rating against it is a category
// error: an account sending £200m of goods a year under a £5m any-one-vessel
// limit is not a £5m risk. The premium base is the annual turnover —
// "sendings" — split by what is being sent, how, and where:
//
//   blended‰ = Σ_s turnover_s × rate‰(commodity, conveyance, route)
//                            × packing × temperature
//              ÷ Σ_s turnover_s
//
//   lossCost = Σ_s turnover_s × its own loaded rate ‰ ÷ 1000
//              + storage load on static values
//
// The max any-one-conveyance limit is not a rating input at all — it is the
// accumulation control, and the family reports it so the capacity check can
// bite on it (design doc §4, `TRANSIT_VALUES`).
//
// War and strikes is a SEPARATE SECTION, never a percentage loading. Institute
// War Clauses cover is rated per region off `fac_war_rate`, whose rates move
// on a weekly cycle and by hundreds of percent when a corridor closes. Folding
// that into a hull or cargo rate hides the one number an underwriter needs to
// see move. `warSectionLossCost` below prices it on its own.
//
// Rates are loaded, never shipped — fac_transit_base_rate and fac_war_rate
// both ship empty (migration 136).

import { num, numOrNull } from '../num.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'TRANSIT_VALUES';

export const CONVEYANCES = ['SEA', 'AIR', 'ROAD', 'RAIL', 'MULTIMODAL'];

/**
 * Read the sendings schedule off a section.
 *
 * A section carries one or more segments, each a commodity × conveyance ×
 * route with its own turnover. A single-segment account is the ordinary case
 * and can be stated on the section columns alone.
 *
 * @param {object|null} section fac_risk_section row
 * @returns {{segments: Array<object>, totalTurnover: number, maxAnyOneConveyance: number|null,
 *            maxAnyOneLocation: number|null, storageValues: number|null, storageMonths: number|null,
 *            warRegion: string|null, warBasis: string, transitCount: number|null,
 *            warnings: string[]}}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  const warnings = [];

  const raw = Array.isArray(detail.segments) && detail.segments.length > 0
    ? detail.segments
    : [{
      commodity: detail.commodity || null,
      conveyance: detail.conveyance || null,
      route_region: detail.route_region || null,
      turnover: numOrNull(section?.exposure_base) ?? numOrNull(detail.turnover),
    }];

  const segments = raw.map((s, i) => {
    const turnover = numOrNull(s.turnover) ?? numOrNull(s.sendings);
    const conveyance = (s.conveyance || '').toUpperCase() || null;
    if (conveyance && !CONVEYANCES.includes(conveyance)) {
      warnings.push(`Segment ${i + 1}: "${conveyance}" is not a conveyance this family rates `
        + `(${CONVEYANCES.join(', ')}).`);
    }
    return {
      commodity: (s.commodity || '').toUpperCase() || null,
      conveyance,
      routeRegion: (s.route_region || s.routeRegion || 'WORLDWIDE').toUpperCase(),
      turnover,
      packingFactor: numOrNull(s.packing_factor ?? s.packingFactor),
      temperatureFactor: numOrNull(s.temperature_factor ?? s.temperatureFactor),
    };
  });

  const totalTurnover = segments.reduce((t, s) => t + num(s.turnover), 0);

  return {
    segments,
    totalTurnover,
    maxAnyOneConveyance: numOrNull(detail.max_any_one_conveyance) ?? numOrNull(section?.limit_amount),
    maxAnyOneLocation: numOrNull(detail.max_any_one_location),
    storageValues: numOrNull(detail.storage_values),
    storageMonths: numOrNull(detail.storage_months),
    storageRatePm: numOrNull(detail.storage_rate_pm),
    warRegion: (detail.war_region || '').toUpperCase() || null,
    warBasis: (detail.war_basis || 'ANNUAL').toUpperCase(),
    transitCount: numOrNull(detail.transit_count),
    warnings,
  };
}

/**
 * Pick the base rate for one segment.
 *
 * Commodity and conveyance are hard matches — a rate for machinery by sea says
 * nothing about frozen food by road. The route falls back to worldwide, which
 * is reported.
 *
 * @param {Array<object>} rates fac_transit_base_rate rows
 * @param {{commodity: string|null, conveyance: string|null, routeRegion: string|null}} segment
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function selectTransitRate(rates, segment) {
  const pool = (rates || []).filter(
    (r) => (r.commodity || '').toUpperCase() === (segment.commodity || '').toUpperCase()
      && (r.conveyance || '').toUpperCase() === (segment.conveyance || '').toUpperCase(),
  );
  const exact = pool.find(
    (r) => (r.route_region || '').toUpperCase() === (segment.routeRegion || '').toUpperCase(),
  );
  if (exact) return { rate: exact, fellBackToWorldwide: false };
  const worldwide = pool.find((r) => (r.route_region || '').toUpperCase() === 'WORLDWIDE');
  return { rate: worldwide || null, fellBackToWorldwide: Boolean(worldwide) };
}

/**
 * Pick a war rate for a region, newest effective row first.
 *
 * @param {Array<object>} warRates fac_war_rate rows
 * @param {{region: string|null, basis?: string}} args
 * @returns {object|null}
 */
export function selectWarRate(warRates, { region, basis = 'ANNUAL' }) {
  const pool = (warRates || [])
    .filter((r) => (r.region || '').toUpperCase() === (region || '').toUpperCase()
      && (r.basis || 'ANNUAL').toUpperCase() === (basis || 'ANNUAL').toUpperCase())
    .slice()
    .sort((a, b) => String(b.effective_from || '').localeCompare(String(a.effective_from || '')));
  return pool[0] || null;
}

/**
 * The war & strikes section, priced on its own.
 *
 * Annual basis rates the whole insured value once; per-transit basis rates it
 * per sailing, which is how a war slip on a small number of high-value moves
 * is actually written.
 *
 * @param {object} args
 * @param {number} args.insuredValue    values at risk per transit, or annual values
 * @param {object|null} args.warRate    fac_war_rate row
 * @param {number|null} [args.transits] required on a PER_TRANSIT basis
 * @param {boolean} [args.breachOfWarranty] listed-area breach AP applies
 * @returns {{available: boolean, unavailableReason?: string, lossCost?: number,
 *            ratePm?: number, diagnostics: object}}
 */
export function warSectionLossCost({ insuredValue, warRate, transits = null, breachOfWarranty = false }) {
  const value = num(insuredValue);
  if (!(value > 0)) {
    return {
      available: false,
      unavailableReason: 'No values at risk for the war section.',
      diagnostics: {},
    };
  }
  if (!warRate) {
    return {
      available: false,
      unavailableReason: 'No war rate is loaded for this region. War & strikes is rated from the '
        + 'war rate table, which moves weekly — it is never a percentage loading on the marine '
        + 'rate.',
      diagnostics: { insured_value: value },
    };
  }
  const basis = (warRate.basis || 'ANNUAL').toUpperCase();
  const perTransit = basis === 'PER_TRANSIT';
  const count = perTransit ? Math.max(num(transits), 0) : 1;
  if (perTransit && !(count > 0)) {
    return {
      available: false,
      unavailableReason: 'This war rate is quoted per transit — enter the number of transits.',
      diagnostics: { insured_value: value, basis },
    };
  }
  const ratePm = num(warRate.rate_pm) + (breachOfWarranty ? num(warRate.breach_ap_pm) : 0);
  const lossCost = (value * ratePm) / 1000 * count;
  return {
    available: true,
    lossCost,
    ratePm,
    diagnostics: {
      insured_value: value,
      basis,
      transits: count,
      base_rate_pm: num(warRate.rate_pm),
      breach_ap_pm: breachOfWarranty ? num(warRate.breach_ap_pm) : 0,
      region: warRate.region || null,
      effective_from: warRate.effective_from || null,
      source: warRate.source || null,
    },
  };
}

/**
 * The turnover-weighted cargo rate.
 *
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {Array<object>} args.transitRates
 * @returns {{available: boolean, unavailableReason?: string, lossCost?: number,
 *            ratePm?: number, diagnostics: object}}
 */
export function transitLossCost({ exposure, transitRates }) {
  const { segments, totalTurnover } = exposure;
  if (!(totalTurnover > 0)) {
    return {
      available: false,
      unavailableReason: 'No annual sendings. Cargo rates against turnover, not against the '
        + 'any-one-conveyance limit — enter the annual values carried.',
      diagnostics: {},
    };
  }

  const priced = [];
  const unpriced = [];
  let lossCost = 0;
  let fallbacks = 0;

  for (const segment of segments) {
    const turnover = num(segment.turnover);
    const { rate, fellBackToWorldwide } = selectTransitRate(transitRates, segment);
    if (!rate || !(turnover > 0)) {
      unpriced.push({
        commodity: segment.commodity,
        conveyance: segment.conveyance,
        route_region: segment.routeRegion,
        turnover,
        reason: rate ? 'No turnover stated' : 'No rate loaded',
      });
      continue;
    }
    if (fellBackToWorldwide) fallbacks += 1;
    // A packing or temperature factor stated on the segment overrides the
    // table's default; absent both, the factor is 1 — never invented.
    const packing = segment.packingFactor ?? numOrNull(rate.packing_factor) ?? 1;
    const temperature = segment.temperatureFactor ?? 1;
    const loadedPm = num(rate.rate_pm) * packing * temperature;
    const cost = (turnover * loadedPm) / 1000;
    lossCost += cost;
    priced.push({
      commodity: segment.commodity,
      conveyance: segment.conveyance,
      route_region: segment.routeRegion,
      turnover,
      base_rate_pm: num(rate.rate_pm),
      packing_factor: packing,
      temperature_factor: temperature,
      loaded_rate_pm: loadedPm,
      loss_cost: cost,
      route_fallback: fellBackToWorldwide,
    });
  }

  if (priced.length === 0) {
    return {
      available: false,
      unavailableReason: 'No cargo rate is loaded for any of this account\'s commodity / '
        + 'conveyance / route segments. Load the transit rate table before pricing.',
      diagnostics: { total_turnover: totalTurnover, unpriced },
    };
  }

  // Storage on static values is a distinct exposure with a distinct rate; it
  // is added, not blended into the transit rate, so the split stays visible.
  const storageValues = num(exposure.storageValues);
  const storageRatePm = numOrNull(exposure.storageRatePm);
  let storageLoss = 0;
  if (storageValues > 0 && storageRatePm !== null) {
    const months = exposure.storageMonths === null ? 12 : Math.max(num(exposure.storageMonths), 0);
    storageLoss = (storageValues * storageRatePm) / 1000 * (months / 12);
    lossCost += storageLoss;
  }

  const pricedTurnover = priced.reduce((t, s) => t + s.turnover, 0);

  const warnings = [...exposure.warnings];
  if (unpriced.length > 0) {
    const missing = unpriced.reduce((t, s) => t + num(s.turnover), 0);
    warnings.push(
      `${unpriced.length} of ${segments.length} segments could not be rated, covering `
      + `${((missing / totalTurnover) * 100).toFixed(1)}% of the turnover. The blended rate `
      + 'below is for the rated portion only.',
    );
  }
  if (fallbacks > 0) {
    warnings.push(`${fallbacks} segment(s) fell back to a worldwide route rate.`);
  }
  if (storageValues > 0 && storageRatePm === null) {
    warnings.push('Static storage values are stated but no storage rate is set — storage is '
      + 'not priced. Rate it, or move it to a property section.');
  }

  return {
    available: true,
    lossCost,
    // The rate that means something on cargo is per mille of turnover.
    ratePm: (lossCost / totalTurnover) * 1000,
    diagnostics: {
      total_turnover: totalTurnover,
      rated_turnover: pricedTurnover,
      rated_share: pricedTurnover / totalTurnover,
      blended_transit_rate_pm: pricedTurnover > 0
        ? (priced.reduce((t, s) => t + s.loss_cost, 0) / pricedTurnover) * 1000
        : null,
      storage_loss_cost: storageLoss,
      max_any_one_conveyance: exposure.maxAnyOneConveyance,
      max_any_one_location: exposure.maxAnyOneLocation,
      segments: priced,
      unpriced,
      warnings,
    },
  };
}

/**
 * @param {object} args
 * @param {object} args.risk
 * @param {object|null} args.section
 * @param {object} args.rates {transitRates, warRates}
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ section, rates = {} }) {
  const exposure = readExposure(section);
  const candidates = [{
    code: 'TRANSIT_RATE',
    result: transitLossCost({ exposure, transitRates: rates.transitRates }),
  }];

  // War is its own section and its own candidate. It is never blended with
  // the marine rate and never weighted against it.
  if (exposure.warRegion) {
    candidates.push({
      code: 'WAR_SECTION',
      result: warSectionLossCost({
        insuredValue: exposure.warBasis === 'PER_TRANSIT'
          ? num(exposure.maxAnyOneConveyance)
          : exposure.totalTurnover,
        warRate: selectWarRate(rates.warRates, {
          region: exposure.warRegion, basis: exposure.warBasis,
        }),
        transits: exposure.transitCount,
        breachOfWarranty: Boolean(section?.exposure_detail?.breach_of_warranty),
      }),
    });
  }

  return candidates;
}

/** @type {import('../registry.js').FacFamily} */
export const transitValues = {
  ...metaFor('TRANSIT_VALUES'),
  readExposure,
  computeCandidates,
  // Annual sendings, not the any-one-conveyance limit.
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + readExposure(s).totalTurnover, 0,
  ),
};

export default transitValues;
