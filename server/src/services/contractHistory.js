// server/src/services/contractHistory.js
// Unified, read-only history timeline for a contract.
//
// Merges four event sources into a single newest-first timeline:
//   1. contract_audit_event   — the audit backbone (lifecycle UPDATED/CREATED/
//      DELETED/RENEWED, plus the workflow/approval events that logOfferEvent
//      mirrors here, plus any field-diff payloads).
//   2. contract_workflow_event — explicit status transitions (from → to).
//   3. approval_decision       — peer/arbiter decisions, joined to
//      approval_request (to scope by contract) and uw_user (for names).
//   4. field-diff events       — surfaced as the per-item `changes` array,
//      extracted from an event payload's changes/diff/before-after shape.
//
// Actor ids stored in the event tables are resolved to display names + role
// codes via uw_user / uw_role. Each source is read best-effort: a single
// missing/legacy table logs a warning and contributes nothing rather than
// failing the whole timeline.

import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// Friendlier one-liners for the event types this system emits. Anything not
// listed falls back to a humanised version of the raw type (PEER1_APPROVED →
// "Peer1 approved").
const TYPE_SUMMARY = Object.freeze({
  CREATED: 'Treaty created',
  UPDATED: 'Treaty details updated',
  AUTOSAVED: 'Autosaved',
  DELETED: 'Treaty deleted',
  RENEWED: 'Renewed into a new treaty year',
  DISCARDED: 'Draft discarded',
  STALE_WRITE_OVERRIDE: 'Overwrote a newer saved version',
  SUBMITTED: 'Submitted for approval',
  PEER1_APPROVED: 'First peer approval granted',
  PEER1_DECLINED: 'First peer approver declined',
  PEER2_APPROVED: 'Second peer approval granted',
  PEER2_DECLINED: 'Second peer approver declined',
  FINAL_APPROVED_BY_AUTHORITY: 'Final approval by authority',
  FINAL_DECLINED_BY_AUTHORITY: 'Final decline by authority',
  DISPUTE_RAISED: 'Split decision — dispute raised',
  ARBITER_APPROVED: 'Dispute resolved — approved',
  ARBITER_DECLINED: 'Dispute resolved — declined',
  SIGNED: 'Signed line confirmed',
  NTU: 'Marked not taken up',
  RETURNED_TO_UW: 'Returned to underwriter for rework',
  RECALLED: 'Recalled by submitter',
  ASSIGNED: 'Assigned',
  ALLOCATED: 'Allocated',
  SELF_ASSIGNED: 'Self-assigned',
});

/** "PEER1_APPROVED" → "Peer1 approved" (used when a type has no curated label). */
function humanizeType(type) {
  const s = String(type || 'EVENT').toLowerCase().replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Event';
}

function summarizeType(type, payload) {
  const base = TYPE_SUMMARY[type] || humanizeType(type);
  // Surface a decision/reason from the payload when it adds signal.
  const reason = payload && typeof payload === 'object'
    ? (payload.reason || payload.comment || null)
    : null;
  return reason ? `${base} — ${String(reason)}` : base;
}

/**
 * Pull a normalised list of field changes out of an event payload. Tolerates
 * the shapes a field-diff might be persisted in:
 *   • payload.changes / payload.diff / payload.fieldChanges as an array of
 *     { field|path|key, from|before|old, to|after|new }
 *   • the same keys as an object map { field: { from, to } } or { field: [from,to] }
 *   • a before/after snapshot pair → the changed keys are diffed
 * Returns undefined when there is nothing field-level to show.
 */
export function extractChanges(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const out = [];
  const push = (field, from, to) => {
    if (field == null) return;
    out.push({ field: String(field), from: from === undefined ? null : from, to: to === undefined ? null : to });
  };
  const fieldOf = (c) => c.field ?? c.path ?? c.key ?? c.name ?? c.column;
  const fromOf = (c) => c.from ?? c.before ?? c.old ?? c.previous ?? c.oldValue ?? c.prev ?? null;
  const toOf = (c) => c.to ?? c.after ?? c.new ?? c.current ?? c.newValue ?? c.next ?? null;

  const raw = payload.changes ?? payload.diff ?? payload.fieldChanges ?? payload.fields ?? null;
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c && typeof c === 'object') push(fieldOf(c), fromOf(c), toOf(c));
    }
  } else if (raw && typeof raw === 'object') {
    for (const [field, val] of Object.entries(raw)) {
      if (Array.isArray(val)) push(field, val[0], val[1]);
      else if (val && typeof val === 'object') push(field, fromOf(val), toOf(val));
      else push(field, null, val);
    }
  } else if (payload.before && payload.after
    && typeof payload.before === 'object' && typeof payload.after === 'object') {
    const keys = new Set([...Object.keys(payload.before), ...Object.keys(payload.after)]);
    for (const k of keys) {
      const a = payload.before[k];
      const b = payload.after[k];
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) push(k, a, b);
    }
  }
  return out.length ? out : undefined;
}

/**
 * Resolve { id, name, role } for an event, preferring the DB join (uw_user /
 * uw_role) and falling back to the human-readable bits stashed in
 * payload.actor, then to a SYSTEM marker.
 */
function resolveActor({ actorRef, userId, displayName, roleCode }, payload) {
  const meta = payload && typeof payload === 'object' && payload.actor && typeof payload.actor === 'object'
    ? payload.actor
    : null;
  const id = userId || (isUuid(actorRef) ? actorRef : null) || null;
  const name = displayName
    || (meta && meta.name)
    || (actorRef && actorRef !== 'SYSTEM' && !isUuid(actorRef) ? actorRef : null)
    || 'System';
  const role = roleCode || (meta && meta.role) || null;
  return { id, name, role };
}

function parsePayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  return payload;
}

// ── Per-source loaders (each best-effort) ────────────────────────────────────

async function loadAuditEvents(contractId, limit) {
  try {
    const { rows } = await pool.query(
      `SELECT ae.event_id, ae.event_type, ae.actor AS actor_ref, ae.payload, ae.created_at,
              au.user_id AS actor_user_id, au.display_name AS actor_display_name,
              ar.role_code AS actor_role_code
         FROM public.contract_audit_event ae
         LEFT JOIN public.uw_user au ON au.user_id::text = ae.actor
         LEFT JOIN public.uw_role ar ON ar.role_id = au.role_id
        WHERE ae.contract_id = $1
        ORDER BY ae.created_at DESC
        LIMIT $2`,
      [contractId, limit],
    );
    return rows.map((r) => {
      const payload = parsePayload(r.payload);
      return {
        id: `audit:${r.event_id}`,
        source: 'audit',
        at: r.created_at,
        type: r.event_type,
        actor: resolveActor({
          actorRef: r.actor_ref, userId: r.actor_user_id,
          displayName: r.actor_display_name, roleCode: r.actor_role_code,
        }, payload),
        summary: summarizeType(r.event_type, payload),
        changes: extractChanges(payload),
        comment: payload && typeof payload === 'object' ? (payload.comment ?? null) : null,
      };
    });
  } catch (err) {
    logger.warn('contractHistory: audit source failed', { contractId, error: err.message });
    return [];
  }
}

async function loadWorkflowEvents(contractId, limit) {
  try {
    const { rows } = await pool.query(
      `SELECT we.event_id, we.from_status, we.to_status, we.actor AS actor_ref,
              we.comment, we.created_at,
              au.user_id AS actor_user_id, au.display_name AS actor_display_name,
              ar.role_code AS actor_role_code
         FROM public.contract_workflow_event we
         LEFT JOIN public.uw_user au ON au.user_id::text = we.actor
         LEFT JOIN public.uw_role ar ON ar.role_id = au.role_id
        WHERE we.contract_id = $1
        ORDER BY we.created_at DESC
        LIMIT $2`,
      [contractId, limit],
    );
    return rows.map((r) => ({
      id: `workflow:${r.event_id}`,
      source: 'workflow',
      at: r.created_at,
      type: `STATUS_${r.to_status}`,
      actor: resolveActor({
        actorRef: r.actor_ref, userId: r.actor_user_id,
        displayName: r.actor_display_name, roleCode: r.actor_role_code,
      }, null),
      summary: `Status changed ${r.from_status || '—'} → ${r.to_status}`,
      changes: [{ field: 'status', from: r.from_status ?? null, to: r.to_status ?? null }],
      comment: r.comment ?? null,
    }));
  } catch (err) {
    logger.warn('contractHistory: workflow source failed', { contractId, error: err.message });
    return [];
  }
}

async function loadApprovalDecisions(contractId, limit) {
  try {
    const { rows } = await pool.query(
      `SELECT ad.decision_id, ad.decision, ad.comment, ad.decided_at,
              ad.decided_by AS actor_user_id, au.display_name AS actor_display_name,
              COALESCE(ar.role_code, dr.role_code) AS actor_role_code
         FROM public.approval_decision ad
         JOIN public.approval_request req ON req.request_id = ad.request_id
         LEFT JOIN public.uw_user au ON au.user_id = ad.decided_by
         LEFT JOIN public.uw_role ar ON ar.role_id = au.role_id
         LEFT JOIN public.uw_role dr ON dr.role_id = ad.decided_by_role
        WHERE req.entity_type = 'CONTRACT' AND req.entity_id = $1
        ORDER BY ad.decided_at DESC
        LIMIT $2`,
      [contractId, limit],
    );
    return rows.map((r) => ({
      id: `decision:${r.decision_id}`,
      source: 'approval',
      at: r.decided_at,
      type: `DECISION_${r.decision}`,
      actor: resolveActor({
        actorRef: r.actor_user_id, userId: r.actor_user_id,
        displayName: r.actor_display_name, roleCode: r.actor_role_code,
      }, null),
      summary: `Approval decision: ${humanizeType(r.decision)}`,
      changes: undefined,
      comment: r.comment ?? null,
    }));
  } catch (err) {
    logger.warn('contractHistory: approval_decision source failed', { contractId, error: err.message });
    return [];
  }
}

/**
 * Merge already-normalised source items into one newest-first timeline.
 * Pure (no I/O) so the ordering/limit contract is unit-testable.
 */
export function mergeTimeline(sources, { limit = DEFAULT_LIMIT } = {}) {
  const items = [].concat(...sources);
  items.sort((a, b) => {
    const ta = new Date(a.at).getTime() || 0;
    const tb = new Date(b.at).getTime() || 0;
    return tb - ta;
  });
  return items.slice(0, limit);
}

/**
 * Build the merged history timeline for a contract.
 * @param {string} contractId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ id, source, at, actor:{id,name,role}, type, summary, changes?, comment? }>>}
 */
export async function getContractHistory(contractId, { limit = DEFAULT_LIMIT } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  // Each source is capped at `lim` so no single source can starve the merge;
  // the merged result is re-capped to `lim` after sorting.
  const [audit, workflow, decisions] = await Promise.all([
    loadAuditEvents(contractId, lim),
    loadWorkflowEvents(contractId, lim),
    loadApprovalDecisions(contractId, lim),
  ]);
  return mergeTimeline([audit, workflow, decisions], { limit: lim });
}
