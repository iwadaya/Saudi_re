// shared/fac/registry.js
//
// The facultative rating-family registry.
//
// A "family" is the technical grouping that decides what maths applies to a
// risk. It is not the same thing as the segment a class is reported under:
// Casualty and Financial Lines both rate to a limit via ILFs (one family,
// two segments), while Marine splits into hull agreed values, transit
// turnover and liability limits (one segment, three families). The
// class → family mapping is data, held on fac_class_of_business
// (migration 134); the family definitions are here.
//
// Only SCHEDULE_PROPERTY has an engine today — it is the workbook the whole
// module was built around. The other nine are declared rather than
// implemented, and that is deliberate: before this registry existed, a
// Marine or Casualty risk reached the property engine, which threw
// `Unknown occupancy_code`, and the screen rendered the exception as a red
// line (finding F1). Declaring every family lets the pipeline answer
// honestly — "Hull & Machinery rates on agreed value; that engine is not
// built yet" — instead of showing an underwriter a crash and a blank rate.
//
// Adding a class is a row in fac_class_of_business pointing at a family.
// Adding a family is one module plus its entry here; no screen, route,
// audit or referral code changes.

import { scheduleProperty } from './families/scheduleProperty.js';

/**
 * @typedef {Object} FacFamily
 * @property {string} code
 * @property {string} label
 * @property {string} segment
 * @property {'SI_PER_MILLE'|'CONTRACT_VALUE'|'AGREED_VALUE'|'TURNOVER'|'LIMIT_ILF'|'PER_UNIT'} ratingBasis
 * @property {'ANNUAL'|'PROJECT'|'VOYAGE'} periodBasis
 * @property {string[]} methods              Loss-cost methods this family supports.
 * @property {string[]} [requires]           Risk fields the engine cannot run without.
 * @property {string[]} [wizardSteps]        Extra wizard steps this family needs.
 * @property {boolean} implemented           Whether an engine exists yet.
 * @property {{k: number, maxZ: number, unit: string}} [credibility]
 *   Buhlmann-Straub parameters. k is the claim count at which the risk's own
 *   experience earns half the weight; maxZ caps it however much experience
 *   there is, because thin-layer experience is never fully credible.
 * @property {string} [plannedPhase]         Where an unimplemented family lands.
 * @property {number} [scoreCompletenessMin]
 * @property {Function} [buildExposureProfile]
 * @property {Function} [computeQuote]
 */

/** How each rating basis is described to an underwriter. */
export const RATING_BASIS_LABEL = {
  SI_PER_MILLE:   'Rate per mille of sum insured',
  CONTRACT_VALUE: 'Rate per mille of contract value, over the project period',
  AGREED_VALUE:   'Rate per mille of agreed value',
  TURNOVER:       'Rate per mille of annual turnover / sendings',
  LIMIT_ILF:      'Loss cost to a limit, via increased limit factors',
  PER_UNIT:       'Rate per exposure unit (vehicle-year, benefit unit)',
};

export const SEGMENT_LABEL = {
  NON_MARINE_PROPERTY:      'Non-Marine Property',
  ENGINEERING_CONSTRUCTION: 'Engineering & Construction',
  MARINE_TRANSIT:           'Marine & Transit',
  ENERGY_POWER:             'Energy & Power',
  CASUALTY_LIABILITY:       'Casualty & Liability',
  MOTOR:                    'Motor',
  FINANCIAL_SPECIALTY:      'Financial & Specialty',
  ACCIDENT_HEALTH:          'Accident & Health',
};

/**
 * Families with no engine yet. `notes` is shown to the underwriter in place
 * of a rate, so it says what the family needs rather than that something
 * went wrong.
 */
