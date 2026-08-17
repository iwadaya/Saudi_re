// shared/fac/index.js
//
// Public entry point for the facultative pricing pipeline. Client screens
// and server routes both import from here so there is exactly one path
// from a risk to a price — which is what lets the server verify what the
// browser sent (see POST /api/fac/risks/:id/price).

export { buildExposureProfile } from './exposure.js';

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
