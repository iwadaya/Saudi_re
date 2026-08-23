// shared/fac/families/energyAsset.js
//
// The ENERGY_ASSET rating family — refineries, petrochemical plants, upstream
// onshore and offshore, power generation and renewables.
//
// Onshore energy is close to schedule property with one addition that changes
// everything about the rate: a PROCESS HAZARD BAND. Two refineries with the
// same values and the same construction are not the same risk if one runs a
// hydrocracker at 200 bar and the other is a lube blending plant. The band is
// the underwriting judgement the rate hangs on, so it is part of the base-rate
// key rather than a factor bolted on afterwards.
//
//   assetLossCost = assetValues × rate‰(asset type, hazard band, territory)
//                 + windstormSeasonLoad (named windstorm, where loaded)
//
//   + Σ sub-limits   Control of Well · OEE · seepage & pollution
//                    · removal of wreck · LOPI
//
// Sub-limits are SEPARATELY RATED SECTIONS, not percentage loadings. Control
// of Well on a deep-water well is not "the platform rate plus fifteen
// percent" — it is its own exposure, with its own limit, and it is frequently
// the larger number. The same discipline the marine families apply to war:
// each gets its own ADDITIVE candidate so it stays visible in the build-up.
//
// fac_energy_base_rate and fac_energy_sublimit_rate ship empty (migration 137).

import { num, numOrNull } from '../num.js';
import { pickByTerritory } from '../rateSelect.js';
import { metaFor } from './meta.js';

export const FAMILY_CODE = 'ENERGY_ASSET';

/** The sub-limits an energy slip carries, each rated on its own limit. */
export const SUBLIMIT_KINDS = [
  'CONTROL_OF_WELL', 'OEE', 'SEEPAGE_POLLUTION', 'REMOVAL_OF_WRECK', 'LOPI',
];

/** How each sub-limit reads to an underwriter. */
export const SUBLIMIT_LABEL = {
  CONTROL_OF_WELL:   'Control of Well',
  OEE:               'Operators’ Extra Expense',
  SEEPAGE_POLLUTION: 'Seepage & pollution',
  REMOVAL_OF_WRECK:  'Removal of wreck',
  LOPI:              'Loss of production income',
};

/**
 * @param {object|null} section
 * @returns {object}
 */
export function readExposure(section) {
  const detail = section?.exposure_detail || {};
  const sublimits = {};
  for (const kind of SUBLIMIT_KINDS) {
    const raw = detail.sublimits?.[kind] ?? detail.sublimits?.[kind.toLowerCase()];
    const value = numOrNull(typeof raw === 'object' && raw !== null ? raw.limit : raw);
    if (value !== null && value > 0) {
      sublimits[kind] = {
        limit: value,
        key: (typeof raw === 'object' && raw !== null ? raw.key : null) || 'DEFAULT',
      };
    }
  }

  return {
    assetValue: numOrNull(section?.sum_insured) ?? numOrNull(detail.asset_value),
    assetType: (detail.asset_type || '').toUpperCase() || null,
    hazardBand: (detail.process_hazard_band || 'STANDARD').toUpperCase(),
    // Whether the band was stated or defaulted, so the rate can say which.
    hazardBandStated: Boolean(detail.process_hazard_band),
    territory: (detail.territory || 'WORLDWIDE').toUpperCase(),
    namedWindstormExposed: Boolean(detail.named_windstorm_exposed),
    // LOPI rates on daily production value × the indemnity period, which is
    // a different quantity from the asset values entirely.
    dailyProductionValue: numOrNull(detail.daily_production_value),
    lopiIndemnityDays: numOrNull(detail.lopi_indemnity_days),
    sublimits,
  };
}

/**
 * @param {Array<object>} rates fac_energy_base_rate rows
 * @param {{assetType: string|null, hazardBand: string|null, territory: string|null}} args
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function selectEnergyRate(rates, { assetType, hazardBand, territory }) {
  // The hazard band is never relaxed. A rate for a STANDARD refinery applied
  // to a SEVERE one is the error this family exists to prevent, so a missing
  // band is a missing rate — not a reason to reach for the neighbouring one.
  const pool = (rates || []).filter(
    (r) => (r.asset_type || '').toUpperCase() === (assetType || '').toUpperCase()
      && (r.process_hazard_band || 'STANDARD').toUpperCase() === (hazardBand || 'STANDARD').toUpperCase(),
  );
  return pickByTerritory(pool, territory);
}

/**
 * The asset loss cost.
 *
 * @param {object} args
 * @param {ReturnType<readExposure>} args.exposure
 * @param {object} args.rates {energyBaseRates}
 * @returns {object}
 */
