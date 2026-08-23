// shared/fac/index.js
//
// Public entry point for the facultative pricing pipeline. Client screens
// and server routes both import from here so there is exactly one path
// from a risk to a price — which is what lets the server verify what the
// browser sent (see POST /api/fac/risks/:id/price).

// Only what actually crosses the client/server boundary is re-exported
// here; the pipeline's internals (methods/, credibility, layers, families)
// export their own symbols for direct import and white-box tests.
export { buildExposureProfile } from './exposure.js';
export {
  listFamilies,
  familyForClass,
  RATING_BASIS_LABEL,
  SEGMENT_LABEL,
} from './registry.js';

// Attaching the engines to the registry is a side effect of importing this
// module, and it has to happen before anything below runs. The browser
// imports registry.js directly and does not pay for it — see engines.js.
import './engines.js';

import { buildExposureProfile } from './exposure.js';
import { familyForClass, getFamily, pricingBlocker } from './registry.js';
import { burningCostLossCost } from './methods/burningCost.js';
import { benchmarkLossCost } from './methods/benchmark.js';
import { toCandidate, buildTechnicalPremium, technicalAdequacy } from './pipeline.js';
import { num, numOrNull } from './num.js';

/**
 * Price one facultative risk end to end: resolve its family, build the
 * exposure profile, and run the family's engine.
 *
 * Returns a discriminated result rather than throwing, because "this class
 * has no engine yet" and "this risk is missing its NatCat zone" are both
 * ordinary states the screen has to render — not exceptions. The old path
 * threw for both and the UI printed the stack message in red (finding F1).
 *
 * `result` is the workbook-style quote object, and only SCHEDULE_PROPERTY
 * has one: it is the family whose exposure view comes out of an engine with
 * a rate build-up, a score and a decision. The Phase 3 families rate off
 * loaded tables and produce loss-cost candidates instead, so they return
 * `result: null` here and are priced through `priceFacRiskFull`.
 *
 * @param {object} args
 * @param {object} args.risk               fac_risk row
 * @param {object|null} [args.cob]         its class-of-business row (carries rating_family)
 * @param {Array<object>} [args.sections]  fac_risk_section rows
 * @param {Array<object>} [args.locations] fac_location rows
 * @param {object} args.inputs             underwriter-controlled engine inputs
 * @param {object} args.referenceData      occupancies, factors, weights, scoring tables…
 * @returns {{ok: true, family: string, exposure: object, result: object|null}
 *          | {ok: false, family: string|null, blocker: object, exposure: object}}
 */
export function priceFacRisk({ risk, cob, sections, locations, inputs, referenceData }) {
  const family = familyForClass(cob);
  const exposure = buildExposureProfile({ risk, sections, locations });

  const blocker = pricingBlocker(family, risk);
  if (blocker) {
    return { ok: false, family: family?.code ?? null, blocker, exposure };
  }

  const result = typeof family.computeQuote === 'function'
    ? family.computeQuote({ ...inputs, exposure }, referenceData)
    : null;
  return { ok: true, family: family.code, exposure, result };
}

/**
 * Group a risk's sections by the family that prices them.
 *
 * A risk with a property section and a liability section is ordinary, and
 * the two do not rate alike — one is per mille of values, the other is a
 * loss cost to a limit off turnover. Grouping is how each gets its own
 * engine, and the groups are ordered by section number so the primary
 * section leads.
 *
 * @param {Array<object>} sections
 * @param {object} defaultFamily  the risk's own family, for sections that
 *                                do not name one
 * @returns {Array<{family: object, sections: Array<object>}>}
 */
function sectionGroups(sections, defaultFamily) {
  const list = (sections || []).slice().sort(
    (a, b) => (numOrNull(a.section_no) ?? 0) - (numOrNull(b.section_no) ?? 0),
  );
  if (list.length === 0) return [{ family: defaultFamily, sections: [] }];

  const byCode = new Map();
  for (const sec of list) {
    const family = getFamily(sec.rating_family) || defaultFamily;
    if (!byCode.has(family.code)) byCode.set(family.code, { family, sections: [] });
    byCode.get(family.code).sections.push(sec);
  }
  return [...byCode.values()];
}

