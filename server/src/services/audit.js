// server/src/services/audit.js
// Audit trail — logs every significant action for compliance and traceability.
//
// ⚠️ TRANSACTION REQUIREMENT (lint note — do not regress):
// An audit write MUST run on the SAME client as the mutation it records. When a
// route/service opens a transaction (`const client = await pool.connect()` +
// BEGIN/COMMIT), pass that `client` to logAudit — NEVER `pool` and NEVER `null`.
// Passing pool/null from inside a transaction writes the audit row on a SEPARATE
// connection: it commits even when the surrounding mutation rolls back (a
// phantom event), and for `critical` events it escapes the rollback guarantee
// entirely. Only pass `pool`/`null` when the mutation itself is a single,
// non-transactional statement on the pool.
//
// Actor contract:
//   • Pass actor as an object from actorFromReq(req) (middleware/requestContext.js):
//       { id, role, name, via }   — verified request identity, or
//     SYSTEM_ACTOR ({ id:null, name:'SYSTEM', system:true }) for system jobs.
//   • The stable user id is stored in the `actor` column (joinable) and the
//     resolved { role, name, via } is merged into payload.actor (human-readable).
//   • The legacy resolveAuditActor shape ({ actorUserId, actorName, actorRole })
//     and a plain string actor are also accepted for back-compat.
//
// Failure handling:
//   • Non-critical events swallow write failures (logged, never block business).
//   • Pass { critical: true } for status changes, approvals and field-diffs: a
//     failed write then THROWS so the surrounding transaction rolls back rather
//     than committing a mutation with no audit record.

import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";

/** Explicit actor for genuinely system-initiated work (schedulers, imports with no request user). */
export const SYSTEM_ACTOR = Object.freeze({ id: null, name: "SYSTEM", system: true });

/**
 * Resolve an actor (object or legacy string) into the value stored in the
 * `actor` column plus the { role, name, via } metadata merged into payload.actor.
 * Accepts the actorFromReq shape ({ id, role, name, via }), the legacy
 * resolveAuditActor shape ({ actorUserId, actorName, actorRole }), SYSTEM_ACTOR,
 * or a plain string (stored verbatim).
 */
function normalizeActor(actor) {
  if (actor && typeof actor === "object") {
    const id = actor.id ?? actor.actorUserId ?? null;
    const name = actor.name ?? actor.actorName ?? null;
    const role = actor.role ?? actor.actorRole ?? null;
    const via = actor.via ?? null;
    const meta = {};
    if (name != null && name !== "SYSTEM") meta.name = name;
    if (role != null) meta.role = role;
    if (via != null) meta.via = via;
    if (actor.system) meta.system = true;
    return { column: id ?? "SYSTEM", meta: Object.keys(meta).length ? meta : null };
  }
  // Legacy string actor — store verbatim, no payload.actor enrichment.
  return { column: actor || "SYSTEM", meta: null };
}

/**
 * Record an audit event.
 * For CONTRACT entities: writes to contract_audit_event (has FK constraint).
 * For all other entities (USER, USER_MANDATE, QUOTE, etc.): writes to audit_log (no FK).
 *
 * @param {object|null} client  Transaction client when inside a txn, else pool/null.
 * @param {object} event        { entityType, entityId, eventType, actor, payload, comment }
 * @param {{ critical?: boolean }} [opts]  critical:true rethrows on failure (rolls back the txn).
 */
