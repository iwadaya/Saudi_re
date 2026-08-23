// shared/fac/accumulation.js
//
// The capacity check, at three levels. This is finding F14.
//
// What the module did before: `max_capacity_sar` compared a risk against a
// STATIC territorial budget from `fac_territorial_capacity`. It never looked
// at what had already been written. A carrier could bind ten identical
// warehouses in one CRESTA zone and every one of them would pass, because
// each was measured against the same untouched budget. The budget was a
// speed limit with no speedometer attached.
//
// What replaces it:
//
//   1. **Per-risk line.** The grade-derived maximum percentage applied to the
//      family's own line-size basis — top-location values for property, the
//      limit for casualty, the agreed value for hull. This is the check that
//      already existed and it is kept.
//
//   2. **Zone accumulation.** Committed exposure in the CRESTA zone, from
//      bound facultative risks and inforce treaty aggregates, plus what this
//      risk would add, against the zone budget. This is the check that was
//      missing.
//
//   3. **Systemic.** The correlations that do not respect geography: a cyber
//      common-vendor scenario, a cargo maximum any-one-conveyance, a marine
//      war region, a PA one-event group. A zone budget cannot see any of
//      them.
//
// ── What a missing budget does ────────────────────────────────────────────
//
// `fac_zone_budget` ships empty. With no budget loaded the check reports the
// committed exposure and states that no budget is set — it does not pass, and
// it does not fail. A budget is an appetite decision; inventing one would make
// this look like it was working when it was only guessing, which is the exact
// failure mode F14 describes.

import { num, numOrNull } from './num.js';

/**
 * The line size this risk would take, on the basis its family uses.
 *
 * @param {object} args
 * @param {object} args.family
 * @param {object} args.exposure    buildExposureProfile output
 * @param {Array<object>} [args.sections]
 * @param {object} [args.risk]
 * @returns {{amount: number|null, basis: string}}
 */
export function lineSizeBasis({ family, exposure, sections, risk }) {
  switch (family?.ratingBasis) {
    case 'LIMIT_ILF': {
      // Casualty and cyber consume capacity by the limit written, not by any
      // value: there is no value.
      const limit = (sections || []).reduce(
        (t, s) => t + (numOrNull(s.limit_amount) ?? 0), 0,
      ) || numOrNull(risk?.np_limit) || null;
      return { amount: limit, basis: 'LIMIT' };
    }
    case 'AGREED_VALUE':
      return {
        amount: (sections || []).reduce((t, s) => t + (numOrNull(s.sum_insured) ?? 0), 0) || null,
        basis: 'AGREED_VALUE',
      };
    case 'CONTRACT_VALUE':
      return {
        amount: (sections || []).reduce((t, s) => t + (numOrNull(s.sum_insured) ?? 0), 0) || null,
        basis: 'CONTRACT_VALUE',
      };
    case 'TURNOVER':
      // Cargo's line is the maximum any-one-conveyance, never the turnover.
      // Rating against turnover and taking a line against turnover would let
      // a £200m-a-year shipper consume the whole budget on a £5m exposure.
      return {
        amount: (sections || []).reduce(
          (t, s) => t + (numOrNull(s.exposure_detail?.max_any_one_conveyance)
            ?? numOrNull(s.limit_amount) ?? 0), 0,
        ) || null,
        basis: 'MAX_ANY_ONE_CONVEYANCE',
      };
    case 'PER_UNIT':
      return {
        amount: (sections || []).reduce(
          (t, s) => t + (numOrNull(s.exposure_detail?.cat_limit) ?? numOrNull(s.limit_amount) ?? 0),
          0,
        ) || null,
        basis: 'ONE_EVENT_LIMIT',
      };
    default:
      // Property: the largest single location is the line, not the schedule
      // total — one fire does not visit every warehouse.
      return {
        amount: numOrNull(exposure?.top_location_si) ?? numOrNull(exposure?.total_si),
        basis: exposure?.top_location_si ? 'TOP_LOCATION_SI' : 'TOTAL_SI',
      };
  }
}

/**
 * Level 1 — the per-risk line.
 *
 * @param {object} args
 * @param {number|null} args.lineSize
 * @param {number|null} args.maxCapacityPct   from the score's capacity band
 * @param {number|null} args.writtenShare     the share actually being taken
 * @returns {object}
 */
