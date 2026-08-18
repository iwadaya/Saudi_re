// shared/fac/methods/freqSeverity.js
//
// Frequency × severity: the loss cost as a claim rate multiplied by an
// average claim, rather than as a burn rate on a premium base.
//
//     lossCost = frequency(per exposure unit) × severity × exposureUnits
//
// It exists because burning cost cannot answer the question a motor fleet or
// a personal-accident scheme actually asks. A fleet that grew from 200 to 800
// vehicles has a burn rate that means nothing — the exposure moved under the
// losses. Splitting the two lets each be trended on its own terms, which is
// the point: frequency is broadly stable and severity is not, and a single
// blended trend on the burn rate gets both wrong.
//
// ── What this is not ──────────────────────────────────────────────────────
//
// It is not a severity DISTRIBUTION. Fitting a lognormal or a Pareto to a
// carrier's own claims and integrating a layer through it is a different and
// much stronger method, and it needs a fitted tail parameter that belongs to
// whoever owns the data. What is here is the observed mean severity from the
// risk's own restated claims, which is defensible for a working layer and
// honestly weak in an excess one — so `layerCaution` is set when the
// structure attaches above the observed claims and the caller can see it.
//
// Severity trend applies from the midpoint of each experience year to the
// midpoint of the policy period, the same convention burningCost.js uses.

import { num, numOrNull } from '../num.js';

export const METHOD_CODE = 'FREQ_SEVERITY';

/**
 * Split a set of restated losses into a frequency and a severity.
 *
 * @param {object} args
 * @param {Array<object>} args.losses            fac_loss_history rows
 * @param {Array<object>} args.basis             fac_experience_basis rows — the exposure
 *                                               UNITS per year (vehicles, members, …)
 * @param {number} [args.severityTrendPct]       annual severity trend, e.g. 0.06
 * @param {number} [args.asOfYear]               the policy year being priced
 * @returns {{available: boolean, unavailableReason?: string, frequency?: number,
 *            severity?: number, years?: number, claimCount?: number, diagnostics: object}}
 */
export function frequencySeverity({ losses, basis, severityTrendPct = 0, asOfYear }) {
  const basisRows = (basis || []).filter((b) => numOrNull(b.exposure_base) !== null);
  if (basisRows.length === 0) {
    return {
      available: false,
      unavailableReason: 'No exposure history. Frequency needs the units at risk in each year '
        + '— vehicles, members, benefit units — not just the claims.',
      diagnostics: {},
    };
  }

  const totalUnits = basisRows.reduce((t, b) => t + num(b.exposure_base), 0);
  if (!(totalUnits > 0)) {
    return {
      available: false,
      unavailableReason: 'The exposure history has no units in it. A frequency per zero '
        + 'vehicle-years is not a number.',
      diagnostics: { years: basisRows.length },
    };
  }

  const trend = num(severityTrendPct);
  const target = numOrNull(asOfYear) ?? Math.max(...basisRows.map((b) => num(b.loss_year))) + 1;

  const usable = (losses || []).filter((l) => !l.exclude_from_rating);
  const trended = usable.map((l) => {
    // Prefer the restated figure the experience screen produced; fall back to
    // the raw incurred so a risk with no restatement still prices.
    const amount = numOrNull(l.as_if_incurred)
      ?? numOrNull(l.indexed_incurred)
      ?? numOrNull(l.fgu_incurred)
      ?? (num(l.fgu_paid) + num(l.fgu_outstanding));
    const years = Math.max(target - num(l.loss_year), 0);
    return { ...l, amount: amount * (1 + trend) ** years, rawAmount: amount, trendYears: years };
  });

  // A claim count declared on the experience basis beats one inferred from
  // the loss listing: large-loss listings routinely omit attritional claims,
  // and dividing by the number of rows in a large-loss table would overstate
  // severity by an order of magnitude.
  const declaredCount = basisRows.reduce(
    (t, b) => (numOrNull(b.claim_count) === null ? t : t + num(b.claim_count)), 0,
  );
  const declaredYears = basisRows.filter((b) => numOrNull(b.claim_count) !== null).length;
  const countIsDeclared = declaredYears === basisRows.length && declaredCount > 0;
  const claimCount = countIsDeclared ? declaredCount : trended.length;

  if (claimCount === 0) {
    return {
      available: true,
      frequency: 0,
      severity: 0,
      years: basisRows.length,
      claimCount: 0,
      lossCost: 0,
      diagnostics: {
        years: basisRows.length,
        total_units: totalUnits,
        count_basis: countIsDeclared ? 'DECLARED' : 'LOSS_LISTING',
        note: 'No claims in the experience period. A clean record is evidence, not an absence '
          + 'of it — the zero is real and carries the credibility its volume earns.',
      },
    };
  }

  const totalAmount = trended.reduce((t, l) => t + l.amount, 0);
  const frequency = claimCount / totalUnits;
  // Severity divides by the count the amounts belong to, which is the listing
  // count — not a declared count that includes claims whose amounts are not
  // in the listing.
  const severity = trended.length > 0 ? totalAmount / trended.length : 0;

  const warnings = [];
  if (countIsDeclared && declaredCount !== trended.length) {
    warnings.push(
      `Frequency uses the ${declaredCount} claims declared on the experience basis; severity `
      + `uses the ${trended.length} in the loss listing. That is deliberate — a large-loss `
      + 'listing understates the count and overstates the average — but it means the two are '
      + 'measured on different populations.',
    );
  }
  if (trended.length < 5) {
    warnings.push(`Only ${trended.length} claims: the average is unstable at this volume.`);
  }

  return {
    available: true,
    frequency,
    severity,
    years: basisRows.length,
    claimCount,
    diagnostics: {
      years: basisRows.length,
      total_units: totalUnits,
      claim_count: claimCount,
      listing_count: trended.length,
      count_basis: countIsDeclared ? 'DECLARED' : 'LOSS_LISTING',
      total_trended_amount: totalAmount,
      severity_trend_pct: trend,
      as_of_year: target,
      warnings,
    },
  };
}

