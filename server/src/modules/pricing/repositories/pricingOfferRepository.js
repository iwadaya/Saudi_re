import { pool } from '../../../db/pool.js';
import { numOrNull } from './repositoryUtils.js';
import { assertLegalTransition } from '../../../lib/statusMachine.js';
import { refreshBenchmarks } from '../../../services/ldf/benchmark.js';

// Fire-and-forget — benchmark refresh can take seconds on a big dataset
// and the terminal-state transition shouldn't block on it. Failures are
// logged by refreshBenchmarks itself.
function scheduleBenchmarkRefresh() {
  refreshBenchmarks(pool).catch(() => {});
}

/**
 * Load the current uw_status for a contract. Throws a 404-style
 * Error when the contract doesn't exist; the error handler turns
 * that into { status: 404, code: 'NOT_FOUND' } via resolveStatus.
 */
async function loadCurrentStatus(contractId) {
  const { rows } = await pool.query(
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

export async function replaceOffer(contractId, offer) {
  await pool.query('DELETE FROM public.contract_offer WHERE contract_id=$1', [contractId]);
  const { rows } = await pool.query(
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
  await pool.query("UPDATE public.contract SET status='OFFERED',updated_at=now() WHERE contract_id=$1", [contractId]);
  return rows[0];
}

export async function markDeclined(contractId, reason) {
  // Decline is legal from any non-terminal state; the machine blocks
  // only SIGNED → DECLINED and NTU → DECLINED (can't un-sign a treaty).
  const current = await loadCurrentStatus(contractId);
  assertLegalTransition(current, 'DECLINED');
  await pool.query(
    `UPDATE public.contract SET uw_status='DECLINED',status='DECLINED',decline_reason=$2,declined_at=now(),updated_at=now() WHERE contract_id=$1`,
    [contractId, reason]
  );
  await pool.query(
    `UPDATE public.contract_offer SET status='DECLINED',decline_reason=$2,declined_at=now(),updated_at=now() WHERE contract_id=$1`,
    [contractId, reason || null]
  ).catch(() => {});
  scheduleBenchmarkRefresh();
}

export async function markApproved(contractId, linePct) {
  // Only legal from APPROVED (the approval engine just finished) or
  // AWAITING_SIGNED_LINE (self — idempotent re-save).
  const current = await loadCurrentStatus(contractId);
  assertLegalTransition(current, 'AWAITING_SIGNED_LINE');
  await pool.query(
    `UPDATE public.contract SET uw_status='AWAITING_SIGNED_LINE', status='AWAITING_SIGNED_LINE', updated_at=now() WHERE contract_id=$1`,
    [contractId]
  );
  await pool.query(
    `UPDATE public.contract_offer SET status='AWAITING_SIGNED_LINE', approved_at=now(), updated_at=now() WHERE contract_id=$1`,
    [contractId]
  );
  if (linePct != null) {
    await pool.query(
      `UPDATE public.contract_pricing_outputs SET offer_line=$2, updated_at=now() WHERE contract_id=$1`,
      [contractId, String(linePct)]
    ).catch(() => {});
  }
}

export async function forceDraftStatus(contractId) {
  await pool.query(`UPDATE public.contract SET uw_status='DRAFT',status='DRAFT',updated_at=now() WHERE contract_id=$1`, [contractId]);
}

export async function getLegacyApprovalTrail(contractId) {
  const { rows } = await pool.query(
    `SELECT event_id,event_type,actor,payload,created_at FROM public.contract_audit_event
     WHERE contract_id=$1 AND event_type IN ('SUBMITTED_FOR_APPROVAL','APPROVED','DECLINED','RETURNED_TO_UW','RETURNED','SIGNED','NTU','OFFERED','SUBMITTED','PEER1_APPROVED','PEER1_DECLINED','PEER2_APPROVED','PEER2_DECLINED','DISPUTE_RAISED','ARBITER_APPROVED','ARBITER_DECLINED','FINAL_APPROVED_BY_AUTHORITY','FINAL_DECLINED_BY_AUTHORITY')
     ORDER BY created_at DESC LIMIT 50`,
    [contractId]
  );
  return rows;
}

export async function recallOffer(contractId, actor) {
  await pool.query(
    `UPDATE public.contract_offer SET
       status='RETURNED',
       peer1_decision=NULL, peer1_at=NULL, peer1_comment=NULL, peer1_user_id=NULL,
       peer2_user_id=NULL, peer2_decision=NULL, peer2_at=NULL, peer2_comment=NULL,
       arbiter_required=false, arbiter_user_id=NULL, arbiter_decision=NULL,
       approval_step=0, next_approver_id=NULL, updated_at=now()
     WHERE contract_id=$1`,
    [contractId]
  );
  await forceDraftStatus(contractId);
  await pool.query(
    `INSERT INTO public.offer_approval_event (contract_id,event_type,actor_user_id,actor_name,actor_role,comment)
     VALUES ($1,'RECALLED',$2,$3,$4,$5)`,
    [contractId, actor.actorUserId || null, actor.actorName, actor.actorRole || null, actor.comment]
  ).catch(() => {});
}

export async function markSigned(contractId, signedLinePct) {
  // Must have been on offer — no signing a DRAFT or an AWAITING_APPROVAL.
  const current = await loadCurrentStatus(contractId);
  assertLegalTransition(current, 'SIGNED');
  await pool.query(
    `UPDATE public.contract SET uw_status='SIGNED',status='SIGNED',signed_line_pct=$2,signed_at=now(),updated_at=now() WHERE contract_id=$1`,
    [contractId, signedLinePct]
  );
  await pool.query(
    `UPDATE public.contract_offer SET status='SIGNED',signed_at=now(),written_line_pct=COALESCE(written_line_pct,$2) WHERE contract_id=$1`,
    [contractId, signedLinePct]
  );
  scheduleBenchmarkRefresh();
}

export async function markNtu(contractId, reason) {
  // NTU (Not-Taken-Up) happens AFTER the offer went out; can't NTU
  // a draft or a pending approval.
  const current = await loadCurrentStatus(contractId);
  assertLegalTransition(current, 'NTU');
  await pool.query(
    `UPDATE public.contract SET uw_status='NTU',status='NTU',ntu_reason=$2,ntu_at=now(),updated_at=now() WHERE contract_id=$1`,
    [contractId, reason]
  );
  await pool.query(
    `UPDATE public.contract_offer SET status='NTU',ntu_at=now(),ntu_reason=$2 WHERE contract_id=$1`,
    [contractId, reason]
  );
  scheduleBenchmarkRefresh();
}

export async function insertApprovalEvent(contractId, eventType, actor, comment = null) {
  await pool.query(
    `INSERT INTO public.offer_approval_event (contract_id,event_type,actor_user_id,actor_name,actor_role,comment)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [contractId, eventType, actor.actorUserId || null, actor.actorName, actor.actorRole || null, comment]
  ).catch(() => {});
}
