// shared/fac/index.js
//
// Public entry point for the facultative pricing pipeline. Client screens
// and server routes both import from here so there is exactly one path
// from a risk to a price — which is what lets the server verify what the
// browser sent (see POST /api/fac/risks/:id/price).

export { buildExposureProfile } from './exposure.js';
export { num, numOrNull, isNum } from './num.js';

export { burningCostLossCost, restateLoss, DEFAULT_DEVELOPMENT_FACTOR } from './methods/burningCost.js';
export {
  exposureCurveLossCost, mbbefdCurve, tabulatedCurve, curveEvaluator,
  layerExpectedLoss, deductibleCredit,
} from './methods/exposureCurve.js';
export { benchmarkLossCost, benchmarkPosition, MIN_CONFIDENT_OBSERVATIONS } from './methods/benchmark.js';

export {
  credibilityFactor, mechanicalWeights, applyWeightOverride, blendRates,
  annualLossVolatility, OVERRIDE_REASONS, DEFAULT_CREDIBILITY,
} from './credibility.js';

export {
  toCandidate, buildTechnicalPremium, technicalAdequacy,
  METHOD_ROLE, METHOD_LABEL, DEFAULT_RISK_LOAD_THETA,
} from './pipeline.js';

export {
  getFamily,
  listFamilies,
  familyForClass,
  familiesForClasses,
  wizardStepsForFamilies,
  pricingBlocker,
  RATING_BASIS_LABEL,
  SEGMENT_LABEL,
  DEFAULT_FAMILY_CODE,
} from './registry.js';

export {
  computeRatePath,
  computeScoreAndDecision,
  computePremiums,
  computeFacQuote,
  SCORE_COMPLETENESS_MIN,
} from './families/scheduleProperty.js';

export {
  alphaFromDoublingLoading, doublingLoadingFromAlpha, ilfEvaluator,
  ilfLayerLossCost, claimsMadeStepFactor, ilfLossCost,
} from './methods/ilfCurve.js';

export {
  rateOnLine, paybackYears, layerPremium, reinstatementPremium,
  totalCover, freeCover, priceTower,
} from './layers.js';

import { buildExposureProfile } from './exposure.js';
import { familyForClass, pricingBlocker } from './registry.js';
import { burningCostLossCost } from './methods/burningCost.js';
import { benchmarkLossCost } from './methods/benchmark.js';
import { toCandidate, buildTechnicalPremium, technicalAdequacy } from './pipeline.js';
import { numOrNull } from './num.js';

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
 * Pick the section this family prices.
 *
 * A risk can carry sections in more than one family — a plant with a
 * property section and a liability section is ordinary. Pricing every
 * section and summing them is a larger change than Phase 3 takes on, so
 * this prices the risk's primary section for its own family and says
 * plainly when it has left others out, rather than silently pricing one
 * section and presenting the answer as the whole risk.
 *
 * @param {Array<object>} sections
 * @param {string} familyCode
 * @returns {{section: object|null, skipped: Array<object>}}
 */
function sectionForFamily(sections, familyCode) {
  const list = (sections || []).slice().sort(
    (a, b) => (numOrNull(a.section_no) ?? 0) - (numOrNull(b.section_no) ?? 0),
  );
  const own = list.filter((sec) => !sec.rating_family || sec.rating_family === familyCode);
  const section = own[0] || list[0] || null;
  const skipped = list.filter((sec) => sec !== section);
  return { section, skipped };
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
  } = args;
  const family = familyForClass(args.cob);
  const exposure = base.exposure;
  const engine = base.result;

  // The structure being priced. A proportional placement is ground-up
  // unlimited; an XL placement takes its own attachment and limit.
  const isNonProportional = risk?.placement_type === 'NON_PROPORTIONAL';
  const attachment = isNonProportional ? (numOrNull(risk?.np_retention) ?? 0) : 0;
  const limit = isNonProportional ? (numOrNull(risk?.np_limit) ?? Infinity) : Infinity;
  const structure = { attachment, limit, isNonProportional };

  const { section, skipped } = sectionForFamily(sections, family.code);

  // ── Family candidates ────────────────────────────────────────────
  const familyCandidates = typeof family.computeCandidates === 'function'
    ? family.computeCandidates({
      risk, cob: args.cob, section, sections, structure, exposure, inputs,
      referenceData, engine, rates: { ...rates, curveBands },
    })
    : [];
  const candidates = familyCandidates.map((c) => toCandidate(c.code, c.result));

  // ── Family-agnostic candidates ───────────────────────────────────
  candidates.push(toCandidate('BURNING_COST', burningCostLossCost({
    losses,
    basis: experienceBasis,
    severityTrendPct: numOrNull(risk?.severity_trend_pct) ?? 0,
    asOfYear: numOrNull(risk?.uw_year) ?? undefined,
    attachment,
    limit,
    fallbackExposure: exposure.total_si,
    fallbackYears: numOrNull(risk?.experience_years) ?? 0,
  })));

  candidates.push(toCandidate('BENCHMARK', benchmarkLossCost({
    observations: benchmarks, scope: benchmarkScope,
  })));

  const technical = buildTechnicalPremium({
    candidates,
    credibility: family.credibility,
    weightOverride,
    catLoadPm: numOrNull(loads.catLoadPm) ?? 0,
    riskLoadTheta: numOrNull(loads.riskLoadTheta) ?? undefined,
    riskLoadPct: numOrNull(loads.riskLoadPct) ?? 0,
    internalExpensePct: numOrNull(loads.internalExpensePct) ?? 0,
    commissionPct: numOrNull(inputs.commission_pct) ?? 0,
    brokeragePct: numOrNull(inputs.brokerage_pct) ?? 0,
    taxPct: numOrNull(inputs.tax_pct) ?? 0,
    marginPct: (numOrNull(inputs.margin_pct) ?? 0) + (numOrNull(inputs.other_expenses_pct) ?? 0),
    exposureTotal: exposureTotalFor(family, exposure, section),
  });

  if (technical && skipped.length > 0) {
    technical.warnings = [
      ...(technical.warnings || []),
      `This risk has ${skipped.length} further section(s) — ${skipped.map(
        (sec) => sec.rating_family || `section ${sec.section_no}`,
      ).join(', ')} — which are not in this price. Price them separately.`,
    ];
  }

  return { ...base, technical, section: section || null };
}

/**
 * What the rate is per mille OF.
 *
 * Property and hull rate against values, so the sum insured turns ‰ into
 * money. Cargo rates against annual turnover and casualty against turnover,
 * payroll or fee income — using a sum insured there would produce a premium
 * that is wrong by whatever ratio the two happen to sit in.
 *
 * @param {object} family
 * @param {object} exposure
 * @param {object|null} section
 * @returns {number}
 */
function exposureTotalFor(family, exposure, section) {
  if (family.ratingBasis === 'TURNOVER' || family.ratingBasis === 'LIMIT_ILF') {
    return numOrNull(section?.exposure_base)
      ?? numOrNull(section?.exposure_detail?.exposure_base)
      ?? 0;
  }
  return numOrNull(exposure?.total_si) ?? 0;
}

export { technicalAdequacy as facTechnicalAdequacy };
