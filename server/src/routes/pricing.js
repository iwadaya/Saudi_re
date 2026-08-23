import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import { loadTreatyCategory, requireTreatyCategory, assertBodyCategoryMatches } from '../lib/treatyCategoryGuard.js';
import {
  pricingOutputsPutSchema,
  pricingYearlyPutSchema,
  compositePricingSaveSchema,
  straightStatsSaveSchema,
} from '../validation/pricing.js';
import {
  getTreatyPricingController,
  getPricingOutputsController,
  putPricingOutputsController,
  getPricingYearlyController,
  putPricingYearlyController,
  saveCompositePricingController,
  saveStraightStatsController,
  loadStraightStatsController,
  getOfferController,
  saveOfferController,
  declineTreatyController,
  submitForApprovalController,
  peerDecisionController,
  arbiterDecisionController,
  approvalStateController,
  eligibleApproversController,
  offerPermissionsController,
  arbiterOptionsController,
  markApprovedController,
  returnToUnderwriterController,
  approvalTrailController,
  recallOfferController,
  markSignedController,
  markNtuController,
  countryAggregatesController,
  aggCobBreakdownController,
  aggDrilldownController,
  marketAverageController,
  createComponentSnapshotController,
  listComponentSnapshotsController,
  deleteComponentSnapshotController,
} from '../modules/pricing/controllers/pricingController.js';
import {
  listGemCurvesController,
  getGemScenarioController,
  computeGemEqLossController,
} from '../modules/gemVulnerability/gemVulnerabilityController.js';

import { assertCanEdit } from '../services/permissions.js';

const router = Router();

// Edit-lock middleware: gate a contract mutation on ownership before the
// controller runs. `idFrom` extracts the contract id from the request.
const lockContract = (idFrom) => asyncHandler(async (req, _res, next) => {
  const id = idFrom(req);
  if (id) await assertCanEdit(req, 'CONTRACT', id);
  next();
});
const contractIdFromBody = (req) => req.body?.contractId || req.body?.contract_id || null;

router.get('/treaties/:id/pricing', asyncHandler(getTreatyPricingController));
router.get('/treaties/:id/pricing-outputs', asyncHandler(getPricingOutputsController));
router.put('/treaties/:id/pricing-outputs', validateBody(pricingOutputsPutSchema), asyncHandler(putPricingOutputsController));
router.get('/treaties/:id/pricing-yearly', asyncHandler(getPricingYearlyController));
router.put('/treaties/:id/pricing-yearly', validateBody(pricingYearlyPutSchema), asyncHandler(putPricingYearlyController));
router.post('/pricing/save', validateBody(compositePricingSaveSchema), lockContract(contractIdFromBody), asyncHandler(saveCompositePricingController));

// Straight-line UW statistics are a proportional-only pricing input; fence
// these so an NP treaty can't write/read them (the id is in the body on save).
router.post('/straight-stats/save', validateBody(straightStatsSaveSchema), loadTreatyCategory, requireTreatyCategory('PROPORTIONAL'), lockContract(contractIdFromBody), asyncHandler(saveStraightStatsController));
router.get('/straight-stats/load/:id', loadTreatyCategory, requireTreatyCategory('PROPORTIONAL'), asyncHandler(loadStraightStatsController));

// Offer/approval endpoints work for both prop and NP treaties, but
// every mutation runs through loadTreatyCategory + assertBodyCategoryMatches
// so (a) the contract id is verified to exist before any work and
// (b) clients that double-check the type by sending treaty_category
// in the body will get a 409 on mismatch instead of silently approving
// the wrong contract.
router.get('/treaties/:id/offer', asyncHandler(getOfferController));
router.post('/treaties/:id/offer', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(saveOfferController));
router.post('/treaties/:id/decline', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(declineTreatyController));
router.post('/treaties/:id/offer/submit-for-approval', lockContract((req) => req.params.id), loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(submitForApprovalController));
router.post('/treaties/:id/offer/peer-decision', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(peerDecisionController));
router.post('/treaties/:id/offer/arbiter-decision', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(arbiterDecisionController));
router.get('/treaties/:id/offer/approval-state', asyncHandler(approvalStateController));
router.get('/treaties/:id/offer/eligible-approvers', asyncHandler(eligibleApproversController));
router.get('/treaties/:id/offer/permissions', asyncHandler(offerPermissionsController));
router.get('/treaties/:id/offer/arbiter-options', asyncHandler(arbiterOptionsController));
router.post('/treaties/:id/offer/mark-approved', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(markApprovedController));
router.post('/treaties/:id/offer/return-to-underwriter', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(returnToUnderwriterController));
router.get('/treaties/:id/approval-trail', asyncHandler(approvalTrailController));
router.post('/treaties/:id/offer/recall', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(recallOfferController));
router.post('/treaties/:id/offer/mark-signed', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(markSignedController));
router.post('/treaties/:id/offer/ntu', loadTreatyCategory, assertBodyCategoryMatches, asyncHandler(markNtuController));

router.get('/aggregates/country/:countryId', asyncHandler(countryAggregatesController));
router.get('/pricing/agg-cob-breakdown/:contractId', asyncHandler(aggCobBreakdownController));
router.get('/pricing/agg-drilldown/:contractId', asyncHandler(aggDrilldownController));
router.get('/pricing/market-average/:countryId', asyncHandler(marketAverageController));
router.post('/pricing/:id/component-snapshot', asyncHandler(createComponentSnapshotController));
router.get('/pricing/:id/component-snapshots', asyncHandler(listComponentSnapshotsController));
router.delete('/pricing/component-snapshot/:snapId', asyncHandler(deleteComponentSnapshotController));

// GEM deterministic EQ exposure rating (Tier-B damage ratios).
router.get('/pricing/gem/curves', asyncHandler(listGemCurvesController));
router.get('/pricing/gem/:contractId/scenario', asyncHandler(getGemScenarioController));
router.post('/pricing/gem/:contractId/compute', asyncHandler(computeGemEqLossController));

export default router;