const DECLARED = [
  {
    code: 'PROJECT_WORKS',
    credibility: { k: 12, maxZ: 0.50, unit: 'CLAIM_COUNT' },
    label: 'Project Works (CAR / EAR)',
    segment: 'ENGINEERING_CONSTRUCTION',
    ratingBasis: 'CONTRACT_VALUE',
    periodBasis: 'PROJECT',
    methods: ['EXPOSURE_CURVE', 'BENCHMARK'],
    wizardSteps: ['FAC_LOCATIONS', 'FAC_COPE'],
    plannedPhase: 'Phase 4',
    notes: 'Rates on total contract value for the whole project period, with '
      + 'testing, maintenance and DSU loadings — not an annual rate on sum insured.',
  },
  {
    code: 'PLANT_OPERATIONAL',
    credibility: { k: 6,  maxZ: 0.80, unit: 'CLAIM_COUNT' },
    label: 'Plant & Machinery (Operational)',
    segment: 'ENGINEERING_CONSTRUCTION',
    ratingBasis: 'SI_PER_MILLE',
    periodBasis: 'ANNUAL',
    methods: ['EXPOSURE_CURVE', 'BURNING_COST', 'BENCHMARK'],
    wizardSteps: ['FAC_LOCATIONS'],
    plannedPhase: 'Phase 4',
    notes: 'Rates per item class on replacement value; PML is item-level, not site-level.',
  },
  {
    code: 'HULL_VALUE',
    credibility: { k: 6,  maxZ: 0.80, unit: 'CLAIM_COUNT' },
    label: 'Marine Hull',
    segment: 'MARINE_TRANSIT',
    ratingBasis: 'AGREED_VALUE',
    periodBasis: 'ANNUAL',
    methods: ['BURNING_COST', 'BENCHMARK'],
    wizardSteps: [],
    plannedPhase: 'Phase 3',
    notes: 'Rates on agreed value by vessel type, tonnage, age, class and trading '
      + 'area, with laid-up returns. War & strikes is a separate section, never a loading.',
  },
  {
    code: 'TRANSIT_VALUES',
    credibility: { k: 5,  maxZ: 0.80, unit: 'CLAIM_COUNT' },
    label: 'Cargo & Transit',
    segment: 'MARINE_TRANSIT',
    ratingBasis: 'TURNOVER',
    periodBasis: 'ANNUAL',
    methods: ['BURNING_COST', 'FREQ_SEVERITY', 'BENCHMARK'],
    wizardSteps: [],
    plannedPhase: 'Phase 3',
    notes: 'Rates on annual turnover or sendings, capped by the maximum any-one-'
      + 'conveyance limit — which is the real exposure control, not the annual rate.',
  },
  {
    code: 'MARINE_LIABILITY',
    credibility: { k: 10, maxZ: 0.60, unit: 'CLAIM_COUNT' },
    label: 'Marine Liability',
    segment: 'MARINE_TRANSIT',
    ratingBasis: 'LIMIT_ILF',
    periodBasis: 'ANNUAL',
    methods: ['ILF_CURVE', 'BURNING_COST'],
    wizardSteps: [],
    plannedPhase: 'Phase 3',
    notes: 'Liability-limit mechanics with a marine ILF curve.',
  },
  {
    code: 'ENERGY_ASSET',
    credibility: { k: 10, maxZ: 0.60, unit: 'CLAIM_COUNT' },
    label: 'Energy & Power Assets',
    segment: 'ENERGY_POWER',
    ratingBasis: 'SI_PER_MILLE',
    periodBasis: 'ANNUAL',
    methods: ['EXPOSURE_CURVE', 'BURNING_COST', 'CAT_MODEL'],
    wizardSteps: ['FAC_LOCATIONS', 'FAC_COPE'],
    plannedPhase: 'Phase 4',
    notes: 'Property mechanics plus a process-hazard grade, with Control of Well, '
      + 'OEE and pollution written as separately-rated sub-limits.',
  },
  {
    code: 'LIABILITY_LIMIT',
    credibility: { k: 12, maxZ: 0.60, unit: 'CLAIM_COUNT' },
    label: 'Casualty & Liability',
    segment: 'CASUALTY_LIABILITY',
    ratingBasis: 'LIMIT_ILF',
    periodBasis: 'ANNUAL',
    methods: ['ILF_CURVE', 'BURNING_COST', 'FREQ_SEVERITY', 'BENCHMARK'],
    wizardSteps: [],
    plannedPhase: 'Phase 3',
    notes: 'There is no sum insured. Rates a basic-limit loss cost off turnover, '
      + 'payroll or fee income and steps it to the policy limit with an ILF curve.',
  },
  {
    code: 'MOTOR_FLEET',
    credibility: { k: 4,  maxZ: 0.90, unit: 'CLAIM_COUNT' },
    label: 'Motor Fleet',
    segment: 'MOTOR',
    ratingBasis: 'PER_UNIT',
    periodBasis: 'ANNUAL',
    methods: ['BURNING_COST', 'FREQ_SEVERITY'],
    wizardSteps: [],
    plannedPhase: 'Phase 4',
    notes: 'Rates per vehicle-year by category, with credible fleet experience.',
  },
  {
    code: 'CYBER_LIMIT',
    credibility: { k: 12, maxZ: 0.50, unit: 'CLAIM_COUNT' },
    label: 'Cyber',
    segment: 'FINANCIAL_SPECIALTY',
    ratingBasis: 'LIMIT_ILF',
    periodBasis: 'ANNUAL',
    methods: ['FREQ_SEVERITY', 'ILF_CURVE', 'BENCHMARK'],
    wizardSteps: [],
    plannedPhase: 'Phase 4',
    notes: 'Rates per unit of limit against revenue and control posture. Requires '
      + 'a common-vendor accumulation check before bind.',
  },
  {
    code: 'PA_BENEFIT',
    credibility: { k: 5,  maxZ: 0.85, unit: 'CLAIM_COUNT' },
    label: 'Personal Accident',
    segment: 'ACCIDENT_HEALTH',
    ratingBasis: 'PER_UNIT',
    periodBasis: 'ANNUAL',
    methods: ['BURNING_COST', 'BENCHMARK'],
    wizardSteps: [],
    plannedPhase: 'Phase 4',
    notes: 'Rates per benefit unit by occupational class, with a one-event '
      + 'accumulation limit.',
  },
].map((f) => ({ ...f, implemented: false }));