/**
 * What a family's rate is per mille OF.
 *
 * The family decides, because only the family knows: property rates against
 * values, cargo against annual sendings, casualty against turnover or
 * payroll, personal accident against the total benefit at risk. Using a sum
 * insured for all of them was the Phase 3 shortcut and it produces a premium
 * wrong by whatever ratio the two bases happen to sit in.
 *
 * @param {object} family
 * @param {object} args {exposure, sections, risk}
 * @returns {number}
 */
function premiumBaseFor(family, args) {
  if (typeof family?.premiumBase === 'function') {
    return numOrNull(family.premiumBase(args)) ?? 0;
  }
  return numOrNull(args.exposure?.total_si) ?? 0;
}

/**
 * Price a risk through the whole pipeline: every loss-cost method the
 * family supports, blended by credibility, then loaded and grossed up.
 *
 * Every family contributes its own exposure-side candidates through
 * `family.computeCandidates`; burning cost and benchmark are family-agnostic
 * and added here. Nothing in this function knows which family it is holding,
 * which is the point — adding a family is a module and a registry entry.
 *
 * It degrades to exactly the property engine's own answer when no other
 * method has data: with the workbook rate as the only candidate and no loads
 * configured, the technical gross rate equals the engine's final gross rate.
 * A risk with no loss history and no curve prices today as it did yesterday.
 *
 * @param {object} args  everything priceFacRisk takes, plus:
 * @param {Array<object>} [args.losses]        fac_loss_history rows
 * @param {Array<object>} [args.experienceBasis] fac_experience_basis rows
 * @param {Array<object>} [args.curveBands]    [{min_exposure, max_exposure, curve}]
 * @param {Array<object>} [args.benchmarks]    bound comparables [{rate_pm, uw_year}]
 * @param {string} [args.benchmarkScope]
 * @param {object} [args.rates]                loaded family rate tables
 * @param {object} [args.loads]                {catLoadPm, riskLoadTheta, riskLoadPct, internalExpensePct}
 * @param {object} [args.weightOverride]       {weights, reasonCode}
 * @returns {object}
 */
