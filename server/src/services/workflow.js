// server/src/services/workflow.js
// The single low-level writer of contract.uw_status.
//
// Before this, the uw_status lifecycle was spread across the approval service +
// pricingOfferRepository, each statement assuming the caller knew the legal
// pre-state and none recording WHY the state moved. changeUwStatus collapses that
// into one chokepoint so a transition can never happen without (a) being legal and
// (b) leaving a contract_workflow_event + a critical STATUS_CHANGED audit row.
//
// It is transaction-first: the status write, the workflow event and the audit row
// MUST commit or roll back together, so the caller passes the SAME pg client it
// opened the transaction on (db/withTransaction.js) — a critical audit on a
// separate connection escapes the rollback guarantee (see audit.js).

import { logAudit } from './audit.js';
import { UW_STATUSES, assertLegalTransition } from '../lib/statusMachine.js';

const up = (s) => String(s ?? '').toUpperCase();

// The `status` mirror is the contract_status enum — overlapping but NOT equal to
// uw_workflow_status. Transient engine states (DISPUTE_PENDING / RETURNED) and
// APPROVED exist on uw_workflow_status but NOT on contract_status, so we only
// mirror the values valid on both (matching the prior behaviour where the engine
// wrote uw_status alone for DISPUTE_PENDING).
const CONTRACT_STATUS_MIRROR = new Set([
  'DRAFT', 'QUOTED', 'AWAITING_APPROVAL', 'BOUND', 'RENEWED',
  'CANCELLED', 'AWAITING_SIGNED_LINE', 'OFFERED', 'DECLINED', 'SIGNED', 'NTU',
]);

/**
 * Move a contract's uw_status to `to`, recording the edge and auditing it, all on
 * the supplied transaction client so they are atomic:
 *   1. UPDATE public.contract — uw_status (+ the contract_status mirror when the
 *      target is a valid contract_status, + the terminal timestamp signed_at /
 *      ntu_at / declined_at for the matching target, as the prior code did).
 *   2. INSERT public.contract_workflow_event (from_status, to_status, actor.id, comment).
 *   3. logAudit(critical) STATUS_CHANGED { from, to } — rethrows on failure so the
 *      whole transaction rolls back rather than committing a silent state change.
 *
 * Illegal CANONICAL transitions (e.g. DRAFT → SIGNED) throw InvalidTransitionError
 * (422). The canonical machine (statusMachine.js) deliberately omits the transient
 * offer states DISPUTE_PENDING / RETURNED; edges touching those pass the guard but
 * still leave an event. A true no-op (from === to) refreshes updated_at but records
 * no event/audit — a self-save is not a transition.
 *
 * @param {object} client  REQUIRED pg client inside a transaction (BEGIN/COMMIT).
 * @param {{ contractId:string, from?:string, to:string, actor:object, comment?:string }} args
 *   `actor` accepts the actorFromReq ({ id, role, name }) or legacy
 *   ({ actorUserId, actorName, actorRole }) shape. `from` is loaded from the row
 *   when omitted.
 * @returns {Promise<{ from:string|null, to:string }>}
 */
export async function changeUwStatus(client, { contractId, from, to, actor, comment = null } = {}) {
  if (!client) throw new Error('changeUwStatus requires a transaction client');
  if (!contractId) throw new Error('changeUwStatus requires a contractId');
  const toU = up(to);
  if (!toU) throw new Error('changeUwStatus requires a target status');

  let fromU = up(from);
  if (!fromU) {
    const { rows } = await client.query('SELECT uw_status FROM public.contract WHERE contract_id=$1', [contractId]);
    fromU = up(rows[0]?.uw_status);
  }

  // Guard. Only the seven canonical lifecycle states are gated by the machine; an
  // illegal jump between two of them (DRAFT → SIGNED) is a 422. Edges that touch a
  // transient state the machine omits pass (the engine enforces its own rules).
  if (UW_STATUSES.includes(fromU) && UW_STATUSES.includes(toU)) {
    assertLegalTransition(fromU, toU);
  }

  const mirror = CONTRACT_STATUS_MIRROR.has(toU) ? toU : null;

  // 1. Status write. Parameterized on purpose — a privileged literal
  //    (uw_status='SIGNED') outside the approval service trips the regression scan.
  await client.query(
    `UPDATE public.contract
        SET uw_status   = $2::public.uw_workflow_status,
            status      = COALESCE($3::public.contract_status, status),
            signed_at   = CASE WHEN $2 = 'SIGNED'   THEN now() ELSE signed_at   END,
            ntu_at      = CASE WHEN $2 = 'NTU'      THEN now() ELSE ntu_at      END,
            declined_at = CASE WHEN $2 = 'DECLINED' THEN now() ELSE declined_at END,
            updated_at  = now()
      WHERE contract_id = $1`,
    [contractId, toU, mirror]
  );

  // A no-op self-save is not a transition: refresh updated_at (above) but record none.
  if (fromU === toU) return { from: fromU || null, to: toU };

  const actorId = actor?.id ?? actor?.actorUserId ?? null;

  // 2. Immutable workflow event — the proof the transition happened.
  await client.query(
    `INSERT INTO public.contract_workflow_event (contract_id, from_status, to_status, actor, comment)
     VALUES ($1, $2, $3, $4, $5)`,
    [contractId, fromU || null, toU, actorId, comment]
  );

  // 3. Critical audit — rethrows on failure, rolling back the transaction.
  await logAudit(
    client,
    {
      entityType: 'CONTRACT', entityId: contractId, eventType: 'STATUS_CHANGED',
      actor, payload: { from: fromU || null, to: toU }, comment,
    },
    { critical: true }
  );

  return { from: fromU || null, to: toU };
}
