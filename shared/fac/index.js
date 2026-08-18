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

import { buildExposureProfile } from './exposure.js';
import { familyForClass, pricingBlocker } from './registry.js';
import { burningCostLossCost } from './methods/burningCost.js';
import { exposureCurveLossCost } from './methods/exposureCurve.js';
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
 * @param {object} args
 * @param {object} args.risk               fac_risk row
 * @param {object|null} [args.cob]         its class-of-business row (carries rating_family)
 * @param {Array<object>} [args.sections]  fac_risk_section rows
 * @param {Array<object>} [args.locations] fac_location rows
 * @param {object} args.inputs             underwriter-controlled engine inputs
 * @param {object} args.referenceData      occupancies, factors, weights, scoring tables…
 * @returns {{ok: true, family: string, exposure: object, result: object}
 *          | {ok: false, family: string|null, blocker: object, exposure: object}}
 */
export function priceFacRisk({ risk, cob, sections, locations, inputs, referenceData }) {
  const family = familyForClass(cob);
  const exposure = buildExposureProfile({ risk, sections, locations });

  const blocker = pricingBlocker(family, risk);
  if (blocker) {
    return { ok: false, family: family?.code ?? null, blocker, exposure };
  }

  const result = family.computeQuote({ ...inputs, exposure }, referenceData);
  return { ok: true, family: family.code, exposure, result };
}

/**
 * Price a risk through the whole pipeline: every loss-cost method the
 * family supports, blended by credibility, then loaded and grossed up.
 *
 * `priceFacRisk` above stays the single-method path — the family engine and
 * nothing else. This is that plus the Phase 2 methods, and it degrades to
 * exactly the same answer when none of them have data: with the workbook
 * rate as the only candidate and no loads configured, the technical gross
 * rate equals the engine's own final gross rate. A risk with no loss
 * history and no curve prices today as it did yesterday.
 *
 * @param {object} args  everything priceFacRisk takes, plus:
 * @param {Array<object>} [args.losses]        fac_loss_history rows
 * @param {Array<object>} [args.experienceBasis] fac_experience_basis rows
 * @param {Array<object>} [args.curveBands]    [{minExposure, maxExposure, curve}]
 * @param {Array<object>} [args.benchmarks]    bound comparables [{rate_pm, uw_year}]
 * @param {string} [args.benchmarkScope]
 * @param {object} [args.loads]                {catLoadPm, riskLoadTheta, riskLoadPct, internalExpensePct}
 * @param {object} [args.weightOverride]       {weights, reasonCode}
 * @returns {object}
 */
export function priceFacRiskFull(args) {
  const base = priceFacRisk(args);
  if (!base.ok) return { ...base, technical: null };

  const {
    risk, inputs = {}, losses, experienceBasis, curveBands, benchmarks,
    benchmarkScope, loads = {}, weightOverride = null,
  } = args;
  const family = familyForClass(args.cob);
  const exposure = base.exposure;
  const engine = base.result;

  // The family engine's NET rate is the exposure-side candidate. It is net
  // by design: the gross-up belongs to the pipeline and happens once.
  const candidates = [
    toCandidate('WORKBOOK_RATE', { available: true, ratePm: engine.final_net_rate_pm }),
  ];

  // The structure being priced. A proportional placement is ground-up
  // unlimited; an XL placement takes its own attachment and limit.
  const attachment = numOrNull(risk?.np_retention) ?? 0;
  const limit = numOrNull(risk?.np_limit) ?? Infinity;
  const isNonProportional = risk?.placement_type === 'NON_PROPORTIONAL';

  candidates.push(toCandidate('BURNING_COST', burningCostLossCost({
    losses,
    basis: experienceBasis,
    severityTrendPct: numOrNull(risk?.severity_trend_pct) ?? 0,
    asOfYear: numOrNull(risk?.uw_year) ?? undefined,
    attachment: isNonProportional ? attachment : 0,
    limit: isNonProportional ? limit : Infinity,
    fallbackExposure: exposure.total_si,
    fallbackYears: numOrNull(risk?.experience_years) ?? 0,
  })));

  candidates.push(toCandidate('EXPOSURE_CURVE', exposureCurveLossCost({
    bands: buildCurveBands({ exposure, curveBands, engine }),
    attachment: isNonProportional ? attachment : 0,
    limit: isNonProportional ? limit : Infinity,
    exposureTotal: exposure.total_si,
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
    exposureTotal: exposure.total_si,
  });

  return { ...base, technical };
}

/**
 * Match each exposure band to the curve configured for its size, and give
 * it the ground-up burn rate the family engine derived.
 *
 * Bands come from the location schedule when there is one — that is what
 * "band the schedule by size" means — and from the whole risk otherwise.
 */
function buildCurveBands({ exposure, curveBands, engine }) {
  if (!Array.isArray(curveBands) || curveBands.length === 0) return [];
  const pick = (amount) => curveBands.find(
    (b) => amount >= (numOrNull(b.min_exposure) ?? 0)
      && (b.max_exposure == null || amount < numOrNull(b.max_exposure)),
  );
  // The engine's technical rate is the ground-up burn rate for the risk;
  // exposure rating says how it splits across the tower, not how big it is.
  const groundUpRatePm = numOrNull(engine.technical_rate_no_natcat_pm) ?? 0;
  const total = exposure.total_si;
  if (!(total > 0)) return [];
  const band = pick(total);
  if (!band?.curve) return [];
  return [{
    exposure: total,
    pmlPct: numOrNull(exposure.pml_pct) ?? 1,
    groundUpRatePm,
    curve: band.curve,
  }];
}

export { technicalAdequacy as facTechnicalAdequacy };
