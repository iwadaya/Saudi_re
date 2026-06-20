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

import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { logAudit } from '../services/audit.js';
import { auditMutation } from '../lib/mutationAudit.js';
import { signAuthToken } from '../lib/authToken.js';
import { setAuthCookies, readCookie } from '../lib/authCookies.js';
import { createSession, revokeAllForUser } from '../services/sessions.js';
import { getIdentityConfig, isSsoEnabled, acrSatisfied } from '../config/identity.js';
import { startLogin, completeLogin } from '../services/identity/oidcClient.js';
import { provisionFromClaims } from '../services/identity/provisioning.js';
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
  if (!tx) return res.status(400).json({ error: 'Login session expired or invalid — please try again.', code: 'SSO_STATE_INVALID' });

  // Reconstruct the absolute callback URL from the configured redirect URI +
  // the incoming query (stable regardless of proxy host headers).
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const currentUrl = `${cfg.redirectUri}${qs}`;

  let claims;
  try {
    claims = await completeLogin(currentUrl, { state: tx.state, nonce: tx.nonce, codeVerifier: tx.codeVerifier }, cfg);
  } catch (e) {
    logger.warn('sso callback: code exchange failed', { error: e.message });
    return res.status(401).json({ error: 'SSO sign-in failed.', code: 'SSO_EXCHANGE_FAILED' });
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
    return res.status(403).json({ error: 'Multi-factor authentication is required to sign in.', code: 'SSO_MFA_REQUIRED' });
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
    logger.error('sso callback: provisioning/session failed', { error: e.message });
    return res.status(500).json({ error: 'SSO sign-in could not be completed.', code: 'SSO_PROVISION_FAILED' });
  } finally {
    cl.release();
  }

  setAuthCookies(res, signAuthToken({ sub: provisioned.userId, sid: session.sessionId, epoch: session.epoch }));
  return res.redirect(safeReturnTo(tx.returnTo));
}));

export default router;