export function priceFacRiskFull(args) {
  const base = priceFacRisk(args);
  if (!base.ok) return { ...base, technical: null };

  const {
    risk, sections, inputs = {}, losses, experienceBasis, curveBands, benchmarks,
    benchmarkScope, rates = {}, loads = {}, weightOverride = null, referenceData,
    locations,
  } = args;
  const riskFamily = familyForClass(args.cob);
  const exposure = base.exposure;
  const engine = base.result;

  // The structure being priced. A proportional placement is ground-up
  // unlimited; an XL placement takes its own attachment and limit.
  const isNonProportional = risk?.placement_type === 'NON_PROPORTIONAL';
  const attachment = isNonProportional ? (numOrNull(risk?.np_retention) ?? 0) : 0;
  const limit = isNonProportional ? (numOrNull(risk?.np_limit) ?? Infinity) : Infinity;
  const structure = { attachment, limit, isNonProportional };

  const groups = sectionGroups(sections, riskFamily);
  const priced = groups.map((group) => priceSectionGroup({
    group, risk, cob: args.cob, structure, inputs, referenceData, engine,
    locations, riskExposure: exposure, rates, curveBands, losses,
  }));

  // ── The experience side ──────────────────────────────────────────
  // Losses are risk-level unless they name a section. A loss attributed to a
  // section is priced inside that section's group above; what is left is the
  // risk's own record and is blended against the sum of the groups.
  const unattributed = (losses || []).filter((l) => !l.section_id);

  const experience = burningCostLossCost({
    losses: unattributed,
    basis: experienceBasis,
    severityTrendPct: numOrNull(risk?.severity_trend_pct) ?? 0,
    asOfYear: numOrNull(risk?.uw_year) ?? undefined,
    attachment,
    limit,
    fallbackExposure: exposure.total_si,
    fallbackYears: numOrNull(risk?.experience_years) ?? 0,
  });

  // ── Single group: the Phase 3 path, unchanged ────────────────────
  // Most risks are one section in one family, and that case must produce the
  // identical number it produced before multi-section pricing existed — the
  // safety invariant depends on it.
  if (priced.length === 1) {
    const only = priced[0];
    const candidates = [
      ...only.candidates,
      toCandidate('BURNING_COST', experience),
      toCandidate('BENCHMARK', benchmarkLossCost({
        observations: benchmarks, scope: benchmarkScope,
      })),
    ];
    const technical = buildTechnicalPremium({
      candidates,
      credibility: only.family.credibility,
      weightOverride,
      ...pipelineLoads(loads, inputs),
      exposureTotal: only.premiumBase,
    });
    return {
      ...base,
      technical,
      section: only.sections[0] || null,
      sections: [sectionSummary(only, technical)],
    };
  }

  // ── Several groups: blend at risk level ──────────────────────────
  // Each group has already blended its own competing exposure views into one
  // net loss cost, WITHOUT loads or a gross-up. Summing money is the only
  // sound way to combine them: a cargo rate per mille of turnover and a
  // property rate per mille of values are not addable as rates.
  const totalExposureLossCost = priced.reduce((t, g) => t + num(g.lossCost), 0);
  // A scaling constant, not a meaningful exposure: it is the denominator both
  // the exposure and experience candidates are expressed against so the blend
  // compares like with like, and it turns the answer back into money.
  const commonBase = priced.reduce((t, g) => t + num(g.premiumBase), 0);

  const riskCandidates = [
    toCandidate('SECTION_TOTAL', commonBase > 0 ? {
      available: true,
      lossCost: totalExposureLossCost,
      ratePm: (totalExposureLossCost / commonBase) * 1000,
      diagnostics: {
        section_count: sections?.length ?? 0,
        group_count: priced.length,
        groups: priced.map((g) => ({
          family: g.family.code,
          loss_cost: g.lossCost,
          premium_base: g.premiumBase,
        })),
      },
    } : {
      available: false,
      unavailableReason: 'None of this risk\'s sections carries a premium base to rate '
        + 'against, so the section total cannot be expressed as a rate.',
      diagnostics: {},
    }),
    toCandidate('BURNING_COST', commonBase > 0 && experience.available ? {
      ...experience,
      // Re-expressed against the same denominator as the exposure candidate.
      // Its own ‰ is per mille of its own exposure basis, which is a
      // different quantity and would not blend.
      ratePm: (num(experience.lossCost) / commonBase) * 1000,
    } : experience),
    toCandidate('BENCHMARK', benchmarkLossCost({
      observations: benchmarks, scope: benchmarkScope,
    })),
  ];

  // Credibility comes from the family carrying the most exposure. A risk that
  // is 90% property and 10% liability should not have its experience credited
  // on casualty's cap.
  const dominant = priced.reduce(
    (best, g) => (num(g.premiumBase) > num(best.premiumBase) ? g : best), priced[0],
  );

  const technical = buildTechnicalPremium({
    candidates: riskCandidates,
    credibility: dominant.family.credibility,
    weightOverride,
    ...pipelineLoads(loads, inputs),
    exposureTotal: commonBase,
  });

  if (technical?.priced) {
    technical.multiSection = true;
    technical.credibilityFamily = dominant.family.code;
    technical.warnings = [
      ...(technical.warnings || []),
      `This risk is priced across ${priced.length} rating families `
      + `(${priced.map((g) => g.family.code).join(', ')}). The premium is the sum of the `
      + 'sections; the rate below is per mille of their combined bases, which is a scaling '
      + 'figure rather than a rate any one section is quoted at.',
      `Credibility uses ${dominant.family.label}, the family carrying the most exposure.`,
    ];
  }

  return {
    ...base,
    technical,
    section: priced[0].sections[0] || null,
    sections: priced.map((g) => sectionSummary(g, null)),
  };
}

