// shared/fac/renewal.js
//
// Why the price moved.
//
// A renewal that says "last year 2.10‰, this year 2.45‰" has told an
// underwriter almost nothing. Three quite different things produce that
// number, and they call for three different conversations:
//
//   • the risk got bigger        — more values, more turnover, more vehicles
//   • the rate went up           — the market hardened, or the model did
//   • the structure changed      — a higher deductible, a different limit,
//                                  a share that moved
//
// A broker arguing about a 17% increase is usually arguing about one of them
// while the underwriter is defending another. This decomposes the change so
// both can see which.
//
// ── The decomposition ────────────────────────────────────────────────────
//
// Premium is rate × exposure, so the change factorises exactly:
//
//     P₁/P₀ = (R₁/R₀) × (E₁/E₀)
//
// and in log space those multiply into a sum, which is what makes the split
// clean and order-independent. Reporting it multiplicatively — as factors
// whose product is the total — is more honest than an additive split, which
// has to choose an order and hides an interaction term in whichever component
// happens to be measured second.
//
// Structure is the awkward one. A deductible or limit change moves the rate
// legitimately, so it is NOT a separate factor in the arithmetic — it is a
// flag on the rate change, saying that part of the movement was bought rather
// than imposed. Pretending to attribute it numerically would need an exposure
// curve for the specific structure change, which is exactly the sort of number
// this module refuses to invent.

import { num, numOrNull } from './num.js';

/** What changed about the cover, as opposed to about the price. */
export const STRUCTURE_FIELDS = [
  { key: 'deductible_amount', label: 'Deductible' },
  { key: 'np_retention', label: 'Retention' },
  { key: 'np_limit', label: 'Limit' },
  { key: 'our_share_pct', label: 'Our share' },
  { key: 'ri_share_pct', label: 'RI share' },
  { key: 'placement_type', label: 'Placement type' },
  { key: 'policy_period_months', label: 'Period' },
];

/**
 * One side of a comparison, reduced to what a renewal is judged on.
 *
 * @param {object|null} risk    fac_risk row
 * @param {object|null} pricing fac_pricing row
 * @param {object|null} exposure buildExposureProfile output
 * @returns {object|null}
 */
export function renewalSnapshot(risk, pricing, exposure) {
  if (!risk) return null;
  const premiumBase = numOrNull(exposure?.total_si)
    ?? numOrNull(risk.total_sum_insured)
    ?? null;
  return {
    fac_risk_id: risk.fac_risk_id,
    reference: risk.bound_reference || risk.fac_ref || null,
    uw_year: numOrNull(risk.uw_year),
    inception_date: risk.inception_date || null,
    status: risk.status || null,
    premium_base: premiumBase,
    rate_pm: numOrNull(pricing?.final_rate_per_mille),
    technical_gross_pm: numOrNull(pricing?.technical_gross_rate_pm),
    technical_adequacy: numOrNull(pricing?.technical_adequacy),
    premium: numOrNull(pricing?.final_premium),
    structure: Object.fromEntries(
      STRUCTURE_FIELDS.map((f) => [f.key, risk[f.key] ?? null]),
    ),
  };
}

/**
 * What changed about the cover between two years.
 *
 * @param {object|null} expiring
 * @param {object|null} renewing
 * @returns {Array<{key: string, label: string, from: *, to: *}>}
 */
export function structureChanges(expiring, renewing) {
  const changes = [];
  for (const field of STRUCTURE_FIELDS) {
    const from = expiring?.structure?.[field.key] ?? null;
    const to = renewing?.structure?.[field.key] ?? null;
    const same = from === to
      || (numOrNull(from) !== null && numOrNull(to) !== null
        && Math.abs(num(from) - num(to)) < 1e-9);
    if (!same) changes.push({ key: field.key, label: field.label, from, to });
  }
  return changes;
}

/**
 * Decompose a premium change into rate and exposure.
 *
 *     P₁/P₀ = (R₁/R₀) × (E₁/E₀)
 *
 * Reported as factors whose product is the total change, because an additive
 * split has to pick an order and buries the interaction term in whichever
 * component it measures second.
 *
 * @param {object|null} expiring  renewalSnapshot output
 * @param {object|null} renewing  renewalSnapshot output
 * @returns {object}
 */
