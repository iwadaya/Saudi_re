// server/src/services/quoteWorkflow.js
//
// Transactional quote workflow actions — the quote-side twins of
// pricingWorkflowService's declineTreatyAction / submitForApprovalAction.
//
// Before this, POST /quotes/:id/decline and /offer/submit-for-approval were
// hand-rolled in the route: several separate pool.query() calls (so a partial
// failure left the quote, the quote_offer and the event row inconsistent),
// errors swallowed with .catch(()=>{}), no legal-transition check (a SIGNED or
// NTU quote could be re-declined), and — for decline — no audit_log row at all.
//
// These actions bring quotes to parity with treaties:
//   • one withTransaction so the status flip, the quote_offer write, the
//     offer_approval_event and the (critical) audit row commit or roll back
//     together,
//   • assertLegalTransition() against the shared uw_status machine, so an
//     illegal pre-state is a clean 422 INVALID_TRANSITION,
//   • a critical logAudit row that rolls the action back if it can't be written.
//
// The other quote transitions (mark-approved, return-to-underwriter, recall,
// ntu) already funnel through the approval service; only decline + submit were
// outside it.

import { withTransaction } from '../db/withTransaction.js';
import { logAudit } from './audit.js';
import { assertLegalTransition } from '../lib/statusMachine.js';
import { getUserMandate, getRoleLevel, APPROVAL_AUTHORITY_MAX_LEVEL } from './approvals.js';

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the written line a submit carries. The client sends either
 * `written_line_pct` (a number), `line_pct` (a plain number for PROP), or
 * `line_pct` as a JSON per-layer map for NP — in which case we average every
 * present per-layer entry, INCLUDING legitimate 0% layers (only null/NaN and
 * negatives are dropped). Returns null when nothing usable is present.
 */
