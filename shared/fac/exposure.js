// shared/fac/exposure.js
//
// One exposure profile per risk, built once and used everywhere.
//
// This exists because the pricing screen used to derive its exposure
// numbers from two different places and never reconciled them:
//
//   • pd_si_share came from the LOCATIONS only, defaulting to 1.0 when the
//     Locations screen was empty — so a risk with BI on the header but no
//     locations computed a BI rate and then weighted it at zero. The
//     output table showed a BI rate that had no effect on the price.
//     (finding F10)
//
//   • the premium basis was `totalLocSar || tsi` — the sum of location
//     PD+BI when any location existed, otherwise the risk header's
//     total_sum_insured, which is itself the sum of the per-class section
//     figures. Adding a single location silently flipped the premium onto
//     a different basis. (finding F11)
//
// Both now come from this one function, so they cannot disagree: the
// PD/BI split, the BI-included flag, the top-location figure and the
// premium basis are all read off the same profile, and the profile says
// which source it used.
//
// Precedence is most-specific-first — locations describe the risk in more
// detail than sections, which describe it in more detail than the header —
// and any disagreement between the sources is surfaced as a warning rather
// than silently resolved.

import { num, numOrNull } from './num.js';

/** Sections and the header may differ by this much before we warn. */
const RECONCILE_TOLERANCE = 0.01; // 1%

function clamp01(v) {
  return Math.min(Math.max(num(v), 0), 1);
}

/**
 * @typedef {Object} ExposureProfile
 * @property {'LOCATIONS'|'SECTIONS'|'RISK_HEADER'|'NONE'} basis  Where the figures came from.
 * @property {number} pd_si            Material damage sum insured.
 * @property {number} bi_si            Business interruption sum insured.
 * @property {number} total_si         pd_si + bi_si — the ONLY premium basis.
 * @property {number} pd_si_share      pd_si / total_si, clamped to 0..1 (1 when there is no BI).
 * @property {boolean} bi_included     Whether BI exposure is present.
 * @property {number|null} pml_pct     Maximum possible loss as a share of total_si,
 *   ALWAYS a 0..1 fraction (0.4 = 40%). The schema stores it two ways —
 *   fac_location.pd_pml_pct / bi_pml_pct are 0..1 fractions, fac_risk.pml_pct
 *   is a 0..100 percentage — and this profile converts once, here, so no
 *   consumer ever sees the percent scale. Null when no PML is recorded
 *   anywhere; consumers then fall back to MPL = total SI and should say so.
 * @property {number|null} top_location_si  Largest single-site exposure, for the line-size cap.
 * @property {number} location_count
 * @property {number} section_count
 * @property {string[]} warnings
 */

/**
 * Build the canonical exposure profile for a facultative risk.
 *
 * @param {object} args
 * @param {object|null} args.risk        fac_risk row
 * @param {Array<object>} [args.sections] fac_risk_section rows
 * @param {Array<object>} [args.locations] fac_location rows
 * @returns {ExposureProfile}
 */
export function buildExposureProfile({ risk, sections = [], locations = [] } = {}) {
  const warnings = [];
  const locs = Array.isArray(locations) ? locations : [];
  const secs = Array.isArray(sections) ? sections : [];

  const sectionsTotal = secs.reduce((acc, s) => acc + num(s.sum_insured), 0);

  let basis = 'NONE';
  let pd_si = 0;
  let bi_si = 0;
  let top_location_si = null;

  if (locs.length > 0) {
    basis = 'LOCATIONS';
    for (const l of locs) {
      const pd = num(l.pd_si);
      const bi = num(l.bi_si);
      pd_si += pd;
      bi_si += bi;
      const site = pd + bi;
      if (top_location_si == null || site > top_location_si) top_location_si = site;
    }
  } else {
    const headerPd = num(risk?.pd_sum_insured);
    const headerBi = num(risk?.bi_sum_insured);
    if (headerPd > 0 || headerBi > 0) {
      basis = 'RISK_HEADER';
      pd_si = headerPd;
      bi_si = headerBi;
    } else if (sectionsTotal > 0) {
      // Sections carry a sum insured per class but no PD/BI split — the
      // split is a property concept that lives on locations or the header.
      // Treating the whole of it as material damage is the conservative
      // reading, and the warning says so rather than letting a silent
      // assumption ride into the price.
      basis = 'SECTIONS';
      pd_si = sectionsTotal;
      bi_si = 0;
      warnings.push(
        'No locations and no PD/BI split on the risk header — the section totals are '
        + 'being treated as 100% material damage. Enter the BI sum insured on Risk '
        + 'Detail, or add locations, to price a BI rate.',
      );
    }
    // Without locations the largest section is the best available proxy for
    // the top single exposure; fall back to the whole risk when there are no
    // sections either.
    const largestSection = secs.reduce((acc, s) => Math.max(acc, num(s.sum_insured)), 0);
    top_location_si = largestSection > 0 ? largestSection : (pd_si + bi_si) || null;
  }

  const total_si = pd_si + bi_si;

  // Sections and the chosen basis should describe the same risk. They are
  // entered on different screens, so drift is common and worth surfacing —
  // it usually means a section was added after the locations were built.
  if (sectionsTotal > 0 && total_si > 0 && basis !== 'SECTIONS') {
    const drift = Math.abs(sectionsTotal - total_si) / sectionsTotal;
    if (drift > RECONCILE_TOLERANCE) {
      warnings.push(
        `Sections total ${Math.round(sectionsTotal).toLocaleString('en-US')} but the `
        + `${basis === 'LOCATIONS' ? 'location schedule' : 'risk header'} totals `
        + `${Math.round(total_si).toLocaleString('en-US')} `
        + `(${(drift * 100).toFixed(1)}% apart). Pricing uses the `
        + `${basis === 'LOCATIONS' ? 'location' : 'header'} figure.`,
      );
    }
  }

  const pd_si_share = total_si > 0 ? Math.min(Math.max(pd_si / total_si, 0), 1) : 1;

  // ── PML, as a 0..1 fraction of total_si ────────────────────────────────
  // Locations first: the weighted MPL over the schedule, with an unstated
  // location PML contributing its full value — absent means "no relief",
  // never "no loss". The risk-header pml_pct (stored 0..100) is the
  // fallback, converted to a fraction exactly once, at this boundary.
  // Null means no PML is recorded anywhere.
  let pml_pct = null;
  if (basis === 'LOCATIONS' && total_si > 0) {
    let mpl = 0;
    let stated = false;
    for (const l of locs) {
      const pdPml = numOrNull(l.pd_pml_pct);
      const biPml = numOrNull(l.bi_pml_pct);
      if (pdPml !== null || biPml !== null) stated = true;
      mpl += num(l.pd_si) * (pdPml === null ? 1 : clamp01(pdPml))
        + num(l.bi_si) * (biPml === null ? 1 : clamp01(biPml));
    }
    if (stated && mpl > 0) pml_pct = clamp01(mpl / total_si);
  }
  if (pml_pct === null) {
    const riskPml = numOrNull(risk?.pml_pct);
    if (riskPml !== null && riskPml > 0) pml_pct = clamp01(riskPml / 100);
  }

  return {
    basis,
    pd_si,
    bi_si,
    total_si,
    pd_si_share,
    bi_included: bi_si > 0,
    pml_pct,
    top_location_si,
    location_count: locs.length,
    section_count: secs.length,
    warnings,
  };
}