export function decomposeChange(expiring, renewing) {
  const r0 = numOrNull(expiring?.rate_pm);
  const r1 = numOrNull(renewing?.rate_pm);
  const e0 = numOrNull(expiring?.premium_base);
  const e1 = numOrNull(renewing?.premium_base);

  const usable = (v) => v !== null && v > 0;
  const structure = structureChanges(expiring, renewing);

  if (!usable(r0) || !usable(r1)) {
    return {
      measurable: false,
      reason: expiring
        ? 'The expiring risk carries no rate, so the change cannot be split.'
        : 'No expiring risk is linked, so there is nothing to compare against.',
      structure_changes: structure,
    };
  }

  const rateFactor = r1 / r0;
  const exposureFactor = usable(e0) && usable(e1) ? e1 / e0 : null;
  const totalFactor = exposureFactor === null ? null : rateFactor * exposureFactor;

  // A rate move that came with a structure change was partly bought, not
  // imposed. Saying which is more useful than attributing it to a number this
  // module would have to invent an exposure curve to justify.
  const structurePriced = structure.filter(
    (c) => ['deductible_amount', 'np_retention', 'np_limit', 'policy_period_months'].includes(c.key),
  );

  return {
    measurable: true,
    expiring_rate_pm: r0,
    renewing_rate_pm: r1,
    expiring_base: e0,
    renewing_base: e1,
    rate_factor: rateFactor,
    rate_change_pct: rateFactor - 1,
    exposure_factor: exposureFactor,
    exposure_change_pct: exposureFactor === null ? null : exposureFactor - 1,
    premium_factor: totalFactor,
    premium_change_pct: totalFactor === null ? null : totalFactor - 1,
    structure_changes: structure,
    // The honest caveat, carried in the data rather than left to the reader.
    rate_change_partly_structural: structurePriced.length > 0,
    structure_note: structurePriced.length > 0
      ? `The cover changed (${structurePriced.map((c) => c.label).join(', ')}), so part of the `
        + 'rate movement is a different product rather than a different price. How much is not '
        + 'split out — doing so needs an exposure curve for this structure change, and a number '
        + 'invented for the purpose would be worse than the caveat.'
      : null,
    summary: summarise(rateFactor, exposureFactor, totalFactor),
  };
}

function summarise(rateFactor, exposureFactor, totalFactor) {
  const pct = (f) => `${f >= 1 ? '+' : ''}${((f - 1) * 100).toFixed(1)}%`;
  if (exposureFactor === null) {
    return `Rate ${pct(rateFactor)}. The exposure base is missing on one side, so the premium `
      + 'change cannot be split.';
  }
  return `Premium ${pct(totalFactor)} = rate ${pct(rateFactor)} × exposure ${pct(exposureFactor)}.`;
}

/**
 * The whole renewal comparison.
 *
 * @param {object} args {expiring, renewing} both renewalSnapshot outputs
 * @returns {object}
 */
export function renewalComparison({ expiring, renewing }) {
  const decomposition = decomposeChange(expiring, renewing);
  const adequacyMove = numOrNull(renewing?.technical_adequacy) !== null
      && numOrNull(expiring?.technical_adequacy) !== null
    ? num(renewing.technical_adequacy) - num(expiring.technical_adequacy)
    : null;

  return {
    expiring,
    renewing,
    decomposition,
    // Whether the renewal moved toward or away from the technical price is a
    // different question from whether it went up, and often the more
    // important one: a rate rise that still lands under technical is not a
    // rate rise worth celebrating.
    adequacy_move: adequacyMove,
    adequacy_note: adequacyMove === null
      ? 'One side has no technical rate recorded, so the move against technical is unknown.'
      : adequacyMove >= 0
        ? `Priced ${(adequacyMove * 100).toFixed(1)} points closer to technical than last year.`
        : `Priced ${(Math.abs(adequacyMove) * 100).toFixed(1)} points further below technical `
          + 'than last year.',
  };
}