/** @type {Map<string, FacFamily>} */
const REGISTRY = new Map();
for (const family of [scheduleProperty, ...DECLARED]) {
  REGISTRY.set(family.code, family);
}

/** The family every unmapped class falls back to — which is what the single
 *  engine already did to every class before the taxonomy existed. */
export const DEFAULT_FAMILY_CODE = 'SCHEDULE_PROPERTY';

/**
 * @param {string|null|undefined} code
 * @returns {FacFamily|null}
 */
export function getFamily(code) {
  if (!code) return null;
  return REGISTRY.get(String(code).trim().toUpperCase()) || null;
}

/** @returns {FacFamily[]} every family, implemented first. */
export function listFamilies() {
  return [...REGISTRY.values()].sort((a, b) => {
    if (a.implemented !== b.implemented) return a.implemented ? -1 : 1;
    return a.code.localeCompare(b.code);
  });
}

/**
 * Resolve the family for a class-of-business row. Falls back to the default
 * family so an unmapped class behaves exactly as it did before the taxonomy
 * landed, rather than becoming unpriceable.
 *
 * @param {{rating_family?: string}|null} cob
 * @returns {FacFamily}
 */
export function familyForClass(cob) {
  return getFamily(cob?.rating_family) || getFamily(DEFAULT_FAMILY_CODE);
}

/**
 * The distinct families across a set of class rows — a risk with a
 * PROJECT_WORKS section and a LIABILITY_LIMIT section has two.
 *
 * @param {Array<{rating_family?: string}>} cobs
 * @returns {FacFamily[]}
 */
export function familiesForClasses(cobs) {
  const seen = new Map();
  for (const cob of cobs || []) {
    const family = familyForClass(cob);
    if (family && !seen.has(family.code)) seen.set(family.code, family);
  }
  return [...seen.values()];
}

/**
 * Which wizard steps a set of families needs, so the wizard shows a COPE
 * survey for property and skips it for cyber.
 *
 * @param {FacFamily[]} families
 * @returns {Set<string>}
 */
export function wizardStepsForFamilies(families) {
  const steps = new Set();
  for (const family of families || []) {
    for (const step of family.wizardSteps || []) steps.add(step);
  }
  return steps;
}

/**
 * Why a family cannot price a risk yet — a missing engine, or a missing
 * input the engine needs. Returns null when it can.
 *
 * @param {FacFamily|null} family
 * @param {object|null} risk
 * @returns {{reason: 'NOT_IMPLEMENTED'|'MISSING_INPUT', message: string, missing?: string[]}|null}
 */
export function pricingBlocker(family, risk) {
  if (!family) {
    return { reason: 'NOT_IMPLEMENTED', message: 'No rating family resolved for this risk.' };
  }
  if (!family.implemented) {
    return {
      reason: 'NOT_IMPLEMENTED',
      message: `${family.label} rates on ${(RATING_BASIS_LABEL[family.ratingBasis] || family.ratingBasis).toLowerCase()}. `
        + `That engine is not built yet${family.plannedPhase ? ` (${family.plannedPhase})` : ''} — `
        + 'record the terms and price this risk outside the tool for now.'
        + (family.notes ? ` ${family.notes}` : ''),
    };
  }
  const missing = (family.requires || []).filter((key) => {
    const v = risk?.[key];
    return v == null || v === '';
  });
  if (missing.length > 0) {
    return {
      reason: 'MISSING_INPUT',
      missing,
      message: `${family.label} needs ${missing.join(' and ')} before it can price. `
        + 'Set them on the Risk Detail screen.',
    };
  }
  return null;
}
