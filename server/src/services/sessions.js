// server/src/services/sessions.js
// P1-identity Phase 0a — server-side session lifecycle + revocation primitives.
//
// The auth token carries an opaque session id (`sid`) and the user's revocation
// `epoch`. A request authenticates only while BOTH hold: the auth_session row is
// live (not revoked, not expired) AND the token's epoch equals uw_user.session_epoch.
//
// Two revocation levers:
//   • revokeSession(sid)      — per-device logout (one row).
//   • revokeAllForUser(uid)   — mass-revoke (revoke live rows + bump the epoch),
//                               used on password change / role change / deactivation
//                               (Phase 0b). The epoch bump invalidates every
//                               outstanding token for the user atomically, even one
//                               whose session row was somehow missed.
//
// All mutating helpers accept an optional pg client so the caller can run them
// INSIDE the mutation's transaction (so a rolled-back admin change doesn't leave
// a phantom revocation, and vice-versa).

import { pool } from '../db/pool.js';
import { AUTH_TOKEN_TTL_SECONDS } from '../lib/authToken.js';

/**
 * Create a session row and return the identifiers the token must carry.
 * @returns {Promise<{ sessionId: string, expiresAt: Date, epoch: number }>}
 */
export async function createSession(
  { userId, ttlSeconds = AUTH_TOKEN_TTL_SECONDS, authMethod = 'PASSWORD', amr = null, idpSub = null, idpSid = null, ip = null, userAgent = null },
  client = pool,
) {
  if (!userId) throw new Error('createSession: userId required');
  const { rows } = await client.query(
    `INSERT INTO public.auth_session
       (user_id, expires_at, auth_method, amr, idp_sub, idp_sid, ip, user_agent)
     VALUES ($1, now() + ($2 || ' seconds')::interval, $3, $4, $5, $6, $7, $8)
     RETURNING session_id, expires_at`,
    [userId, String(Math.max(1, Math.floor(ttlSeconds))), authMethod, amr, idpSub, idpSid, ip, userAgent],
  );
  const { rows: er } = await client.query(
    `SELECT session_epoch FROM public.uw_user WHERE user_id = $1`, [userId],
  );
  return { sessionId: rows[0].session_id, expiresAt: rows[0].expires_at, epoch: er[0]?.session_epoch ?? 0 };
}

/** Revoke a single session (per-device logout). Returns true if a live row was revoked. */
export async function revokeSession(sessionId, reason = 'LOGOUT', client = pool) {
  if (!sessionId) return false;
  const { rowCount } = await client.query(
    `UPDATE public.auth_session
        SET revoked_at = now(), revoked_reason = $2
      WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return rowCount > 0;
}

/**
 * Mass-revoke every token for a user: revoke all live session rows AND bump the
 * per-user epoch (the epoch bump alone invalidates outstanding tokens; revoking
 * the rows keeps the session inventory honest). Returns the number of live
 * sessions revoked.
 */
export async function revokeAllForUser(userId, reason = 'ADMIN', client = pool) {
  if (!userId) return 0;
  const { rowCount } = await client.query(
    `UPDATE public.auth_session
        SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  await client.query(
    `UPDATE public.uw_user SET session_epoch = session_epoch + 1, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
  return rowCount;
}

/**
 * Revoke sessions by IdP session id (OIDC back-channel logout, preferred path —
 * targets exactly the device whose IdP session ended). Returns count revoked.
 */
export async function revokeSessionsByIdpSid(idpSid, reason = 'BACKCHANNEL_LOGOUT', client = pool) {
  if (!idpSid) return 0;
  const { rowCount } = await client.query(
    `UPDATE public.auth_session
        SET revoked_at = now(), revoked_reason = $2
      WHERE idp_sid = $1 AND revoked_at IS NULL`,
    [idpSid, reason],
  );
  return rowCount;
}

/**
 * Revoke ALL sessions for an IdP subject (back-channel logout fallback when the
 * logout_token carries only `sub`). Returns count revoked.
 */
export async function revokeSessionsByIdpSub(idpSub, reason = 'BACKCHANNEL_LOGOUT', client = pool) {
  if (!idpSub) return 0;
  const { rowCount } = await client.query(
    `UPDATE public.auth_session
        SET revoked_at = now(), revoked_reason = $2
      WHERE idp_sub = $1 AND revoked_at IS NULL`,
    [idpSub, reason],
  );
  return rowCount;
}