/**
 * The FREQ_SEVERITY loss-cost candidate.
 *
 * `exposureUnits` is what is being priced — the fleet's vehicle count, the
 * scheme's benefit units — and is deliberately separate from the units in the
 * experience: a fleet that doubled prices on the new count and rates on the
 * old experience, which is the entire reason for splitting frequency from
 * severity in the first place.
 *
 * @param {object} args
 * @param {Array<object>} args.losses
 * @param {Array<object>} args.basis
 * @param {number} args.exposureUnits    units being priced
 * @param {number} [args.severityTrendPct]
 * @param {number} [args.asOfYear]
 * @param {number} [args.attachment]     a layer applies to each claim, not to the total
 * @param {number} [args.limit]
 * @param {number} [args.premiumBase]    what the rate should be per mille OF
 * @returns {object}
 */
export function freqSeverityLossCost({
  losses, basis, exposureUnits, severityTrendPct = 0, asOfYear,
  attachment = 0, limit = Infinity, premiumBase = null,
}) {
  const units = num(exposureUnits);
  if (!(units > 0)) {
    return {
      available: false,
      unavailableReason: 'No exposure units to price. Frequency × severity needs the count '
        + 'being covered — vehicles, members, benefit units.',
      diagnostics: {},
    };
  }

  const split = frequencySeverity({ losses, basis, severityTrendPct, asOfYear });
  if (!split.available) return split;

  // In a layer, the severity that matters is the layer's share of each claim,
  // not the claim. Applying the layer to the AVERAGE would be wrong — it is
  // the individual claims that pierce an attachment — so the layer is applied
  // per claim and re-averaged.
  const d = Math.max(num(attachment), 0);
  const l = limit === Infinity ? Infinity : num(limit);
  let severity = split.severity;
  let layerCaution = false;
  if (d > 0 || l !== Infinity) {
    const trend = num(severityTrendPct);
    const target = numOrNull(asOfYear)
      ?? Math.max(...(basis || []).map((b) => num(b.loss_year)), 0) + 1;
    const perClaim = (losses || [])
      .filter((claim) => !claim.exclude_from_rating)
      .map((claim) => {
        const amount = numOrNull(claim.as_if_incurred)
          ?? numOrNull(claim.indexed_incurred)
          ?? numOrNull(claim.fgu_incurred)
          ?? (num(claim.fgu_paid) + num(claim.fgu_outstanding));
        const trendedAmount = amount * (1 + trend) ** Math.max(target - num(claim.loss_year), 0);
        return Math.min(Math.max(trendedAmount - d, 0), l);
      });
    const hits = perClaim.filter((x) => x > 0).length;
    severity = perClaim.length > 0
      ? perClaim.reduce((t, x) => t + x, 0) / perClaim.length
      : 0;
    // Nothing in the listing reached the attachment. The layer may still be
    // exposed — the listing is a sample of a distribution, not its maximum —
    // so this is a caution, not a zero to be trusted.
    layerCaution = hits === 0;
  }

  const lossCost = split.frequency * severity * units;
  const base = numOrNull(premiumBase);

  const warnings = [...(split.diagnostics.warnings || [])];
  if (layerCaution) {
    warnings.push(
      'No claim in the experience reaches this attachment, so the observed layer severity is '
      + 'zero. That is what the data says, not what the layer costs — an excess layer priced '
      + 'off an unpierced record needs a severity curve, not an average.',
    );
  }

  return {
    available: true,
    lossCost,
    ratePm: base && base > 0 ? (lossCost / base) * 1000 : null,
    claimCount: split.claimCount,
    years: split.years,
    diagnostics: {
      ...split.diagnostics,
      frequency: split.frequency,
      severity,
      ground_up_severity: split.severity,
      exposure_units: units,
      attachment: d,
      limit: l === Infinity ? null : l,
      layer_unpierced: layerCaution,
      warnings,
    },
  };
}