export async function logAudit(client, {
  entityType,
  entityId,
  eventType,
  actor,
  payload = null,
  comment = null,
}, { critical = false } = {}) {
  const db = client || pool;
  const { column: actorColumn, meta } = normalizeActor(actor);
  const finalPayload = meta
    ? { ...(payload || {}), actor: { ...(payload?.actor || {}), ...meta } }
    : payload;
  try {
    if (entityType === "CONTRACT") {
      // contract_audit_event has a FK on contract_id — only use for real contract UUIDs
      await db.query(
        `INSERT INTO public.contract_audit_event (contract_id, event_type, actor, payload)
         VALUES ($1, $2, $3, $4)`,
        [entityId, eventType, actorColumn, finalPayload ? JSON.stringify(finalPayload) : null]
      );
    } else {
      // Use the generic audit_log table (no FK constraints) for all other entity types
      await db.query(
        `INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor, payload, comment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entityType || "SYSTEM", entityId, eventType, actorColumn,
         finalPayload ? JSON.stringify(finalPayload) : null, comment || null]
      );
    }
  } catch (e) {
    logger.error("Audit log write failed", { error: e.message, entityType, entityId, eventType, critical });
    // Compliance-critical events (status changes, approvals, field-diffs) must
    // NOT silently succeed: rethrow so the surrounding transaction rolls back
    // rather than committing a mutation with no audit record.
    if (critical) throw e;
  }
}

/**
 * Normalise a field value so cosmetically-different-but-equal values don't
 * register as changes:
 *   • null / undefined / '' → null (treated as "unset")
 *   • Date → ISO instant (pg returns date/timestamp columns as Date objects, so
 *     two equal dates compare equal regardless of object identity)
 *   • numbers & numeric strings → Number ("10.00" === 10 === "10"; pg returns
 *     numeric columns as strings, so this is what stops every save looking dirty)
 *   • objects / arrays → stable JSON (drives the key-by-key terms diff and the
 *     per-layer/per-slide summaries)
 *   • everything else (incl. booleans) → its trimmed String() form
 * Returns a primitive safe for === comparison.
 */
function normalizeForDiff(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  const s = String(v).trim();
  if (s === "") return null;
  const numeric = s.replace(/,/g, "");
  if (/^-?\d+(?:\.\d+)?$/.test(numeric)) {
    const n = Number(numeric);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/**
 * Field-level diff audit for treaty terms & financials.
 *
 * Snapshot the affected row(s) BEFORE the UPDATE and pass them as `before`, the
 * post-UPDATE row(s) as `after`, and the columns/keys to watch as `fields`. For
 * each field whose NORMALISED value differs (numbers/dates normalised, updated_at
 * and equal values ignored) a `{ from, to }` entry (raw values, for readability)
 * is recorded under payload.changes.
 *
 *   • Nothing changed → NOTHING is written (no empty audit rows).
 *   • Otherwise one CRITICAL audit event is written on the SAME client, so a
 *     failed audit write rolls the surrounding transaction back rather than
 *     committing a financial change with no trail (see the file-header contract).
 *
 * Collections (layers, slides, triangle cells, terms JSON) are diffed by passing
 * a map/object keyed by id (layer number, key, …) whose values are the watched
 * sub-objects — each changed key is then summarised as a single from/to entry
 * rather than a per-column explosion.
 *
 * @param {object|null} client  Transaction client (REQUIRED when inside a txn).
 * @param {object} args
 * @param {string}   args.entityType  CONTRACT | QUOTE | …
 * @param {string}   args.entityId
 * @param {string}   args.eventType   '<ENTITY>_UPDATED' (e.g. PROP_DETAILS_UPDATED, NP_LAYER_UPDATED)
 * @param {object}   args.actor       actorFromReq(req) / SYSTEM_ACTOR
 * @param {object}   [args.before]    pre-update snapshot (row or plain object)
 * @param {object}   [args.after]     post-update snapshot
 * @param {string[]} [args.fields]    columns/keys to compare
 * @param {string}   [args.label]     human label for payload.entity
 * @returns {Promise<object|null>} the recorded `changes`, or null when nothing changed.
 */
export async function diffAudit(client, { entityType, entityId, eventType, actor, before, after, fields, label }) {
  const changes = {};
  for (const field of fields || []) {
    if (field === "updated_at") continue;
    const fromRaw = before ? before[field] : undefined;
    const toRaw = after ? after[field] : undefined;
    if (normalizeForDiff(fromRaw) === normalizeForDiff(toRaw)) continue;
    changes[field] = { from: fromRaw ?? null, to: toRaw ?? null };
  }
  if (Object.keys(changes).length === 0) return null;
  await logAudit(client, {
    entityType,
    entityId,
    eventType,
    actor,
    payload: { entity: label, changes },
  }, { critical: true });
  return changes;
}

/**
 * Retrieve audit history for an entity (newest first).
 * Throws on DB errors so callers can distinguish "no history" from
 * "audit service unavailable" — the previous catch-and-return-`[]`
 * silently hid outages and made compliance lookups look complete when
 * they weren't.
 */
export async function getAuditTrail(entityType, entityId, { limit = 100 } = {}) {
  try {
    if (entityType === "CONTRACT") {
      const { rows } = await pool.query(
        `SELECT event_id, contract_id AS entity_id, event_type, actor, payload, created_at
           FROM public.contract_audit_event
          WHERE contract_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [entityId, limit]
      );
      return rows;
    }
    const { rows } = await pool.query(
      `SELECT event_id, entity_id, event_type, actor, payload, comment, created_at
         FROM public.audit_log
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at DESC LIMIT $3`,
      [entityType, entityId, limit]
    );
    return rows;
  } catch (err) {
    logger.error("getAuditTrail failed", {
      message: err.message, entityType, entityId,
    });
    throw err;
  }
}

/**
 * Resolve the acting user for AUDIT from VERIFIED identity only.
 *
 * The id comes from req.user.userId (set by the authenticate middleware — a
 * verified token in production, or x-user-id behind ALLOW_DEMO_AUTH in dev).
 * The display name and role are then looked up server-side from the DB by that
 * id. Client-supplied labels — x-user-name / x-user-role headers and body
 * `_actor` — are NEVER trusted for audit fields, so spoofing them changes
 * nothing in the trail. With no verified user the actor is SYSTEM (never a
 * client string).
 *
 * @param {object} req  Express request (reads only req.user.userId).
 * @returns {Promise<{ actorUserId: string|null, actorName: string, actorRole: string|null }>}
 */
export async function resolveAuditActor(req) {
  const userId = req?.user?.userId || null;
  if (!userId) return { actorUserId: null, actorName: "SYSTEM", actorRole: null };
  try {
    const { rows } = await pool.query(
      `SELECT display_name, role_code FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (rows[0]) {
      return {
        actorUserId: userId,
        actorName: rows[0].display_name || "SYSTEM",
        actorRole: rows[0].role_code || null,
      };
    }
  } catch (e) {
    logger.warn("resolveAuditActor lookup failed", { error: e.message, userId });
  }
  // Verified id but no DB profile (or a lookup error): record the id, never a
  // client-supplied name.
  return { actorUserId: userId, actorName: "SYSTEM", actorRole: null };
}
