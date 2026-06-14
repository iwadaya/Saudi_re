import {
  submitForApproval,
  recordPeerDecision,
  recordArbiterDecision,
  returnToUnderwriter,
  getApprovalState,
  getOfferEvents,
  getEligibleApprovers,
  getArbiterOptions,
  approveContract,
  markContractSigned,
} from '../../../services/approvals.js';
import { logAudit } from '../../../services/audit.js';
import { pool } from '../../../db/pool.js';
import {
  replaceOffer,
  markDeclined,
  forceDraftStatus,
  getLegacyApprovalTrail,
  recallOffer,
  markNtu,
  insertApprovalEvent,
} from '../repositories/pricingRepository.js';
import { parseOfferLinePct, parseSignedLinePct } from './pricingHelpers.js';

export async function saveOfferAction(contractId, offer) {
  const saved = await replaceOffer(contractId, offer);
  await logAudit(pool, { entityType: 'CONTRACT', entityId: contractId, eventType: 'OFFERED', actor: offer._actor || 'SYSTEM' });
  return saved;
}

export async function declineTreatyAction(contractId, actor, reason) {
  await markDeclined(contractId, reason);
  await logAudit(pool, { entityType: 'CONTRACT', entityId: contractId, eventType: 'DECLINED', actor: actor.actorName, payload: { reason }, comment: reason || null });
  await insertApprovalEvent(contractId, 'DECLINED', actor, reason || null);
}

export async function submitForApprovalAction(contractId, actor, payload) {
  const { line_pct, written_line_pct, peer1_user_id, breach_type, epi_usd, comment } = payload;
  return submitForApproval({
    contractId,
    submittedByUserId: actor.actorUserId,
    submittedByName: actor.actorName,
    submittedByRole: actor.actorRole,
    epiUsd: epi_usd || null,
    peer1UserId: peer1_user_id || null,
    breachType: breach_type || null,
    writtenLinePct: parseOfferLinePct({ line_pct, written_line_pct }),
    comment: comment || null,
  });
}

export async function peerDecisionAction(contractId, actor, decision, comment) {
  return recordPeerDecision({
    contractId,
    decidedByUserId: actor.actorUserId,
    decidedByName: actor.actorName,
    decidedByRole: actor.actorRole,
    decision,
    comment,
  });
}

export async function arbiterDecisionAction(contractId, actor, decision, comment) {
  return recordArbiterDecision({
    contractId,
    decidedByUserId: actor.actorUserId,
    decidedByName: actor.actorName,
    decidedByRole: actor.actorRole,
    decision,
    comment,
  });
}

export async function getApprovalStateAction(contractId) {
  return getApprovalState(contractId, null);
}

export async function getEligibleApproversAction({ submitterUserId, breachType, epiUsd }) {
  return getEligibleApprovers({ submitterUserId, breachType, epiUsd });
}

export async function getArbiterOptionsAction(contractId) {
  return getArbiterOptions(contractId, null);
}

export async function markApprovedAction(contractId, actor, { comment, line_pct }) {
  // Routes through the decision engine: enforces approver eligibility + four-eyes
  // and only the engine writes the approved state. No direct uw_status write.
  return approveContract({
    contractId,
    actorUserId: actor.actorUserId,
    actorName: actor.actorName,
    actorRole: actor.actorRole,
    comment: comment || null,
    linePct: line_pct ?? null,
  });
}

export async function returnToUnderwriterAction(contractId, actor, reason) {
  await returnToUnderwriter({ contractId, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
  await forceDraftStatus(contractId);
}

export async function getApprovalTrailAction(contractId) {
  const events = await getOfferEvents(contractId, null).catch(() => []);
  if (events.length) return events.map((event) => ({ ...event, event_id: event.event_id, actor: event.actor_name }));
  return getLegacyApprovalTrail(contractId);
}

export async function recallOfferAction(contractId, actor, reason) {
  await recallOffer(contractId, { ...actor, comment: reason });
  await logAudit(pool, { entityType: 'CONTRACT', entityId: contractId, eventType: 'RECALLED', actor: actor.actorName, payload: { reason } });
  return { nextStatus: 'DRAFT' };
}

export async function markSignedAction(contractId, actor, signedLinePct) {
  // SIGNED is gated by assertWorkflowTransition inside the approval service.
  await markContractSigned({
    contractId,
    actorUserId: actor.actorUserId,
    actorName: actor.actorName,
    actorRole: actor.actorRole,
    signedLinePct: parseSignedLinePct(signedLinePct),
  });
}

export async function markNtuAction(contractId, actor, reason) {
  await markNtu(contractId, reason);
  await logAudit(pool, { entityType: 'CONTRACT', entityId: contractId, eventType: 'NTU', actor: actor.actorName, payload: { reason } });
  await insertApprovalEvent(contractId, 'NTU', actor, reason || null);
}
