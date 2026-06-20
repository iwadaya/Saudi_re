// server/src/lib/ssoStateCookie.js
// P1-identity Phase 1a — short-lived signed cookie carrying the OIDC auth-code
// flow secrets (state, nonce, PKCE verifier) from /sso/login to /sso/callback.
//
// Same HMAC-SHA256 construction as lib/authToken.js (no new dependency):
//   <payloadB64url>.<sigB64url>   payload = { ...data, exp }
// httpOnly + SameSite=Lax (the callback is a top-level cross-site redirect back
// from the IdP, so Strict would drop the cookie). Tied to the /api/auth/sso path
// and a tight TTL so it exists only for the duration of one login attempt.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export const SSO_STATE_COOKIE = 'sso_tx';
const TTL_SECONDS = 600; // 10 minutes to complete the IdP round-trip

function secret() {
  const s = env.authJwtSecret;
  if (!s) throw new Error('AUTH_JWT_SECRET is not configured (validateEnv was bypassed).');
  return s;
}
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');

/** Sign the per-attempt flow secrets into a compact token. */
export function signSsoState({ state, nonce, codeVerifier, returnTo = null }, ttlSeconds = TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ state, nonce, codeVerifier, returnTo, exp })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify + decode; returns null on bad signature, malformed, or expiry. */
export function verifySsoState(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || !payload.state || !payload.codeVerifier) return null;
  if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp)) return null;
  return payload;
}

/** Cookie options for the tx cookie — httpOnly, Lax (survives the IdP redirect). */
export function ssoStateCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/api/auth/sso',
    maxAge: TTL_SECONDS * 1000,
  };
}
