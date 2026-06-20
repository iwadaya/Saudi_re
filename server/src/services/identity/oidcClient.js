// server/src/services/identity/oidcClient.js
// P1-identity Phase 1a — thin wrapper over openid-client (certified OIDC RP).
//
// Isolates ALL network/crypto interaction with the IdP so the rest of the app
// deals only in plain claims objects. Provider-agnostic: everything comes from
// the IDENTITY_* configuration (config/identity.js); no provider is hard-coded.
// Inert until SSO is enabled — getConfiguration() throws if called while off or
// misconfigured, and the routes guard on isSsoEnabled() before reaching here.
//
// Discovery is performed once and cached per (issuer, clientId) so we don't hit
// the IdP's well-known endpoint on every login. Auth-code flow uses PKCE (S256)
// + state + nonce; the per-attempt secrets are handed back to the caller to
// stash in a short-lived signed cookie and replayed on the callback.

import * as oidc from 'openid-client';
import { getIdentityConfig } from '../../config/identity.js';

let cached = null; // { key, config }

/**
 * Lazily discover + cache the RP Configuration from IDENTITY_* config.
 * @param {object} [cfg] identity config (defaults to live env).
 * @returns {Promise<import('openid-client').Configuration>}
 */
export async function getConfiguration(cfg = getIdentityConfig()) {
  if (!cfg.ssoEnabled) throw new Error('SSO is not enabled (IDENTITY_SSO_ENABLED).');
  if (!cfg.issuer || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('SSO is misconfigured: IDENTITY_ISSUER, IDENTITY_CLIENT_ID and IDENTITY_CLIENT_SECRET are required.');
  }
  const key = `${cfg.issuer}|${cfg.clientId}`;
  if (cached && cached.key === key) return cached.config;
  // 3rd arg as a string is treated as the client_secret (confidential client).
  const config = await oidc.discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret);
  cached = { key, config };
  return config;
}

/** Reset the discovery cache (tests / config reload). */
export function _resetConfigurationCache() {
  cached = null;
}

/**
 * Begin an auth-code+PKCE login. Returns the authorization URL to redirect the
 * browser to, plus the per-attempt secrets (state, nonce, codeVerifier) the
 * caller must persist (signed cookie) and replay on the callback.
 * @returns {Promise<{ authorizationUrl: string, state: string, nonce: string, codeVerifier: string }>}
 */
export async function startLogin(cfg = getIdentityConfig()) {
  const config = await getConfiguration(cfg);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  const params = {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  };
  // Ask the IdP to assert the required assurance up front when configured (we
  // STILL re-verify acr/amr on the returned token in-app — D2 — never trusting
  // the request alone).
  if (cfg.requiredAcr.length) params.acr_values = cfg.requiredAcr.join(' ');

  const authorizationUrl = oidc.buildAuthorizationUrl(config, params).href;
  return { authorizationUrl, state, nonce, codeVerifier };
}

/**
 * Complete the callback: exchange the code (validating state, nonce + PKCE) and
 * return the verified ID-token claims.
 * @param {string} currentUrl absolute callback URL including the query string.
 * @param {{ state: string, nonce: string, codeVerifier: string }} checks replayed secrets.
 * @returns {Promise<object>} verified ID token claims.
 */
export async function completeLogin(currentUrl, { state, nonce, codeVerifier }, cfg = getIdentityConfig()) {
  const config = await getConfiguration(cfg);
  const tokens = await oidc.authorizationCodeGrant(config, new URL(currentUrl), {
    expectedState: state,
    expectedNonce: nonce,
    pkceCodeVerifier: codeVerifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || !claims.sub) throw new Error('ID token is missing a subject (sub) claim.');
  return claims;
}

/**
 * Build the RP-initiated logout (end-session) URL, or null when the IdP exposes
 * no end_session_endpoint. Per the spec, client_id is sent when no id_token_hint
 * is available so the IdP can still identify the RP.
 * @returns {Promise<string|null>}
 */
export async function buildLogoutUrl(cfg = getIdentityConfig(), { idTokenHint = null, logoutHint = null } = {}) {
  const config = await getConfiguration(cfg);
  const meta = config.serverMetadata();
  if (!meta.end_session_endpoint) return null;
  const params = {};
  if (cfg.postLogoutRedirectUri) params.post_logout_redirect_uri = cfg.postLogoutRedirectUri;
  if (idTokenHint) params.id_token_hint = idTokenHint;
  else params.client_id = cfg.clientId;
  if (logoutHint) params.logout_hint = logoutHint;
  return oidc.buildEndSessionUrl(config, params).href;
}

/** Resolve the issuer's JWKS key set (for logout-token verification). */
export async function getJwksUri(cfg = getIdentityConfig()) {
  const config = await getConfiguration(cfg);
  const uri = config.serverMetadata().jwks_uri;
  if (!uri) throw new Error('issuer metadata has no jwks_uri');
  return uri;
}
