// server/src/services/audit.js
// Audit trail — logs every significant action for compliance and traceability

import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";

/**
 * Record an audit event.
 * For CONTRACT/QUOTE entities: writes to contract_audit_event (has FK constraint).
 * For all other entities (USER, USER_MANDATE, etc.): writes to audit_log (no FK).
 */
export async function logAudit(client, {
  entityType,
  entityId,
  eventType,
  actor,
  payload = null,
  comment = null,
}) {
  const db = client || pool;
  try {
    if (entityType === "CONTRACT") {
      // contract_audit_event has a FK on contract_id — only use for real contract UUIDs
      await db.query(
        `INSERT INTO public.contract_audit_event (contract_id, event_type, actor, payload)
         VALUES ($1, $2, $3, $4)`,
        [entityId, eventType, actor || "SYSTEM", payload ? JSON.stringify(payload) : null]
      );
    } else {
      // Use the generic audit_log table (no FK constraints) for all other entity types
      await db.query(
        `INSERT INTO public.audit_log (entity_type, entity_id, event_type, actor, payload, comment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entityType || "SYSTEM", entityId, eventType, actor || "SYSTEM",
         payload ? JSON.stringify(payload) : null, comment || null]
      );
    }
  } catch (e) {
    // Don't let audit failures block business operations
    logger.error("Audit log write failed", { error: e.message, entityType, entityId, eventType });
  }
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