export function perRiskLineCheck({ lineSize, maxCapacityPct, writtenShare }) {
  const size = numOrNull(lineSize);
  const pct = numOrNull(maxCapacityPct);
  const share = numOrNull(writtenShare);
  if (size === null || pct === null) {
    return {
      level: 'PER_RISK_LINE',
      status: 'NOT_APPLICABLE',
      message: size === null
        ? 'No line-size basis on this risk yet.'
        : 'No capacity grade yet — the score has to complete first.',
    };
  }
  const maxLine = size * pct;
  const taken = share === null ? null : size * share;
  return {
    level: 'PER_RISK_LINE',
    status: taken !== null && taken > maxLine ? 'BREACH' : 'PASS',
    lineSize: size,
    maxCapacityPct: pct,
    maxLine,
    written: taken,
    headroom: taken === null ? maxLine : maxLine - taken,
    message: taken !== null && taken > maxLine
      ? `The share being written is ${(share * 100).toFixed(1)}% of the line, above the `
        + `${(pct * 100).toFixed(1)}% the score's grade allows.`
      : `Up to ${(pct * 100).toFixed(1)}% of the line is available on this grade.`,
  };
}

/**
 * Level 2 — zone accumulation.
 *
 * @param {object} args
 * @param {Array<object>} args.committed  mv_fac_accumulation rows for the zone
 * @param {object|null} args.budget       fac_zone_budget row
 * @param {number|null} args.thisRisk     what this risk would add, at our share
 * @param {string} args.zone
 * @returns {object}
 */
export function zoneAccumulationCheck({ committed, budget, thisRisk, zone }) {
  const committedPml = (committed || []).reduce(
    (t, r) => t + (numOrNull(r.committed_pml) ?? numOrNull(r.committed_si) ?? 0), 0,
  );
  const adding = numOrNull(thisRisk) ?? 0;
  const wouldBe = committedPml + adding;
  const cap = numOrNull(budget?.budget_pml) ?? numOrNull(budget?.budget_si);

  if (cap === null) {
    return {
      level: 'ZONE_ACCUMULATION',
      status: 'NO_BUDGET',
      zone,
      committed: committedPml,
      adding,
      wouldBe,
      message: `${zone} carries ${Math.round(committedPml).toLocaleString('en-US')} of committed `
        + `exposure and this risk would add ${Math.round(adding).toLocaleString('en-US')}. No `
        + 'budget is set for the zone, so there is nothing to measure that against — load one in '
        + 'fac_zone_budget.',
    };
  }

  return {
    level: 'ZONE_ACCUMULATION',
    status: wouldBe > cap ? 'BREACH' : 'PASS',
    zone,
    committed: committedPml,
    adding,
    wouldBe,
    budget: cap,
    utilisation: cap > 0 ? wouldBe / cap : null,
    headroom: cap - wouldBe,
    message: wouldBe > cap
      ? `Binding this would take ${zone} to ${Math.round(wouldBe).toLocaleString('en-US')} `
        + `against a budget of ${Math.round(cap).toLocaleString('en-US')} — over by `
        + `${Math.round(wouldBe - cap).toLocaleString('en-US')}.`
      : `${zone} would be at ${((wouldBe / cap) * 100).toFixed(1)}% of budget after this risk.`,
  };
}

/**
 * Level 3 — the systemic checks, which no zone budget can see.
 *
 * Each is a correlation that crosses geography: every account on one cloud
 * provider fails together; every container on one ship sinks together; every
 * member of one group travels together.
 *
 * @param {object} args
 * @param {object} args.family
 * @param {Array<object>} args.sections
 * @param {object} [args.systemic]  {vendorExposure: [{vendor_key, committed, risk_count}],
 *                                   warRegionExposure: [...]}
 * @returns {Array<object>}
 */
