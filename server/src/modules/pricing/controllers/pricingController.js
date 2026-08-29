import {
  getTreatyPricing,
  getPricingOutputs,
  upsertPricingOutputs,
  getPricingYearly,
  replacePricingYearly,
  saveCompositePricing,
  saveStraightStats,
  loadStraightStats,
  getOffer,
  getCountryAggregates,
  getAggCobBreakdown,
  getAggDrilldown,
  getMarketAverage,
  createComponentSnapshot,
  listComponentSnapshots,
  getComponentSnapshotById,
  deleteComponentSnapshot,
} from '../repositories/pricingRepository.js';
import {
  saveOfferAction,
  declineTreatyAction,
  submitForApprovalAction,
  peerDecisionAction,
  arbiterDecisionAction,
  getApprovalStateAction,
  getEligibleApproversAction,
  getArbiterOptionsAction,
  markApprovedAction,
  returnToUnderwriterAction,
  getApprovalTrailAction,
  recallOfferAction,
  markSignedAction,
  markNtuAction,
  getOfferPermissionsAction,
} from '../services/pricingWorkflowService.js';
import { resolveActor } from '../services/pricingHelpers.js';
import { assertCanEdit } from '../../../services/permissions.js';
import { logger } from '../../../lib/logger.js';
import { verifyNpPricingOutputs, summariseDrifts, isStrictMode, pricingDriftStats } from '../../../lib/pricingVerifier.js';
import { recordPricingDrift } from '../../../observability/businessMetrics.js';

export async function getTreatyPricingController(req, res) {
  res.json(await getTreatyPricing(req.params.id));
}

export async function getPricingOutputsController(req, res) {
  res.json(await getPricingOutputs(req.params.id));
}

export async function putPricingOutputsController(req, res) {
  // Same opt-in stale-write guard as POST /pricing/save: a stale
  // If-Unmodified-Since token → 409 STALE_WRITE (see optimisticLock.js).
  const updatedAt = await upsertPricingOutputs(req.params.id, req.body, {
    ifUnmodifiedSince: req.headers['if-unmodified-since'],
  });
  res.json({ ok: true, updated_at: updatedAt });
}

export async function getPricingYearlyController(req, res) {
  res.json(await getPricingYearly(req.params.id));
}

export async function putPricingYearlyController(req, res) {
  // Delete-then-reinsert of ALL yearly rows — guarded like the composite save
  // so a stale tab can't silently wipe another underwriter's projections.
  const updatedAt = await replacePricingYearly(req.params.id, req.body.rows ?? [], {
    ifUnmodifiedSince: req.headers['if-unmodified-since'],
  });
  res.json({ ok: true, updated_at: updatedAt });
}

export async function saveCompositePricingController(req, res) {
  const { contractId, contract_id, outputs, yearly, components, leads, share_scenarios, comment } = req.body;
  const id = contractId || contract_id;
  if (!id) return res.status(400).json({ error: 'contractId required' });

  // NP pricing rows land in `outputs` as an array of {layer_number,
  // section, ...}. Prop composites send a differently-shaped outputs
  // object and the verifier safely returns [] for it.
  const drifts = verifyNpPricingOutputs(outputs);
  res.setHeader('X-Pricing-Drift-Count', String(drifts.length));
  const driftStats = pricingDriftStats(drifts);
  recordPricingDrift({ endpoint: 'treaty_pricing', stats: driftStats, strict: isStrictMode() });
  const driftLog = {
    requestId: res.locals.requestId || req.id || null,
    endpoint: 'treaty_pricing',
    route: 'POST /api/pricing/save',
    parentType: 'contract',
    contractId: id,
    ...driftStats,
    summary: summariseDrifts(drifts),
    ...(drifts.length > 0 ? { drifts: drifts.slice(0, 10) } : {}),
  };
  if (drifts.length > 0) {
    logger.warn('pricing drift check', driftLog);
    if (isStrictMode()) {
      return res.status(422).json({
        error: 'Pricing outputs failed server-side spot check',
        code:  'PRICING_DRIFT',
        requestId: res.locals.requestId || req.id || null,
        drifts,
      });
    }
  } else {
    logger.info('pricing drift check', driftLog);
  }

  const result = await saveCompositePricing({
    contractId: id,
    outputs,
    yearly,
    components,
    leads,
    share_scenarios,
    comment,
    ifUnmodifiedSince: req.headers['if-unmodified-since'],
    actor: await resolveActor(req), // "who modelled" — verified identity for the PRICED audit
  });
  res.json({ ok: true, updated_at: result?.updated_at || null });
}

export async function saveStraightStatsController(req, res) {
  const { contractId, contract_id, tailType, tail_type, stats = [] } = req.body;
  const id = contractId || contract_id;
  if (!id) return res.status(400).json({ error: 'contractId required' });
  await saveStraightStats({ contractId: id, tailType: tailType || tail_type || 'SHORT_TAIL', stats });
  res.json({ ok: true });
}

export async function loadStraightStatsController(req, res) {
  res.json(await loadStraightStats(req.params.id));
}

export async function getOfferController(req, res) {
  res.json(await getOffer(req.params.id));
}

export async function saveOfferController(req, res) {
  const id = req.params.id;
  const offer = req.body.offer ?? req.body;
  const actor = await resolveActor(req);
  res.json(await saveOfferAction(id, offer, actor));
}

export async function declineTreatyController(req, res) {
  const id = req.params.id;
  const { reason } = req.body;
  const actor = await resolveActor(req);
  await declineTreatyAction(id, actor, reason);
  res.json({ ok: true });
}

