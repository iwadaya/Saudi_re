// server/src/routes/sso.js
// P1-identity Phase 1a — OIDC SSO login + callback (auth-code + PKCE).
//
// Two public GET endpoints (no auth, no CSRF — they ARE the authentication):
//   GET /api/auth/sso/login    → start the flow; stash state/nonce/PKCE in a
//                                 short-lived signed cookie; 302 to the IdP.
//   GET /api/auth/sso/callback → exchange the code (validate state/nonce/PKCE),
//                                 enforce assurance IN-APP (D2), JIT-provision
//                                 the user (D3), then issue a normal server-side
//                                 session (Phase 0a) so revocation/epoch all work.
//
// Inert until IDENTITY_SSO_ENABLED=true: both routes 404 while SSO is off so the
// surface simply doesn't exist in the default posture.

import { Router, urlencoded } from 'express';
import { asyncHandler } from '../helpers.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { logAudit } from '../services/audit.js';
import { auditMutation } from '../lib/mutationAudit.js';
import { signAuthToken, verifyAuthToken } from '../lib/authToken.js';
import { setAuthCookies, clearAuthCookies, readCookie, AUTH_COOKIE } from '../lib/authCookies.js';
import {
  createSession, revokeAllForUser, revokeSession,
  revokeSessionsByIdpSid, revokeSessionsByIdpSub,
} from '../services/sessions.js';
import { getIdentityConfig, isSsoEnabled, acrSatisfied } from '../config/identity.js';
import { startLogin, completeLogin, buildLogoutUrl } from '../services/identity/oidcClient.js';
import { provisionFromClaims } from '../services/identity/provisioning.js';
import { validateLogoutToken } from '../services/identity/backchannelLogout.js';
import { emitSecurityAlert } from '../services/securityAlerts.js';
import {
  SSO_STATE_COOKIE, signSsoState, verifySsoState, ssoStateCookieOptions,
} from '../lib/ssoStateCookie.js';

const router = Router();

function clientIp(req) {
  try { return req.ip || req.socket?.remoteAddress || null; } catch { return null; }
}

// Only allow same-origin, single-leading-slash relative paths as a post-login
// landing target — never an absolute/protocol-relative URL (open-redirect guard).
function safeReturnTo(raw) {
  const s = String(raw || '');
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  return s;
}

// Front-channel failures bounce back to the SPA login with a code (the browser
// is here via a top-level redirect from the IdP — show UI, not raw JSON).
const loginError = (res, code) => res.redirect(`/login?sso_error=${encodeURIComponent(code)}`);

// ── GET /api/auth/sso/status — public posture probe (always answers) ────────
// Lets the SPA decide whether to show the "Sign in with SSO" button without
// leaking anything sensitive. NOT behind the SSO-off 404 guard.
router.get('/auth/sso/status', (req, res) => {
  const cfg = getIdentityConfig();
  res.json({ enabled: isSsoEnabled(cfg), provider: cfg.provider });
});

// ── GET /api/auth/sso/login ─────────────────────────────────────────────────
router.get('/auth/sso/login', asyncHandler(async (req, res) => {
  if (!isSsoEnabled()) return res.status(404).json({ error: 'SSO is not enabled.', code: 'SSO_DISABLED' });
  const cfg = getIdentityConfig();
  const { authorizationUrl, state, nonce, codeVerifier } = await startLogin(cfg);
  const tx = signSsoState({ state, nonce, codeVerifier, returnTo: safeReturnTo(req.query.returnTo) });
  res.cookie(SSO_STATE_COOKIE, tx, ssoStateCookieOptions());
  return res.redirect(authorizationUrl);
}));