export function systemicChecks({ family, sections, systemic = {} }) {
  const checks = [];
  const list = sections || [];

  if (family?.code === 'CYBER_LIMIT') {
    const tagged = list.flatMap((s) => (s.exposure_detail?.dependencies || []))
      .map((d) => (typeof d === 'string' ? d : d?.vendor_key || d?.vendorKey))
      .filter(Boolean);
    if (tagged.length === 0) {
      checks.push({
        level: 'SYSTEMIC_VENDOR',
        status: 'BREACH',
        message: 'No critical vendor or cloud dependencies are tagged. Cyber accumulates through '
          + 'shared infrastructure, so an untagged risk cannot be checked against the book at '
          + 'all — this is a hard gate, not a warning.',
      });
    } else {
      const byVendor = new Map(
        (systemic.vendorExposure || []).map((v) => [String(v.vendor_key).toUpperCase(), v]),
      );
      for (const vendor of [...new Set(tagged.map((v) => String(v).toUpperCase()))]) {
        const book = byVendor.get(vendor);
        checks.push({
          level: 'SYSTEMIC_VENDOR',
          status: book ? 'PASS' : 'NOT_APPLICABLE',
          vendor,
          committedLimit: book ? numOrNull(book.committed_limit) : null,
          riskCount: book ? numOrNull(book.risk_count) : null,
          message: book
            ? `${book.risk_count} bound risk(s) already depend on ${vendor}, carrying `
              + `${Math.round(num(book.committed_limit)).toLocaleString('en-US')} of limit. One `
              + 'outage is one loss across all of them.'
            : `${vendor} is not yet carried anywhere else in the bound book.`,
        });
      }
    }
  }

  if (family?.code === 'TRANSIT_VALUES') {
    const maxConveyance = list.reduce(
      (t, s) => Math.max(t, numOrNull(s.exposure_detail?.max_any_one_conveyance)
        ?? numOrNull(s.limit_amount) ?? 0), 0,
    );
    checks.push({
      level: 'SYSTEMIC_CONVEYANCE',
      status: maxConveyance > 0 ? 'PASS' : 'BREACH',
      amount: maxConveyance || null,
      message: maxConveyance > 0
        ? `Maximum any-one-conveyance is ${maxConveyance.toLocaleString('en-US')}. That, not the `
          + 'annual turnover, is what one loss can cost.'
        : 'No maximum any-one-conveyance stated. It is the binding exposure on a cargo account '
          + 'and the annual rate says nothing about it.',
    });
  }

  const warRegions = [...new Set(
    list.map((s) => s.exposure_detail?.war_region).filter(Boolean).map((r) => String(r).toUpperCase()),
  )];
  for (const region of warRegions) {
    const book = (systemic.warRegionExposure || []).find(
      (w) => String(w.region).toUpperCase() === region,
    );
    checks.push({
      level: 'SYSTEMIC_WAR_REGION',
      status: book ? 'PASS' : 'NOT_APPLICABLE',
      region,
      committed: book ? numOrNull(book.committed) : null,
      message: book
        ? `${Math.round(num(book.committed)).toLocaleString('en-US')} of war exposure is already `
          + `committed in ${region}. War regions close on days, not quarters.`
        : `No other bound risk carries war exposure in ${region}.`,
    });
  }

  if (family?.code === 'PA_BENEFIT') {
    const oneEvent = list.reduce(
      (t, s) => Math.max(t, numOrNull(s.exposure_detail?.max_one_event_headcount) ?? 0), 0,
    );
    checks.push({
      level: 'SYSTEMIC_ONE_EVENT',
      status: oneEvent > 0 ? 'PASS' : 'BREACH',
      headcount: oneEvent || null,
      message: oneEvent > 0
        ? `Up to ${oneEvent} members are exposed to one event.`
        : 'No one-event exposure stated. A scheme\'s annual cost is affordable and its worst '
          + 'case may not be — state the largest group that travels together.',
    });
  }

  return checks;
}

/**
 * The whole check, and the single answer it comes to.
 *
 * A BREACH at any level is a referral, not a refusal: the underwriter with the
 * authority can still write it, and the record shows what was overridden.
 *
 * @param {object} args
 * @returns {{status: string, checks: Array<object>, referral: boolean, reasons: string[]}}
 */
export function capacityCheck(args) {
  const checks = [
    perRiskLineCheck(args.perRiskLine || {}),
    ...(args.zones || []).map((z) => zoneAccumulationCheck(z)),
    ...systemicChecks(args),
  ];
  const breaches = checks.filter((c) => c.status === 'BREACH');
  const noBudget = checks.filter((c) => c.status === 'NO_BUDGET');
  return {
    status: breaches.length > 0 ? 'BREACH' : (noBudget.length > 0 ? 'NO_BUDGET' : 'PASS'),
    referral: breaches.length > 0,
    checks,
    reasons: breaches.map((c) => c.message),
    unmeasured: noBudget.map((c) => c.message),
  };
}