export async function submitForApprovalController(req, res) {
  const id = req.params.id;
  const actor = await resolveActor(req);
  const result = await submitForApprovalAction(id, actor, req.body);
  res.json({ ok: true, ...result });
}

export async function peerDecisionController(req, res) {
  const { decision, comment } = req.body;
  if (!['APPROVED', 'DECLINED'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be APPROVED or DECLINED' });
  }
  const actor = await resolveActor(req);
  const result = await peerDecisionAction(req.params.id, actor, decision, comment);
  res.json({ ok: true, ...result });
}

export async function arbiterDecisionController(req, res) {
  const { decision, comment } = req.body;
  const actor = await resolveActor(req);
  const result = await arbiterDecisionAction(req.params.id, actor, decision, comment);
  res.json({ ok: true, ...result });
}

export async function approvalStateController(req, res) {
  const state = await getApprovalStateAction(req.params.id);
  res.json(state || {});
}

export async function eligibleApproversController(req, res) {
  const submitterUserId = req.user?.userId;
  const { breach_type, epi_usd } = req.query;
  res.json(await getEligibleApproversAction({ submitterUserId, breachType: breach_type, epiUsd: epi_usd }));
}

export async function arbiterOptionsController(req, res) {
  res.json(await getArbiterOptionsAction(req.params.id));
}

export async function offerPermissionsController(req, res) {
  const actor = await resolveActor(req);
  res.json(await getOfferPermissionsAction(req.params.id, actor));
}

export async function markApprovedController(req, res) {
  const id = req.params.id;
  const actor = await resolveActor(req);
  const result = await markApprovedAction(id, actor, req.body);
  res.json({ ok: true, ...result });
}

export async function returnToUnderwriterController(req, res) {
  const id = req.params.id;
  const reason = req.body.reason || req.body.comment || '';
  const actor = await resolveActor(req);
  await returnToUnderwriterAction(id, actor, reason);
  res.json({ ok: true });
}

export async function approvalTrailController(req, res) {
  res.json(await getApprovalTrailAction(req.params.id));
}

export async function recallOfferController(req, res) {
  const id = req.params.id;
  const reason = req.body.reason || 'Recalled by underwriter';
  const actor = await resolveActor(req);
  const result = await recallOfferAction(id, actor, reason);
  res.json({ ok: true, ...result });
}

export async function markSignedController(req, res) {
  const id = req.params.id;
  const actor = await resolveActor(req);
  await markSignedAction(id, actor, req.body.signed_line_pct);
  res.json({ ok: true });
}

export async function markNtuController(req, res) {
  const id = req.params.id;
  const { reason } = req.body;
  const actor = await resolveActor(req);
  await markNtuAction(id, actor, reason);
  res.json({ ok: true });
}

export async function countryAggregatesController(req, res) {
  // A DB failure must surface as an error (asyncHandler → errorHandler → 5xx),
  // NOT as a 200 with zeros: 0 here reads as "no other exposure in this
  // country" and silently understates accumulation exactly when the DB is
  // unhealthy. A country with no aggregate rows legitimately returns zeros via
  // the null-coalescing below — that is the only soft-fallback kept.
  const row = await getCountryAggregates(req.params.countryId, req.query.excludeContractId);
  res.json({
    total_agg: row?.weighted_country_agg ?? 0,
    total_country_agg: row?.total_country_agg ?? 0,
    weighted_country_agg: row?.weighted_country_agg ?? 0,
  });
}

export async function aggCobBreakdownController(req, res) {
  res.json(await getAggCobBreakdown(req.params.contractId));
}

export async function aggDrilldownController(req, res) {
  try {
    const result = await getAggDrilldown(req.params.contractId);
    if (!result) return res.status(404).json({ error: 'Contract not found' });
    res.json(result);
  } catch (error) {
    logger.error('[agg-drilldown] error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
}

export async function marketAverageController(req, res) {
  const result = await getMarketAverage(req.params.countryId, req.query.exclude || null, {
    treatyTypeId: req.query.treatyTypeId || null,
    cobIds: req.query.cobIds ? req.query.cobIds.split(',').filter(Boolean) : [],
    region: req.query.region || null,
  });
  // { components: { [name]: avgValue }, tier, contractCount }
  res.json(result);
}

export async function createComponentSnapshotController(req, res) {
  const { label, components } = req.body;
  // Attribution comes from the VERIFIED actor (pricingHelpers.js rule), never
  // from a client-supplied created_by, which would be forgeable.
  const actor = await resolveActor(req);
  const createdBy = actor.actorUserId
    ? (actor.actorName && actor.actorName !== 'SYSTEM' ? actor.actorName : actor.actorUserId)
    : null;
  res.json(await createComponentSnapshot(req.params.id, label, components, createdBy));
}

export async function listComponentSnapshotsController(req, res) {
  res.json(await listComponentSnapshots(req.params.id));
}

export async function deleteComponentSnapshotController(req, res) {
  // Snapshot ids are a guessable integer sequence, so resolve the owning
  // contract FIRST, take the assignee edit-lock on it, and run the DELETE
  // scoped to (id, contract_id). guardApiMutations already resolves + locks
  // this path app-side; enforcing it here keeps the guarantee if the route is
  // ever mounted without the app guard, and turns an unknown id into a 404
  // instead of a silent no-op 200.
  const snapId = Number(req.params.snapId);
  if (!Number.isInteger(snapId)) return res.status(404).json({ error: 'Snapshot not found' });
  const snapshot = await getComponentSnapshotById(snapId);
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  await assertCanEdit(req, 'CONTRACT', snapshot.contract_id);
  await deleteComponentSnapshot(snapshot.id, snapshot.contract_id);
  res.json({ ok: true });
}
