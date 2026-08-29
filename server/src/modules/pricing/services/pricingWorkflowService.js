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
  markNotTakenUp,
  recallOffer,
  getTerminalPermissions,
  getUserMandate,
  getRequiredApproverRole,
  getRoleLevel,
} from '../../../services/approvals.js';
import { logAudit } from '../../../services/audit.js';
import { withTransaction } from '../../../db/withTransaction.js';
import {
  replaceOffer,
  markDeclined,
  getLegacyApprovalTrail,
  insertApprovalEvent,
} from '../repositories/pricingRepository.js';
import { parseOfferLinePct, parseSignedLinePct } from './pricingHelpers.js';

export async function saveOfferAction(contractId, offer, actor) {
  // OFFERED: the offer rows, the contract status flip and the (critical) audit
  // commit together — a failed audit rolls the whole offer back.
  return withTransaction(async (client) => {
    const saved = await replaceOffer(contractId, offer, client);
    await logAudit(client, { entityType: 'CONTRACT', entityId: contractId, eventType: 'OFFERED', actor }, { critical: true });
    return saved;
  });
}

export async function declineTreatyAction(contractId, actor, reason) {
  // DECLINED is terminal (statusMachine: no outbound edges), so it takes the
  // same authority rule as NTU — the other "kill it" terminal action: the
  // contract's assignee (owner) OR a live eligible approver for its offer.
  // Enforced with the approval service's own primitives (getTerminalPermissions
  // wraps loadTerminalContext + isEligibleContractApprover) so this can never
  // drift from what the engine's other terminal actions accept (F22/F29).
  const perms = await getTerminalPermissions({
    entityType: 'CONTRACT',
    entityId: contractId,
    actorUserId: actor?.actorUserId || null,
    actorRole: actor?.actorRole || null,
  });
  // can_ntu is exactly "assignee OR eligible approver" (approvals.js).
  if (!perms.can_ntu) {
    const err = new Error('Not authorised to decline this treaty — only the assignee or an eligible approver may decline it.');
    err.status = 403;
    err.code = 'DECLINE_FORBIDDEN';
    throw err;
  }
  // DECLINED: status change, offer_approval_event and the (critical) audit row
  // are one atomic unit.
  await withTransaction(async (client) => {
    await markDeclined(contractId, reason, client, actor);
    await logAudit(client, { entityType: 'CONTRACT', entityId: contractId, eventType: 'DECLINED', actor, payload: { reason }, comment: reason || null }, { critical: true });
    await insertApprovalEvent(contractId, 'DECLINED', actor, reason || null, client);
  });
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
  const list = await getEligibleApprovers({ submitterUserId, breachType, epiUsd });
  // The picker must only offer nominees submitForApproval will accept: filter
  // by the breach-tier approver role for THIS submitter, resolved against the
  // live uw_role hierarchy — the same rule (and the same source of truth) the
  // submit validation applies to a nominated peer. Candidates carry their live
  // hierarchy_level from v_user_mandate; a missing level falls back to the
  // role-code lookup.
  const submitter = await getUserMandate(submitterUserId);
  const submitterLevel = Number.isFinite(Number(submitter?.hierarchy_level)) ? Number(submitter.hierarchy_level) : 5;
  const requiredRole = getRequiredApproverRole(submitterLevel, breachType || 'NONE');
  const requiredLevel = await getRoleLevel(requiredRole);
  const out = [];
  for (const c of list) {
    const lvl = Number.isFinite(Number(c.hierarchy_level)) ? Number(c.hierarchy_level) : await getRoleLevel(c.role_code);
    if (lvl <= requiredLevel) out.push(c);
  }
  return out;
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
  // Authority (eligible approver/senior) + state are enforced inside the
  // approval service via assertWorkflowTransition; the DRAFT write lives there.
  return returnToUnderwriter({ contractId, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
}

export async function getApprovalTrailAction(contractId) {
  const events = await getOfferEvents(contractId, null).catch(() => []);
  if (events.length) return events.map((event) => ({ ...event, event_id: event.event_id, actor: event.actor_name }));
  return getLegacyApprovalTrail(contractId);
}

export async function recallOfferAction(contractId, actor, reason) {
  // Only the submitter may recall, and only while still pending — enforced by
  // the RECALL action inside the approval service, which also logs the event.
  return recallOffer({ contractId, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
}

export async function getOfferPermissionsAction(contractId, actor) {
  // Which terminal actions the verified actor may take on this contract's live
  // offer. Same primitives as the mutating endpoints (four-eyes included), so
  // the client can render exactly the controls the server will accept.
  return getTerminalPermissions({
    entityType: 'CONTRACT',
    entityId: contractId,
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
  });
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
  // NTU now funnels through the approval engine: assignee/eligible-senior
  // authority + legal prior state, with the NTU write + event in one place.
  return markNotTakenUp({ contractId, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, reason });
}
