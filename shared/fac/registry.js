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
// ── Metadata here, engines elsewhere ──────────────────────────────────────
//
// This module imports families/meta.js — what each family IS — and nothing
// that prices. Engines attach at runtime through `registerEngine`, which
// shared/fac/engines.js calls for every family; shared/fac/index.js imports
// that, so anything using the pipeline gets the full registry.
//
// The reason is the browser. A screen that needs to say "Hull & Machinery
// rates per mille of agreed value and needs no COPE survey" was, before this
// split, importing eleven rate engines to read one label. The server prices;
// the client reads labels and runs exactly one engine (the property
// workbook, which it imports directly).
//
// `implemented: false` is a first-class state, and it is why the module
// stopped rendering stack traces: before the registry existed, a Marine or
// Casualty risk reached the property engine, which threw
// `Unknown occupancy_code`, and the screen printed the exception in red
// (finding F1). A declared family answers "that engine is not built yet"
// instead.
//
// Adding a class is a row in fac_class_of_business pointing at a family.
// Adding a family is an entry in meta.js, one module, and one line in
// engines.js; no screen, route, audit or referral code changes.

import { FAMILY_META } from './families/meta.js';

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
 * @property {Array<object>} [exposureFields] The exposure form this family needs.
 * @property {Function} [computeCandidates]  Attached by engines.js.
 * @property {Function} [computeQuote]       Attached by engines.js, property only.
 * @property {Function} [premiumBase]        Attached by engines.js.
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
  AVIATION_SPACE:           'Aviation & Space',
  AGRICULTURE:              'Agriculture',
};

/** @type {Map<string, FacFamily>} */
const REGISTRY = new Map();
for (const meta of FAMILY_META) {
  REGISTRY.set(meta.code, { ...meta });
}

/**
 * Attach a family's engine to its metadata entry.
 *
 * Called by shared/fac/engines.js at import time. Idempotent, and it never
 * overwrites metadata: a family module spreads its own metadata from meta.js,
 * so the two cannot disagree, and only the functions move.
 *
 * @param {object} family the family module's exported descriptor
 * @returns {void}
 */
export function registerEngine(family) {
  const entry = REGISTRY.get(family?.code);
  if (!entry) throw new Error(`Cannot register an engine for unknown family "${family?.code}"`);
  for (const [key, value] of Object.entries(family)) {
    if (typeof value === 'function') entry[key] = value;
  }
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
