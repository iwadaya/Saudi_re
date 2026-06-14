// server/src/lib/authToken.js
// Stateless signed auth tokens (HMAC-SHA256, no new dependency). Format:
//   <payloadB64url>.<sigB64url>   where payload = { sub, iat, exp }
// The token carries only the user id (sub); role/level are ALWAYS re-read from
// the DB on each request (see middleware/requestContext.js), so a token issued
// before a demotion cannot carry elevated rights.
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.AUTH_JWT_SECRET || process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const DEFAULT_TTL_S = Math.max(1, Number(process.env.SESSION_TTL_HOURS) || 8) * 3600;

function sign(data) {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function signAuthToken({ sub }, ttlSeconds = DEFAULT_TTL_S) {
  if (!sub) throw new Error('signAuthToken: sub required');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds })).toString('base64url');
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
