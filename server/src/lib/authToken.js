// server/src/lib/authToken.js
// Stateless signed auth tokens (HMAC-SHA256, no new dependency). Format:
//   <payloadB64url>.<sigB64url>   where payload = { sub, iat, exp }
// The token carries only the user id (sub); role/level are ALWAYS re-read from
// the DB on each request (see middleware/requestContext.js), so a token issued
// before a demotion cannot carry elevated rights.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const DEFAULT_TTL_S = Math.max(1, Number(process.env.SESSION_TTL_HOURS) || 8) * 3600;

// The token's lifetime in seconds — exported so the auth cookie's Max-Age can be
// kept in lock-step with the signed token's exp (see lib/authCookies.js).
export const AUTH_TOKEN_TTL_SECONDS = DEFAULT_TTL_S;

// Read from the validated env config — no inline literal fallback. If the
// secret is absent (only possible if validateEnv() was bypassed) we throw
// rather than sign/verify with an empty/guessable key.
function secret() {
  const s = env.authJwtSecret;
  if (!s) throw new Error('AUTH_JWT_SECRET is not configured (validateEnv was bypassed).');
  return s;
}

function sign(data) {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

/**
 * Sign an auth token. `sub` is the user id; `sid` is the server-side session id
 * (P1-identity Phase 0a) and `epoch` is the user's revocation epoch at mint time
 * — both echoed back by verifyAuthToken and checked by the authenticate
 * middleware against the live auth_session row + uw_user.session_epoch. `sid`/
 * `epoch` are optional so legacy callers (and unit tests) still produce a valid
 * token; a token without a `sid` simply has no live session and is rejected at
 * authentication.
 */
export function signAuthToken({ sub, sid = null, epoch = 0 }, ttlSeconds = DEFAULT_TTL_S) {
  if (!sub) throw new Error('signAuthToken: sub required');
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub, iat: now, exp: now + ttlSeconds, epoch: Number(epoch) || 0 };
  if (sid) claims.sid = sid;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyAuthToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || !payload.sub) return null;
  if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp)) return null;
  return payload;
}