export function energyLossCost({ exposure, rates = {} }) {
  const value = num(exposure.assetValue);
  if (!(value > 0)) {
    return {
      available: false,
      unavailableReason: 'No asset values. Energy rates per mille of the asset values on the '
        + 'section.',
      diagnostics: {},
    };
  }
  if (!exposure.assetType) {
    return {
      available: false,
      unavailableReason: 'No asset type. The base rate is by asset type, process hazard band '
        + 'and territory.',
      diagnostics: { asset_value: value },
    };
  }

  const { rate, fellBackToWorldwide } = selectEnergyRate(rates.energyBaseRates, {
    assetType: exposure.assetType,
    hazardBand: exposure.hazardBand,
    territory: exposure.territory,
  });
  if (!rate) {
    return {
      available: false,
      unavailableReason: `No energy base rate is loaded for ${exposure.assetType} at hazard band `
        + `${exposure.hazardBand}. The hazard band is part of the rate key and is never relaxed `
        + '— a standard-band rate on a severe-band plant is the mistake this refuses to make.',
      diagnostics: {
        asset_value: value, asset_type: exposure.assetType, hazard_band: exposure.hazardBand,
      },
    };
  }

  const baseRatePm = num(rate.rate_pm);
  let ratePm = baseRatePm;

  // Named windstorm on a Gulf-of-Mexico-type asset is a seasonal exposure
  // priced as its own load where a carrier has a view on it.
  const windLoad = numOrNull(rate.windstorm_season_load_pm);
  let windPm = 0;
  if (exposure.namedWindstormExposed && windLoad !== null) {
    windPm = windLoad;
    ratePm += windLoad;
  }

  const lossCost = (value * ratePm) / 1000;

  const warnings = [];
  if (exposure.namedWindstormExposed && windLoad === null) {
    warnings.push('This asset is flagged as named-windstorm exposed but no windstorm season '
      + 'load is loaded for its rate, so the seasonal exposure is not in this price.');
  }
  if (fellBackToWorldwide && exposure.territory !== 'WORLDWIDE') {
    warnings.push(`No ${exposure.territory} rate loaded — using the worldwide rate.`);
  }
  if (!exposure.hazardBandStated) {
    warnings.push('No process hazard band stated, so this priced at the standard band. The '
      + 'band is the underwriting judgement an energy rate hangs on — set it explicitly.');
  }

  return {
    available: true,
    lossCost,
    ratePm,
    diagnostics: {
      asset_value: value,
      asset_type: exposure.assetType,
      hazard_band: exposure.hazardBand,
      territory: exposure.territory,
      territory_fallback: fellBackToWorldwide,
      base_rate_pm: baseRatePm,
      windstorm_load_pm: windPm,
      source: rate.source || null,
      warnings,
    },
  };
}

/**
 * One separately-rated sub-limit.
 *
 * @param {object} args
 * @param {string} args.kind
 * @param {number} args.limit
 * @param {string} args.key
 * @param {Array<object>} args.rates fac_energy_sublimit_rate rows
 * @returns {object}
 */
export function sublimitLossCost({ kind, limit, key = 'DEFAULT', rates }) {
  const amount = num(limit);
  if (!(amount > 0)) {
    return {
      available: false,
      unavailableReason: `No ${SUBLIMIT_LABEL[kind] || kind} limit stated.`,
      diagnostics: {},
    };
  }
  const row = (rates || []).find(
    (r) => (r.sublimit_kind || '').toUpperCase() === kind
      && String(r.sublimit_key || 'DEFAULT').toUpperCase() === String(key).toUpperCase(),
  ) || (rates || []).find(
    (r) => (r.sublimit_kind || '').toUpperCase() === kind
      && String(r.sublimit_key || 'DEFAULT').toUpperCase() === 'DEFAULT',
  );
  if (!row) {
    return {
      available: false,
      unavailableReason: `No rate is loaded for ${SUBLIMIT_LABEL[kind] || kind}. It is a `
        + 'separately-rated section with its own limit, not a percentage of the asset rate, so '
        + 'it needs its own rate before it can be priced.',
      diagnostics: { sublimit_kind: kind, limit: amount },
    };
  }
  const ratePm = num(row.rate_pm);
  return {
    available: true,
    lossCost: (amount * ratePm) / 1000,
    ratePm,
    diagnostics: {
      sublimit_kind: kind,
      sublimit_label: SUBLIMIT_LABEL[kind] || kind,
      limit: amount,
      rate_pm: ratePm,
      source: row.source || null,
    },
  };
}

/**
 * @returns {Array<{code: string, result: object}>}
 */
export function computeCandidates({ section, rates = {} }) {
  const exposure = readExposure(section);

  const candidates = [{
    code: 'ENERGY_RATE',
    result: energyLossCost({ exposure, rates }),
  }];

  // LOPI rates on daily production value over the indemnity period, which is
  // not the asset values — so it is stated as its own limit before rating.
  const lopiLimit = num(exposure.dailyProductionValue) * num(exposure.lopiIndemnityDays);
  const sublimits = { ...exposure.sublimits };
  if (lopiLimit > 0 && !sublimits.LOPI) sublimits.LOPI = { limit: lopiLimit, key: 'DEFAULT' };

  for (const kind of SUBLIMIT_KINDS) {
    const sub = sublimits[kind];
    if (!sub) continue;
    candidates.push({
      code: `SUBLIMIT_${kind}`,
      result: sublimitLossCost({
        kind, limit: sub.limit, key: sub.key, rates: rates.energySublimitRates,
      }),
    });
  }

  return candidates;
}

/** @type {import('../registry.js').FacFamily} */
export const energyAsset = {
  ...metaFor('ENERGY_ASSET'),
  readExposure,
  computeCandidates,
  premiumBase: ({ sections }) => (sections || []).reduce(
    (t, s) => t + (readExposure(s).assetValue ?? 0), 0,
  ),
};

export default energyAsset;