/** The load and gross-up arguments, identical in both paths. */
function pipelineLoads(loads, inputs) {
  return {
    catLoadPm: numOrNull(loads.catLoadPm) ?? 0,
    riskLoadTheta: numOrNull(loads.riskLoadTheta) ?? undefined,
    riskLoadPct: numOrNull(loads.riskLoadPct) ?? 0,
    internalExpensePct: numOrNull(loads.internalExpensePct) ?? 0,
    commissionPct: numOrNull(inputs.commission_pct) ?? 0,
    brokeragePct: numOrNull(inputs.brokerage_pct) ?? 0,
    taxPct: numOrNull(inputs.tax_pct) ?? 0,
    marginPct: (numOrNull(inputs.margin_pct) ?? 0) + (numOrNull(inputs.other_expenses_pct) ?? 0),
  };
}

/**
 * Price one family's sections.
 *
 * Returns the group's candidates and, where the group needs to be combined
 * with others, its blended NET loss cost in money — net because the loads and
 * the gross-up happen once, at risk level, however many groups there are.
 *
 * @param {object} args
 * @returns {object}
 */
function priceSectionGroup({
  group, risk, cob, structure, inputs, referenceData, engine, locations,
  riskExposure, rates, curveBands, losses,
}) {
  const { family, sections } = group;
  // The group's own exposure profile. A property section inside a two-family
  // risk is rated on its own values, not on the whole risk's.
  const exposure = sections.length > 0 && sections !== undefined
    ? buildExposureProfile({ risk, sections, locations })
    : riskExposure;
  const premiumBase = premiumBaseFor(family, { exposure, sections, risk });

  const sectionIds = new Set(sections.map((s) => s.section_id).filter(Boolean));
  const groupLosses = (losses || []).filter((l) => l.section_id && sectionIds.has(l.section_id));

  const raw = typeof family.computeCandidates === 'function'
    ? family.computeCandidates({
      risk, cob, section: sections[0] || null, sections, structure, exposure, inputs,
      referenceData, engine, rates: { ...rates, curveBands },
    })
    : [];
  const candidates = raw.map((c) => toCandidate(c.code, c.result));

  // Losses attributed to this group's sections are this group's experience.
  if (groupLosses.length > 0) {
    candidates.push(toCandidate('BURNING_COST', burningCostLossCost({
      losses: groupLosses,
      basis: [],
      severityTrendPct: numOrNull(risk?.severity_trend_pct) ?? 0,
      asOfYear: numOrNull(risk?.uw_year) ?? undefined,
      attachment: structure.attachment,
      limit: structure.limit,
      fallbackExposure: premiumBase,
      fallbackYears: numOrNull(risk?.experience_years) ?? 0,
    })));
  }

  // Blend the group's competing views into one loss cost, with no loads and
  // no gross-up. Those belong to the risk, once.
  const blended = buildTechnicalPremium({
    candidates,
    credibility: family.credibility,
    exposureTotal: premiumBase,
  });

  return {
    family,
    sections,
    exposure,
    premiumBase,
    candidates,
    blended,
    lossCost: blended.priced ? (blended.premiums?.expectedLoss ?? 0) : 0,
  };
}

/** What the screen and the audit trail need to see per section group. */
function sectionSummary(group, technical) {
  return {
    family: group.family.code,
    family_label: group.family.label,
    rating_basis: group.family.ratingBasis,
    section_nos: group.sections.map((s) => numOrNull(s.section_no)).filter((n) => n !== null),
    section_ids: group.sections.map((s) => s.section_id).filter(Boolean),
    premium_base: group.premiumBase,
    loss_cost: group.lossCost,
    rate_pm: group.premiumBase > 0 ? (group.lossCost / group.premiumBase) * 1000 : null,
    candidates: group.candidates,
    technical: technical || group.blended,
  };
}

export { technicalAdequacy as facTechnicalAdequacy };
