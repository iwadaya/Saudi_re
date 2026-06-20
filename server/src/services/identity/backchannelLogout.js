// server/src/services/identity/backchannelLogout.js
// P1-identity Phase 1b — validate an OIDC Back-Channel Logout 1.0 `logout_token`.
//
// The IdP POSTs a signed logout_token (a JWT) to our back-channel endpoint when a
// session ends at the IdP. We must verify it BEFORE acting on it (it's an
// unauthenticated server-to-server POST): correct signature from the issuer's
// keys, correct iss/aud, an `iat`, a back-channel-logout `events` claim, at least
// one of sub/sid, and crucially NO `nonce` (a nonce means it's an ID token being
// replayed, not a logout token). Returns { sub, sid } for session targeting.

import * as jose from 'jose';
import { getJwksUri } from './oidcClient.js';

const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

// Cache one remote JWKS resolver per issuer (jose caches keys internally too).
let cachedJwks = null; // { uri, keyset }

async function defaultJwks(cfg) {
  const uri = await getJwksUri(cfg);
  if (cachedJwks && cachedJwks.uri === uri) return cachedJwks.keyset;
  const keyset = jose.createRemoteJWKSet(new URL(uri));
  cachedJwks = { uri, keyset };
  return keyset;
}

/** Reset the JWKS cache (tests / config reload). */
export function _resetJwksCache() {
  cachedJwks = null;
}

/**
 * Verify a logout_token and extract its session-targeting claims.
 * @param {string} token the raw logout_token JWT.
 * @param {object} cfg identity config (issuer/clientId).
 * @param {{ jwks?: import('jose').JWTVerifyGetKey | import('jose').KeyLike }} [opts]
 *        injectable key resolver (defaults to the issuer's remote JWKS).
 * @returns {Promise<{ sub: string|null, sid: string|null }>}
 */
export async function validateLogoutToken(token, cfg, { jwks } = {}) {
  if (!token || typeof token !== 'string') throw new Error('logout_token is required');
  const keyset = jwks || (await defaultJwks(cfg));

  const { payload } = await jose.jwtVerify(token, keyset, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
  });

  if (!payload.iat) throw new Error('logout_token is missing iat');
  if (!payload.sub && !payload.sid) throw new Error('logout_token must contain sub and/or sid');
  if ('nonce' in payload) throw new Error('logout_token must not contain a nonce');

  const events = payload.events;
  if (!events || typeof events !== 'object' || !(BACKCHANNEL_EVENT in events)) {
    throw new Error('logout_token is missing the back-channel logout event');
  }

  return { sub: payload.sub || null, sid: payload.sid || null };
}