// ── GET /api/auth/sso/callback ──────────────────────────────────────────────
router.get('/auth/sso/callback', asyncHandler(async (req, res) => {
  if (!isSsoEnabled()) return res.status(404).json({ error: 'SSO is not enabled.', code: 'SSO_DISABLED' });
  const cfg = getIdentityConfig();

  // Replay the per-attempt secrets from the signed tx cookie.
  const txToken = readCookie(req, SSO_STATE_COOKIE);
  const tx = txToken ? verifySsoState(txToken) : null;
  res.clearCookie(SSO_STATE_COOKIE, ssoStateCookieOptions());
  if (!tx) return loginError(res, 'expired');

  // Reconstruct the absolute callback URL from the configured redirect URI +
  // the incoming query (stable regardless of proxy host headers).
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const currentUrl = `${cfg.redirectUri}${qs}`;

  let claims;
  try {
    claims = await completeLogin(currentUrl, { state: tx.state, nonce: tx.nonce, codeVerifier: tx.codeVerifier }, cfg);
  } catch (e) {
    logger.warn('sso callback: code exchange failed', { error: e.message });
    return loginError(res, 'failed');
  }

  // D2 — enforce the required assurance IN-APP, never trusting the IdP alone.
  const assurance = acrSatisfied(claims, cfg);
  if (!assurance.ok) {
    await logAudit(pool, {
      entityType: 'USER', entityId: claims.sub, eventType: 'SSO_ACR_DENIED',
      actor: { id: null, name: claims.preferred_username || claims.email || claims.sub },
      payload: { reasons: assurance.reasons },
    }).catch(() => {});
    emitSecurityAlert('SSO_ACR_DENIED', { sub: claims.sub, reasons: assurance.reasons });
    return loginError(res, 'mfa_required');
  }

  // Provision + issue a session in ONE transaction. A role change bumps the
  // epoch (revokes other sessions) before the new session is minted under it.
  const cl = await pool.connect();
  let session;
  let provisioned;
  try {
    await cl.query('BEGIN');
    provisioned = await provisionFromClaims(cl, claims, cfg);
    if (provisioned.roleChanged) await revokeAllForUser(provisioned.userId, 'ROLE_CHANGE', cl);
    session = await createSession({
      userId: provisioned.userId,
      authMethod: 'SSO_OIDC',
      amr: Array.isArray(claims.amr) ? claims.amr : null,
      idpSub: claims.sub,
      idpSid: claims.sid || null,
      ip: clientIp(req),
      userAgent: req.headers?.['user-agent'] || null,
    }, cl);
    await auditMutation(cl, { user: { userId: provisioned.userId, displayName: provisioned.username }, authVia: 'sso' }, {
      entityType: 'USER', entityId: provisioned.userId, eventType: 'SSO_LOGIN',
      payload: { created: provisioned.created, role: provisioned.roleCode, role_changed: provisioned.roleChanged, idp_sub: claims.sub },
    });
    await cl.query('COMMIT');
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    if (e?.code === 'ACCOUNT_DEACTIVATED') {
      logger.warn('sso callback: login refused for deactivated account', { sub: claims.sub });
      return loginError(res, 'account_disabled');
    }
    logger.error('sso callback: provisioning/session failed', { error: e.message });
    return loginError(res, 'failed');
  } finally {
    cl.release();
  }

  setAuthCookies(res, signAuthToken({ sub: provisioned.userId, sid: session.sessionId, epoch: session.epoch }));
  return res.redirect(safeReturnTo(tx.returnTo));
}));

// ── GET /api/auth/sso/logout — RP-initiated logout ──────────────────────────
// Revoke THIS device's local session, clear cookies, then bounce to the IdP's
// end-session endpoint (so the IdP session ends too). Falls back to a local
// redirect when the IdP exposes no end_session_endpoint.
router.get('/auth/sso/logout', asyncHandler(async (req, res) => {
  if (!isSsoEnabled()) return res.status(404).json({ error: 'SSO is not enabled.', code: 'SSO_DISABLED' });
  const cfg = getIdentityConfig();

  const token = readCookie(req, AUTH_COOKIE);
  const payload = token ? verifyAuthToken(token) : null;
  if (payload?.sid) {
    await revokeSession(payload.sid, 'LOGOUT').catch(() => {});
    await logAudit(pool, {
      entityType: 'USER', entityId: payload.sub, eventType: 'SESSION_REVOKED',
      actor: { id: payload.sub, name: null }, payload: { reason: 'SSO_RP_LOGOUT', session_id: payload.sid },
    }).catch(() => {});
  }
  clearAuthCookies(res);

  let url = null;
  try { url = await buildLogoutUrl(cfg); } catch (e) { logger.warn('sso logout: end-session url failed', { error: e.message }); }
  return res.redirect(url || safeReturnTo(req.query.returnTo));
}));

// ── POST /api/auth/sso/backchannel-logout — IdP-initiated logout ────────────
// Unauthenticated server-to-server POST from the IdP carrying a signed
// logout_token. We VERIFY it (signature/iss/aud/event/no-nonce) before revoking
// the matching session(s) — by IdP session id when present, else every session
// for the IdP subject. CSRF-exempt by construction (no cookie auth). Spec: 200
// with Cache-Control: no-store.
router.post('/auth/sso/backchannel-logout', urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  if (!isSsoEnabled()) return res.status(404).json({ error: 'SSO is not enabled.', code: 'SSO_DISABLED' });
  const cfg = getIdentityConfig();
  res.set('Cache-Control', 'no-store');

  const logoutToken = req.body?.logout_token;
  if (!logoutToken) return res.status(400).json({ error: 'logout_token is required.', code: 'LOGOUT_TOKEN_MISSING' });

  let claims;
  try {
    claims = await validateLogoutToken(logoutToken, cfg);
  } catch (e) {
    logger.warn('sso backchannel-logout: invalid token', { error: e.message });
    return res.status(400).json({ error: 'Invalid logout token.', code: 'LOGOUT_TOKEN_INVALID' });
  }

  const revoked = claims.sid
    ? await revokeSessionsByIdpSid(claims.sid, 'BACKCHANNEL_LOGOUT')
    : await revokeSessionsByIdpSub(claims.sub, 'BACKCHANNEL_LOGOUT');

  await logAudit(pool, {
    entityType: 'USER', entityId: claims.sub, eventType: 'SSO_BACKCHANNEL_LOGOUT',
    actor: { id: null, name: 'IDP' },
    payload: { idp_sid: claims.sid, idp_sub: claims.sub, sessions_revoked: revoked },
  }).catch(() => {});

  return res.status(200).json({ ok: true, sessions_revoked: revoked });
}));

export default router;
