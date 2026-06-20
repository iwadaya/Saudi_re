// server/src/lib/mutationAudit.js
// Standardised in-transaction audit for MUTATING endpoints (P1-validation).
//
// Every mutation should record an audit event on the SAME transaction client as
// the write itself, with the actor resolved from the VERIFIED request identity,
// and as a `critical` write so a failed audit rolls the mutation back (no
// mutation without a trail). Hand-rolling that at each call site drifts: some
// routes pass `pool` from inside a txn (phantom event), some forget the actor,
// some omit `critical`. This helper makes the correct pattern the easy one.
//
//   const cl = await pool.connect();
//   try {
//     await cl.query('BEGIN');
//     // …mutation on cl…
//     await auditMutation(cl, req, {
//       entityType: 'QUOTE', entityId: id, eventType: 'COBS_SAVED', payload: { count },
//     });
//     await cl.query('COMMIT');
//   } catch (e) { await cl.query('ROLLBACK').catch(() => {}); throw e; }
//   finally { cl.release(); }
//
// See services/audit.js for the transaction-client requirement this enforces.

import { logAudit } from '../services/audit.js';
import { actorFromReq } from '../middleware/requestContext.js';

/**
 * Record a mutation's audit event on the mutation's own transaction client.
 *
 * @param {import('pg').PoolClient} client  the SAME client running the mutation (NOT pool).
 * @param {object} req                       Express request (verified identity in req.user).
 * @param {object} event                     { entityType, entityId, eventType, payload?, comment? }
 * @param {{ critical?: boolean }} [opts]    defaults to critical:true (rolls back on audit failure).
 */
export async function auditMutation(client, req, { entityType, entityId, eventType, payload = null, comment = null }, { critical = true } = {}) {
  await logAudit(
    client,
    { entityType, entityId, eventType, actor: actorFromReq(req), payload, comment },
    { critical },
  );
}
