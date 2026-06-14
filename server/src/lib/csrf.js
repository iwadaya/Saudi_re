// server/src/lib/csrf.js
// Stateless, signed CSRF tokens for the double-submit-cookie defense (no new
// dependency — same HMAC-SHA256 primitive as authToken.js). Format:
//   <nonceB64url>.<sigB64url>   where sig = HMAC(secret, nonce)
//
// The signature is what makes the double-submit robust: an attacker who can read
// the readable csrf cookie cross-origin is already blocked by the same-origin
// policy, and one who tries to *inject* a cookie (subdomain / MITM) still cannot
// forge a valid signature without the server secret. So a request only passes
// when its X-CSRF-Token header equals the csrf cookie AND the value is signed.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

// Prefer the dedicated session secret; fall back to the auth-token secret so a
// deployment that sets only AUTH_JWT_SECRET still gets signed CSRF tokens. Both
// are strength-validated in production (config/env.js → checkSecretsConfig).
function secret() {
  const s = env.sessionSecret || env.authJwtSecret;
  if (!s) throw new Error('No SESSION_SECRET/AUTH_JWT_SECRET configured for CSRF tokens.');
  return s;
}

/** Mint a fresh signed CSRF token. */
export function issueCsrfToken() {
  const nonce = randomBytes(18).toString('base64url');
  const sig = createHmac('sha256', secret()).update(nonce).digest('base64url');
  return `${nonce}.${sig}`;
}

/** True when the token carries a valid signature (does NOT check the
 *  double-submit header↔cookie match — that's the middleware's job). */
export function verifyCsrfToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return false;
  const [nonce, sig] = token.split('.');
  if (!nonce || !sig) return false;
  const expected = createHmac('sha256', secret()).update(nonce).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