export function parseQuoteLinePct({ written_line_pct, line_pct }) {
  if (written_line_pct != null) return numOrNull(written_line_pct);
  if (line_pct == null) return null;
  const direct = numOrNull(line_pct);
  if (direct !== null) return direct;
  try {
    const parsed = JSON.parse(line_pct);
    if (parsed && typeof parsed === 'object') {
      // Include 0% layers in the mean — drop only null/undefined/NaN and
      // negatives. Excluding zeros biased the written line upward. Unweighted:
      // no per-layer weight is present in this map.
      const vals = Object.values(parsed)
        .map((v) => parseFloat(String(v).replace(/%/g, '')))
        .filter((n) => Number.isFinite(n) && n >= 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
  } catch { /* not JSON — fall through */ }
  return null;
}

/** Lock the quote row and return its current workflow status; 404 if missing. */
async function lockQuoteStatus(client, quoteId) {
  const { rows } = await client.query(
    `SELECT status FROM public.quote WHERE quote_id=$1 FOR UPDATE`,
    [quoteId],
  );
  if (!rows.length) {
    throw Object.assign(new Error('Quote not found'), { status: 404, code: 'NOT_FOUND' });
  }
  return rows[0].status || 'DRAFT';
}

/** Insert an offer_approval_event row on the transaction client. */
async function insertQuoteOfferEvent(client, { quoteId, eventType, actor, comment, payload }) {
  await client.query(
    `INSERT INTO public.offer_approval_event
       (quote_id, event_type, actor_user_id, actor_name, actor_role, comment, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      quoteId,
      eventType,
      actor.actorUserId || null,
      actor.actorName || 'SYSTEM',
      actor.actorRole || null,
      comment || null,
      payload ? JSON.stringify(payload) : null,
    ],
  );
}

/**
 * Decline a quote. Legal from any non-terminal state (DRAFT / AWAITING_APPROVAL
 * / APPROVED / AWAITING_SIGNED_LINE); re-declining a DECLINED quote is an
 * allowed self-transition; SIGNED / NTU are rejected with 422.
 */
export async function declineQuoteAction(quoteId, actor, reason) {
  return withTransaction(async (client) => {
    const from = await lockQuoteStatus(client, quoteId);
    assertLegalTransition(from, 'DECLINED');

    await client.query(
      `UPDATE public.quote
          SET status='DECLINED', decline_reason=$2, declined_at=now(), updated_at=now()
        WHERE quote_id=$1`,
      [quoteId, reason || null],
    );
    // 0 rows when no offer exists yet (decline straight from DRAFT) — not an error.
    await client.query(
      `UPDATE public.quote_offer SET status='DECLINED', decline_reason=$2, updated_at=now() WHERE quote_id=$1`,
      [quoteId, reason || null],
    );
    await insertQuoteOfferEvent(client, { quoteId, eventType: 'DECLINED', actor, comment: reason });
    await logAudit(
      client,
      { entityType: 'QUOTE', entityId: quoteId, eventType: 'DECLINED', actor, payload: { reason: reason || null }, comment: reason || null },
      { critical: true },
    );
    return { status: 'DECLINED', from };
  });
}

/**
 * Submit a quote for approval. Legal only from DRAFT (or a re-submit while
 * already AWAITING_APPROVAL); anything else is a 422 INVALID_TRANSITION.
 */
export async function submitQuoteForApprovalAction(quoteId, actor, payload = {}) {
  const { comment, written_line_pct, line_pct } = payload;
  const approver = payload.approver || payload.peer1_user_id || null;
  const wlPct = parseQuoteLinePct({ written_line_pct, line_pct });

  // Nominee validation — payload.approver used to be stored with ZERO checks
  // (even a bogus UUID was accepted), and approveQuote trusts the recorded
  // nominee. The nominee must (a) not be the submitting actor (four-eyes),
  // (b) exist, and (c) hold approval authority per the live uw_role hierarchy
  // (the same source approveQuote and the treaty engine resolve levels from).
  if (approver) {
    if (actor?.actorUserId && String(approver) === String(actor.actorUserId)) {
      throw Object.assign(new Error('Cannot nominate yourself as the approver of your own submission'), { status: 403 });
    }
    const nominee = await getUserMandate(approver);
    if (!nominee) {
      throw Object.assign(new Error('Approver not found — user does not exist in the system'), { status: 400 });
    }
    const nomineeLevel = Number.isFinite(Number(nominee.hierarchy_level))
      ? Number(nominee.hierarchy_level)
      : await getRoleLevel(nominee.role_code);
    if (nomineeLevel > APPROVAL_AUTHORITY_MAX_LEVEL) {
      throw Object.assign(new Error('Nominated approver does not hold approval authority'), { status: 400 });
    }
  }

  return withTransaction(async (client) => {
    const from = await lockQuoteStatus(client, quoteId);
    assertLegalTransition(from, 'AWAITING_APPROVAL');

    await client.query(
      `UPDATE public.quote SET status='AWAITING_APPROVAL', next_approver=$2, updated_at=now() WHERE quote_id=$1`,
      [quoteId, approver],
    );
    await client.query(
      `INSERT INTO public.quote_offer (quote_id, written_line_pct, next_approver, status, updated_at)
       VALUES ($1, $2, $3, 'AWAITING_APPROVAL', now())
       ON CONFLICT (quote_id) DO UPDATE SET
         written_line_pct = COALESCE(EXCLUDED.written_line_pct, quote_offer.written_line_pct),
         next_approver    = EXCLUDED.next_approver,
         status           = 'AWAITING_APPROVAL',
         updated_at       = now()`,
      [quoteId, wlPct, approver],
    );
    await insertQuoteOfferEvent(client, {
      quoteId,
      eventType: 'SUBMITTED_FOR_APPROVAL',
      actor,
      comment: comment || null,
      payload: { written_line_pct: wlPct, approver },
    });
    await logAudit(
      client,
      { entityType: 'QUOTE', entityId: quoteId, eventType: 'SUBMITTED_FOR_APPROVAL', actor, payload: { written_line_pct: wlPct, approver }, comment: comment || null },
      { critical: true },
    );
    return { status: 'AWAITING_APPROVAL', next_approver: approver, written_line_pct: wlPct };
  });
}
