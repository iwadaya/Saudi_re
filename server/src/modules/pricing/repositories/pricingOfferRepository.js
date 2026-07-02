import { pool } from '../../../db/pool.js';
import { numOrNull } from './repositoryUtils.js';
import { assertLegalTransition } from '../../../lib/statusMachine.js';
import { changeUwStatus } from '../../../services/workflow.js';
import { refreshBenchmarks } from '../../../services/ldf/benchmark.js';

// Fire-and-forget — benchmark refresh can take seconds on a big dataset
// and the terminal-state transition shouldn't block on it. Failures are
// logged by refreshBenchmarks itself.
function scheduleBenchmarkRefresh() {
  refreshBenchmarks(pool).catch(() => {});
}

// A checked-out transaction client has a .query and a .release; the Pool has
// .query but no .release. Used to refuse the pool for multi-statement writes
// that must be atomic (see replaceOffer / markDeclined).
function isTxClient(db) {
  return Boolean(db) && typeof db.query === 'function' && typeof db.release === 'function';
}

/**
 * Load the current uw_status for a contract. Throws a 404-style
 * Error when the contract doesn't exist; the error handler turns
 * that into { status: 404, code: 'NOT_FOUND' } via resolveStatus.
 */
async function loadCurrentStatus(contractId, client) {
  const db = client || pool;
  const { rows } = await db.query(
    'SELECT uw_status FROM public.contract WHERE contract_id=$1',
    [contractId]
  );
  if (!rows[0]) {
    const err = new Error(`Contract ${contractId} not found`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return rows[0].uw_status;
}

export async function getOffer(contractId) {
  const { rows } = await pool.query('SELECT * FROM public.contract_offer WHERE contract_id=$1', [contractId]);
  return rows[0] || null;
}

export async function replaceOffer(contractId, offer, client) {
  // Multi-statement write (DELETE + INSERT + UPDATE contract). It MUST run on a
  // caller-supplied transaction client so the three statements commit together;
  // on the pool each would autocommit independently and a mid-sequence failure
  // would leave a half-applied offer. Require the client rather than silently
  // falling back to the pool.
  if (!isTxClient(client)) throw new Error('replaceOffer requires a transaction client');
  const db = client;
  await db.query('DELETE FROM public.contract_offer WHERE contract_id=$1', [contractId]);
  const { rows } = await db.query(
    `INSERT INTO public.contract_offer
      (contract_id,written_line_pct,premium_driver,profit_driver,strategic_rationale,tactical_rationale,next_approver,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING') RETURNING *`,
    [
      contractId,
      numOrNull(offer.written_line_pct),
      offer.premium_driver,
      offer.profit_driver,
      offer.strategic_rationale,
      offer.tactical_rationale,
      offer.next_approver,
    ]
  );
  await db.query("UPDATE public.contract SET status='OFFERED',updated_at=now() WHERE contract_id=$1", [contractId]);
  return rows[0];
}

export async function markDeclined(contractId, reason, client, actor) {
  // Multi-statement write (status change + decline_reason + offer mirror). Must
  // be atomic, so require the caller's transaction client (see replaceOffer).
  if (!isTxClient(client)) throw new Error('markDeclined requires a transaction client');
  const db = client;
  // Decline is legal from any non-terminal state; the machine blocks
  // only SIGNED → DECLINED and NTU → DECLINED (can't un-sign a treaty).
  const current = await loadCurrentStatus(contractId, client);
  assertLegalTransition(current, 'DECLINED');
  // The DECLINED transition (uw_status + status + declined_at + workflow event +
  // STATUS_CHANGED audit) goes through the changeUwStatus chokepoint with the
  // acting modeller as actor; decline_reason is the only extra column.
  await changeUwStatus(db, { contractId, from: current, to: 'DECLINED', actor, comment: reason ?? null });
  await db.query(`UPDATE public.contract SET decline_reason=$2 WHERE contract_id=$1`, [contractId, reason ?? null]);
  // Offer-table mirror — a 0-row update (no offer yet) is a no-op, so this is
  // safe to keep inside the caller's transaction (atomic with the decline).
  await db.query(
    `UPDATE public.contract_offer SET status='DECLINED',decline_reason=$2,declined_at=now(),updated_at=now() WHERE contract_id=$1`,
    [contractId, reason || null]
  );
  scheduleBenchmarkRefresh();
}

// markApproved / markSigned / markNtu / recallOffer / forceDraftStatus removed:
// every privileged or terminal state write (APPROVED / AWAITING_SIGNED_LINE /
// SIGNED / NTU, and the DRAFT reset behind return/recall) now lives in the
// approval service (approvals.js), behind the recordDecision engine +
// assertWorkflowTransition gate with per-action authority. No route may write
// these states directly.

export async function getLegacyApprovalTrail(contractId) {
  const { rows } = await pool.query(
    `SELECT event_id,event_type,actor,payload,created_at FROM public.contract_audit_event
     WHERE contract_id=$1 AND event_type IN ('SUBMITTED_FOR_APPROVAL','APPROVED','DECLINED','RETURNED_TO_UW','RETURNED','SIGNED','NTU','OFFERED','SUBMITTED','PEER1_APPROVED','PEER1_DECLINED','PEER2_APPROVED','PEER2_DECLINED','DISPUTE_RAISED','ARBITER_APPROVED','ARBITER_DECLINED','FINAL_APPROVED_BY_AUTHORITY','FINAL_DECLINED_BY_AUTHORITY')
     ORDER BY created_at DESC LIMIT 50`,
    [contractId]
  );
  return rows;
}

export async function insertApprovalEvent(contractId, eventType, actor, comment = null, client) {
  const db = client || pool;
  await db.query(
    `INSERT INTO public.offer_approval_event (contract_id,event_type,actor_user_id,actor_name,actor_role,comment)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [contractId, eventType, actor.actorUserId || null, actor.actorName, actor.actorRole || null, comment]
  );
}
