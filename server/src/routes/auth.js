// server/src/routes/auth.js
// Authentication, user management, and mandate resolution.
// Passwords are scrypt-hashed via lib/passwordHash.js — ASYNC (off the event
// loop) and at a calibrated, tunable cost (PASSWORD_SCRYPT_COST). A single shared
// policy (validatePasswordStrength) gates every place a password is set —
// change-password and ALL user-creation paths. No path stores a static/demo
// hash; an admin create with no password gets a generated, scrypt-hashed temp
// and must_change_password=true. The 'demo2026' shortcut is a dev/test-only
// backdoor gated behind ALLOW_DEMO_AUTH and is never honoured in production.

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { hashPassword, verifyPassword, needsRehash } from '../lib/passwordHash.js';
import { logAudit } from '../services/audit.js';
import { signAuthToken, verifyAuthToken } from '../lib/authToken.js';
import { setAuthCookies, clearAuthCookies, readCookie, AUTH_COOKIE } from '../lib/authCookies.js';
import { requireAuth, requireMinLevel, actorFromReq } from '../middleware/requestContext.js';
import { createSession, revokeSession, revokeAllForUser } from '../services/sessions.js';
import { auditMutation } from '../lib/mutationAudit.js';
import { isSsoEnabled, isBreakGlassUser } from '../config/identity.js';
import { emitSecurityAlert } from '../services/securityAlerts.js';

const router = Router();

// req.ip goes through proxy-addr, which throws if there's no socket (e.g. a
// synthetic test request) — read the client IP defensively (it's advisory).
function clientIp(req) {
  try { return req.ip || req.socket?.remoteAddress || null; } catch { return null; }
}

// Public auth endpoints (no identity needed): login, the login-screen lookups,
// and user creation (which self-gates open-registration vs authenticated CU/CE).
// Everything else under /auth (e.g. /auth/me, mandates) requires a real
// identity — authenticate() has already run and set req.user.
const PUBLIC_AUTH = new Set([
  'POST /auth/login',
  'POST /auth/logout',
  'GET /auth/users',
  'GET /auth/roles',
  'POST /auth/users',
]);
router.use((req, res, next) => {
  if (PUBLIC_AUTH.has(`${req.method} ${req.path}`)) return next();
  if (req.user) return next();
  return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
});

// ─── helpers ───────────────────────────────────────────────────────────────
const DEMO_PASSWORD = 'demo2026';
// The seeded forced-change temp password (migration 123). Forbidden as a real
// password everywhere so a must-change user can't "change" to the temp and an
// admin can't (re)create a user holding it.
const TEMP_SEED_PASSWORD = 'Universe#1234';

// ── Single shared password policy ────────────────────────────────────────────
// The ONE place password strength is defined. Used by change-password AND every
// user-creation path so the rules can never drift apart again.
const MIN_PASSWORD_LENGTH = 12;

// Obvious weak/common values rejected outright (compared case-insensitively).
// Anything shorter than MIN_PASSWORD_LENGTH is already rejected on length, so
// this list targets the common 12+ char offenders (plus shorter classics kept
// as belt-and-braces in case the minimum is ever lowered).
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd',
  'passwordpassword', '123456789012', '1234567890', '123456789', '12345678', '87654321',
  'qwerty12', 'qwerty123', 'qwertyuiop', 'qwertyuiop12', 'asdfghjkl', 'asdfghjkl123',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'superman',
  'welcome1', 'welcome123', 'welcome123456', 'letmein1', 'letmein123', 'letmein123456',
  'admin123', 'administrator', 'changeme', 'changeme1', 'changeme1234', 'abc12345',
]);

/**
 * Single shared password-strength policy. Returns an error message string when
 * the candidate is unacceptable, or null when it passes. Rejects: too-short
 * (< MIN_PASSWORD_LENGTH), the shared seeded temp password, and obviously weak
 * values (common list, all-one-character, all-digits).
 *
 * @param {string} pw
 * @returns {string|null}
 */
export function validatePasswordStrength(pw) {
  const s = String(pw ?? '');
  if (s.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (s === TEMP_SEED_PASSWORD) {
    return 'Choose a different password — the temporary password cannot be reused.';
  }
  if (WEAK_PASSWORDS.has(s.toLowerCase())) {
    return 'Password is too common — choose something less guessable.';
  }
  if (/^(.)\1+$/.test(s)) {            // all one repeated character
    return 'Password is too weak — choose something less guessable.';
  }
  if (/^\d+$/.test(s)) {               // all digits
    return 'Password must not be all numbers.';
  }
  return null;
}

// Password hashing lives in lib/passwordHash.js (async scrypt, calibrated +
// tunable cost, backward-compatible with legacy `scrypt$salt$hash` rows). It is
// async so the derivation never blocks the event loop on the login hot path.
// Re-exported here so existing importers (and tests) keep their import surface.
export { hashPassword, verifyPassword };

/** Generate a strong, unique one-time temp password (never a shared literal).
 *  Returned to the admin who created the account; the user must change it on
 *  first login (must_change_password=true). ~16 chars, URL-safe. */
function generateTempPassword() {
  return randomBytes(12).toString('base64url');
}

// Open (login-screen) self-registration is FAIL-CLOSED (P1-identity D4): it is
// permitted ONLY when an explicit dev flag opts in (ALLOW_OPEN_REGISTRATION=true).
// Absent or any other value → disabled, in every environment including dev/test,
// so a forgotten/misset flag can never silently leave the door open. SSO is the
// default account path; local accounts are minted by an authenticated CU/CE.
function openRegistrationEnabled() {
  return process.env.ALLOW_OPEN_REGISTRATION === 'true';
}


// Static fallback — used when DB tables aren't ready yet (before migrations run)
const DEMO_USERS_FALLBACK = [
  { user_id:'00000000-0000-0000-0000-000000000001', username:'cuo', display_name:'Chief Underwriting Officer', email:'cuo@universe3.app', role_code:'CU', role_name:'Chief Underwriter', hierarchy_level:2, office:'Riyadh', treaty_limit_usd:null, approvals_required:1, is_active:true },
  { user_id:'00000000-0000-0000-0000-000000000002', username:'underwriter', display_name:'Underwriter', email:'uw@universe3.app', role_code:'TUW', role_name:'Underwriter', hierarchy_level:5, office:'Riyadh', treaty_limit_usd:10000000, approvals_required:2, is_active:true },
];

function buildSession(user) {
  return {
    userId:           user.user_id,
    username:         user.username,
    displayName:      user.display_name,
    email:            user.email,
    office:           user.office,
    roleId:           user.role_id,
    roleCode:         user.role_code,
    roleName:         user.role_name,
    hierarchyLevel:   user.hierarchy_level,
    canOverrideBelow: user.can_override_below,
    effectiveLimitUsd:    user.effective_limit_usd,
    singleRiskLimitUsd:   user.single_risk_limit_usd,
    treatyTypeScope:      user.treaty_type_scope || 'BOTH',
    approvalsRequired:    user.approvals_required || 1,
    allowedCobIds:        user.allowed_cob_ids || [],
    restrictedCobIds:     user.restricted_cob_ids || [],
    allowedCountryIds:    user.allowed_country_ids || [],
    isSystemAdmin:        user.is_system_admin || false,
    mandateActive:        user.mandate_active !== false,
    // Forced first-login password change — the client routes to a mandatory
    // "Set your password" modal while this is true (see migration 123).
    mustChangePassword:   user.must_change_password === true,
  };
}

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  // Look up user via username or email (support both)
  // Try v_user_mandate view first, fall back to direct table join if view doesn't exist yet
  let rows = [];
  try {
    const result = await pool.query(
      `SELECT vm.*
       FROM public.v_user_mandate vm
       WHERE (vm.username = $1 OR vm.email = $1)
         AND vm.is_active = true
       LIMIT 1`,
      [String(username).trim().toLowerCase()]
    );
    rows = result.rows;
  } catch (viewErr) {
    // View not yet created — try direct query
    try {
      const result = await pool.query(
        `SELECT u.*, r.role_name, r.role_code, r.hierarchy_level, r.authority_limit_usd,
                r.can_override_below, r.display_order,
                r.authority_limit_usd AS effective_limit_usd,
                NULL AS single_risk_limit_usd, 'BOTH' AS treaty_type_scope,
                1 AS approvals_required, true AS mandate_active
         FROM public.uw_user u
         JOIN public.uw_role r ON r.role_id = u.role_id
         WHERE (u.username = $1 OR u.email = $1) AND u.is_active = true
         LIMIT 1`,
        [String(username).trim().toLowerCase()]
      );
      rows = result.rows;
    } catch (tableErr) {
      // Tables don't exist yet — check static demo users (dev/test only).
      if (process.env.ALLOW_DEMO_AUTH !== 'true') {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      const lc = String(username).trim().toLowerCase();
      const demo = DEMO_USERS_FALLBACK.find(u => u.username === lc || u.email === lc);
      if (demo && password === DEMO_PASSWORD) {
        // Identity rides in the httpOnly cookie — never the JSON body.
        setAuthCookies(res, signAuthToken({ sub: demo.user_id }));
        return res.json({ session: {
          userId: demo.user_id, username: demo.username, displayName: demo.display_name,
          email: demo.email, office: demo.office, roleId: demo.user_id,
          roleCode: demo.role_code, roleName: demo.role_name,
          hierarchyLevel: demo.hierarchy_level, canOverrideBelow: demo.hierarchy_level <= 3,
          effectiveLimitUsd: demo.treaty_limit_usd, singleRiskLimitUsd: null,
          treatyTypeScope: 'BOTH', approvalsRequired: demo.approvals_required || 1,
          allowedCobIds: [], restrictedCobIds: [], allowedCountryIds: [],
          isSystemAdmin: false, mandateActive: true,
        }});
      }
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
  }

  if (!rows.length) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const user = rows[0];

  // Account lock check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(403).json({
      error: `Account locked until ${new Date(user.locked_until).toISOString()}. Contact your administrator.`,
    });
  }

  // Password check.
  //
  //   • Real accounts carry a scrypt hash ('scrypt$...') and are verified
  //     against it — this is the ONLY path accepted in production.
  //   • The universal DEMO_PASSWORD shortcut is a dev/test backdoor and is
  //     honoured ONLY when ALLOW_DEMO_AUTH=true (never in production).
  const storedHash = user.password_hash;
  const demoAuthAllowed = process.env.ALLOW_DEMO_AUTH === 'true';
  // verifyPassword is async (off-loop scrypt). Only evaluated for a real
  // scrypt hash; the demo shortcut short-circuits first so the await is skipped.
  const hashMatches = typeof storedHash === 'string' && storedHash.startsWith('scrypt$')
    && await verifyPassword(password, storedHash);
  const passwordOk = (demoAuthAllowed && password === DEMO_PASSWORD) || hashMatches;

  if (!passwordOk) {
    // Increment failed attempts (fire-and-forget)
    pool.query(
      `UPDATE public.uw_user SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts >= 4 THEN now() + interval '15 minutes' ELSE locked_until END,
        updated_at = now()
       WHERE user_id = $1`,
      [user.user_id]
    ).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  // SSO-posture gate (P1-identity Phase 0c). TOLERANT while SSO is off (default):
  // this whole block is skipped and local password login behaves exactly as
  // before. Once IDENTITY_SSO_ENABLED=true, SSO becomes the login path and a
  // local password is accepted ONLY for a configured break-glass admin (D4) —
  // and even then it is a critical, alertable event. Everyone else is told to
  // use SSO. The gate runs AFTER the password check (so we never reveal the
  // posture to an unauthenticated guesser) but BEFORE any session is issued.
  if (isSsoEnabled()) {
    if (!isBreakGlassUser(user.username)) {
      await logAudit(pool, {
        entityType: 'USER', entityId: user.user_id, eventType: 'LOCAL_LOGIN_BLOCKED',
        actor: { id: user.user_id, name: user.username || user.email },
        payload: { reason: 'SSO_REQUIRED' },
      }).catch(() => {});
      return res.status(403).json({ error: 'Local password sign-in is disabled — please sign in with SSO.', code: 'SSO_REQUIRED' });
    }
    // Break-glass login: permitted, but loudly. Audit (best-effort, so it can't
    // block an emergency login) AND raise an out-of-band security alert.
    await logAudit(pool, {
      entityType: 'USER', entityId: user.user_id, eventType: 'BREAK_GLASS_LOGIN',
      actor: { id: user.user_id, name: user.username || user.email },
      payload: { username: user.username },
    }).catch(() => {});
    emitSecurityAlert('BREAK_GLASS_LOGIN', { userId: user.user_id, username: user.username, ip: clientIp(req) });
  }

  // Reset failed attempts on success
  pool.query(
    `UPDATE public.uw_user SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
     WHERE user_id = $1`,
    [user.user_id]
  ).catch(() => {});

  // Opportunistic cost upgrade: when a real-password login verified against a
  // legacy/under-cost hash, re-hash at the current policy and persist. Best-
  // effort and fire-and-forget — it must never block or fail a valid login.
  if (hashMatches && needsRehash(storedHash)) {
    hashPassword(password)
      .then((fresh) => pool.query(
        `UPDATE public.uw_user SET password_hash = $2, updated_at = now() WHERE user_id = $1`,
        [user.user_id, fresh],
      ))
      .catch(() => {});
  }

  // At login req.user isn't set yet (this IS the authentication), so the actor
  // is the user being authenticated, built from the verified DB row.
  await logAudit(pool, {
    entityType: 'USER', entityId: user.user_id,
    eventType: 'LOGIN', actor: { id: user.user_id, name: user.username || user.email },
    payload: { office: user.office },
  }).catch(() => {});

  // Create a server-side session, then issue a signed token carrying the user id,
  // the session id (`sid`) and the user's revocation epoch. Role/level are still
  // re-read from the DB on every request; the session+epoch make the token
  // REVOCABLE (logout / password / role change / deactivation). httpOnly cookie
  // (+ readable CSRF cookie); never returned in the body.
  const sess = await createSession({
    userId: user.user_id, authMethod: 'PASSWORD',
    ip: clientIp(req), userAgent: req.headers?.['user-agent'] || null,
  });
  setAuthCookies(res, signAuthToken({ sub: user.user_id, sid: sess.sessionId, epoch: sess.epoch }));
  res.json({ session: buildSession(user) });
}));

// ── POST /api/auth/logout — revoke this session + clear the cookies ─────────
// Public + CSRF-exempt so it always succeeds in dropping the session. It now also
// REVOKES the server-side session row (per-device logout) so the token cannot be
// replayed after logout — read the session id from the (verified) cookie token.
router.post('/auth/logout', asyncHandler(async (req, res) => {
  const token = readCookie(req, AUTH_COOKIE);
  const payload = token ? verifyAuthToken(token) : null;
  if (payload?.sid) {
    const revoked = await revokeSession(payload.sid, 'LOGOUT').catch(() => false);
    // Best-effort trail (logout must always succeed in dropping the cookie, so
    // this is fire-and-forget, not a critical in-transaction write).
    if (revoked) {
      await logAudit(pool, {
        entityType: 'USER', entityId: payload.sub,
        eventType: 'SESSION_REVOKED', actor: actorFromReq(req),
        payload: { reason: 'LOGOUT', session_id: payload.sid },
      }).catch(() => {});
    }
  }
  clearAuthCookies(res);
  res.json({ ok: true });
}));

// ── GET /api/auth/me — refresh session from the verified token ─────────────
router.get('/auth/me', asyncHandler(async (req, res) => {
  // req.user is set by authenticate() from the bearer token (DB-backed).
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });

  const { rows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 AND is_active = true LIMIT 1`,
    [req.user.userId]
  );
  if (!rows.length) return res.status(401).json({ error: 'User not found or inactive.' });

  res.json({ session: buildSession(rows[0]) });
}));

// ── POST /api/auth/change-password — change your OWN password ───────────────
// Behind requireAuth; rate-limited per identity in app.js. The actor is ALWAYS
// the verified req.user.userId — there is no body/param user id, so a user can
// only ever change their own hash. Uses the same scrypt hashPassword/
// verifyPassword as login; the v1 token policy keeps the current session valid.
router.post('/auth/change-password', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.userId; // verified token identity — the ONLY actor
  const { currentPassword, newPassword, confirmPassword } = req.body || {};

  // Validation, fail-closed (order matters; messages are asserted by tests).
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'currentPassword, newPassword and confirmPassword are required.' });
  }
  // Shared strength policy (length / temp-password / weak values) — identical to
  // the rules enforced on user creation.
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return res.status(400).json({ error: strengthError });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must differ' });
  }

  // Load the caller's OWN stored hash (keyed on the verified id, never the body).
  const { rows } = await pool.query(
    `SELECT password_hash FROM public.uw_user WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });

  // Current-password check. verifyPassword returns false for any non-'scrypt$'
  // value, so a legacy/demo hash (e.g. 'DEMO_HASH_2026') can never pass and
  // demo2026 is NOT accepted here — such users must be reset by an admin first.
  if (!(await verifyPassword(currentPassword, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  // Persist the new hash, clear the forced-change flag, REVOKE every outstanding
  // session and re-issue THIS device — all in one transaction so the password and
  // the revocation can never diverge (P1-identity Phase 0b). revokeAllForUser
  // bumps the epoch, which invalidates this caller's current token too; we then
  // mint a fresh session under the new epoch and set new cookies so the device
  // that just changed its password stays logged in while every OTHER session
  // (other devices, a thief's stolen token) is killed immediately.
  const newHash = await hashPassword(newPassword);
  const cl = await pool.connect();
  let freshSession;
  try {
    await cl.query('BEGIN');
    await cl.query(
      `UPDATE public.uw_user
          SET password_hash = $2, password_changed_at = now(),
              must_change_password = false, updated_at = now()
        WHERE user_id = $1`,
      [userId, newHash]
    );
    await revokeAllForUser(userId, 'PASSWORD_CHANGE', cl);
    freshSession = await createSession(
      { userId, authMethod: 'PASSWORD', ip: clientIp(req), userAgent: req.headers?.['user-agent'] || null },
      cl,
    );
    // Critical audit on the SAME client — a failed trail rolls the change back.
    await auditMutation(cl, req, {
      entityType: 'USER', entityId: userId,
      eventType: 'PASSWORD_CHANGED', payload: { self_service: true, sessions_revoked: true },
    });
    await cl.query('COMMIT');
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cl.release();
  }

  // Keep THIS device alive: issue a token bound to the new session + epoch.
  setAuthCookies(res, signAuthToken({ sub: userId, sid: freshSession.sessionId, epoch: freshSession.epoch }));
  res.json({ ok: true });
}));

// ── GET /api/auth/users — list all users
// This endpoint is PUBLIC (the login screen populates its user selector from it
// before anyone is authenticated). Unauthenticated callers therefore get a
// MINIMAL projection — display name + role label only — never emails, offices,
// hierarchy levels or mandate/authority limits. Exposing those pre-auth is a
// PII leak and hands an attacker the material for targeted password spraying.
// Authenticated callers (e.g. the admin User Management screen) get the full
// record they need to render the admin table.
router.get('/auth/users', asyncHandler(async (req, res) => {
  const authed = Boolean(req.user);
  try {
    const { rows } = await pool.query(
      authed
        ? `SELECT
             u.user_id, u.username,
             REPLACE(u.display_name, 'Treaty Underwriter', 'Underwriter') AS display_name,
             u.email, u.office,
             u.is_active,
             REPLACE(r.role_name, 'Treaty Underwriter', 'Underwriter') AS role_name,
             r.role_code, r.hierarchy_level, r.authority_limit_usd,
             m.treaty_limit_usd, m.single_risk_limit_usd, m.treaty_type_scope,
             m.approvals_required
           FROM public.uw_user u
           JOIN public.uw_role r ON r.role_id = u.role_id
           LEFT JOIN public.user_mandate m ON m.user_id = u.user_id
           WHERE u.is_active = true
           ORDER BY u.display_name`
        : `SELECT
             u.user_id, u.username,
             REPLACE(u.display_name, 'Treaty Underwriter', 'Underwriter') AS display_name,
             REPLACE(r.role_name, 'Treaty Underwriter', 'Underwriter') AS role_name,
             r.role_code
           FROM public.uw_user u
           JOIN public.uw_role r ON r.role_id = u.role_id
           WHERE u.is_active = true
           ORDER BY u.display_name`
    );
    if (rows.length) return res.json(rows);
    // No users yet — return static demo fallback
    return res.json(DEMO_USERS_FALLBACK);
  } catch (e) {
    // Tables not yet created — return static demo fallback so login screen works
    logger.warn('auth/users: DB tables not ready, using fallback', { error: e.message.split('\n')[0] });
    return res.json(DEMO_USERS_FALLBACK);
  }
}));

// ── GET /api/auth/roles — list roles for dropdowns ────────────────────────
router.get('/auth/roles', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT role_id, role_name, role_code, hierarchy_level, authority_limit_usd, display_order
     FROM public.uw_role ORDER BY display_order`
  );
  res.json(rows);
}));

// ── POST /api/auth/users — create new user ────────────────────────────────
// Accepts two payload shapes; BOTH always persist a scrypt hash (never a static
// or demo hash), and any supplied password runs through validatePasswordStrength:
//   • Add-user form (login screen): first_name, surname, title (role_code) OR
//     role_id, password, confirm_password. Composes display_name, derives
//     username/email, and stores a scrypt hash of the chosen password.
//   • Admin form: username, display_name, email, role_id and NO password. The
//     account gets a generated, scrypt-hashed one-time temp + must_change_password
//     =true; the temp is returned to the admin to relay (never a shared literal).
router.post('/auth/users', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const isFormPayload = b.first_name != null || b.surname != null || b.password != null;

  // ── Caller gate ──
  // Authenticated creates require Chief Underwriter / Chief Executive
  // (hierarchy_level <= 2), read from the VERIFIED token identity (never a
  // header). With no identity it's an open (login-screen) create, allowed only
  // when test registration is enabled.
  if (req.user) {
    if (Number(req.user.hierarchyLevel) > 2) {
      return res.status(403).json({ error: 'Only Chief Underwriter or Chief Executive can create users.', code: 'FORBIDDEN' });
    }
  } else if (!openRegistrationEnabled()) {
    return res.status(403).json({ error: 'Open registration is disabled.' });
  }

  let displayName, finalUsername, finalEmail, roleId, passwordHash;
  // When an admin creates a user without a password we mint a one-time temp,
  // force a first-login change, and hand the temp back to the caller to relay.
  let mustChangePassword = false;
  let tempPassword = null;

  if (isFormPayload) {
    const first = String(b.first_name || '').trim();
    const last  = String(b.surname || '').trim();
    const password = b.password;
    const roleCode = b.title || b.role_code || null;
    roleId = b.role_id || null;

    // Validate
    if (!first || !last) return res.status(400).json({ error: 'first_name and surname are required.' });
    if (!roleId && !roleCode) return res.status(400).json({ error: 'A role (title) is required.' });
    if (!password) return res.status(400).json({ error: 'password is required.' });
    if (password !== b.confirm_password) return res.status(400).json({ error: 'Passwords do not match' });
    // Shared strength policy — identical to change-password.
    const strengthError = validatePasswordStrength(password);
    if (strengthError) return res.status(400).json({ error: strengthError });

    // Resolve role_id from title/role_code when not supplied directly.
    if (!roleId) {
      const { rows: roleRows } = await pool.query(
        `SELECT role_id FROM public.uw_role WHERE role_code = $1 LIMIT 1`, [roleCode]
      );
      if (!roleRows.length) return res.status(400).json({ error: `Unknown role/title "${roleCode}".` });
      roleId = roleRows[0].role_id;
    }

    displayName = `${first} ${last}`;

    // Username: supplied, else first.surname deduped with a numeric suffix.
    if (b.username) {
      finalUsername = String(b.username).trim().toLowerCase();
    } else {
      const base = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]+/g, '');
      finalUsername = base;
      let n = 1;
      while (true) {
        const { rows: dup } = await pool.query(
          `SELECT 1 FROM public.uw_user WHERE username = $1 LIMIT 1`, [finalUsername]
        );
        if (!dup.length) break;
        n += 1;
        finalUsername = `${base}${n}`;
      }
    }
    finalEmail = b.email ? String(b.email).trim().toLowerCase() : `${finalUsername}@universe3.app`;
    passwordHash = await hashPassword(password);
  } else {
    // Admin payload (no password field). Mint a strong one-time temp, hash it,
    // and force a first-login change — NEVER a static/demo hash.
    const { username, display_name, email, role_id } = b;
    if (!username || !display_name || !email || !role_id) {
      return res.status(400).json({ error: 'username, display_name, email and role_id are required.' });
    }
    displayName = display_name.trim();
    finalUsername = username.trim();
    finalEmail = email.trim().toLowerCase();
    roleId = role_id;
    tempPassword = generateTempPassword();
    passwordHash = await hashPassword(tempPassword);
    mustChangePassword = true;
  }

  const { rows } = await pool.query(
    `INSERT INTO public.uw_user
       (username, display_name, email, role_id, office, phone, company_id, password_hash, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING user_id, username, display_name, email, role_id, office, password_hash, must_change_password, created_at`,
    [finalUsername, displayName, finalEmail, roleId, b.office || 'Riyadh', b.phone || null, b.company_id || null, passwordHash, mustChangePassword]
  );

  // Create default mandate
  await pool.query(
    `INSERT INTO public.user_mandate (user_id, treaty_type_scope, approvals_required)
     VALUES ($1, 'BOTH', 1) ON CONFLICT (user_id) DO NOTHING`,
    [rows[0].user_id]
  );

  await logAudit(pool, {
    entityType: 'USER', entityId: rows[0].user_id,
    eventType: 'USER_CREATED', actor: actorFromReq(req),
    payload: { username: finalUsername, role_id: roleId, open_registration: !req.user, must_change_password: mustChangePassword },
  }).catch(() => {});

  // Surface the generated temp password to the creating admin so they can relay
  // it out-of-band (the only time it is ever exposed; it is stored only hashed).
  const out = tempPassword ? { ...rows[0], temp_password: tempPassword } : rows[0];
  res.status(201).json(out);
}));

// ── PATCH /api/auth/users/:id — update user ───────────────────────────────
// User-admin changes are CRITICAL audit events (P1-identity), written inside the
// update transaction. A role change or a deactivation also REVOKES every session
// for the target (D5: privilege changes force re-login) so a just-demoted /
// just-disabled user cannot keep acting on a stale token.
router.patch('/auth/users/:id', requireMinLevel(2), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const fields = [];
  const params = [];
  let i = 1;

  const allowed = ['display_name', 'email', 'role_id', 'office', 'phone', 'is_active', 'company_id'];
  for (const key of allowed) {
    if (b[key] !== undefined) {
      fields.push(`${key} = $${i++}`);
      params.push(b[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update.' });

  fields.push(`updated_at = now()`);
  params.push(id);

  const cl = await pool.connect();
  let out;
  try {
    await cl.query('BEGIN');

    // Snapshot the privilege-bearing fields BEFORE the write so we can classify
    // the change (role/active) and record an honest before→after diff.
    const { rows: beforeRows } = await cl.query(
      `SELECT role_id, is_active FROM public.uw_user WHERE user_id = $1 FOR UPDATE`,
      [id],
    );
    if (!beforeRows.length) {
      await cl.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found.' });
    }
    const before = beforeRows[0];

    const { rows } = await cl.query(
      `UPDATE public.uw_user SET ${fields.join(', ')} WHERE user_id = $${i} RETURNING user_id, display_name, email, role_id, office, is_active`,
      params,
    );
    out = rows[0];

    // Classify the change → event type + whether sessions must be killed.
    const roleChanged = b.role_id !== undefined && String(before.role_id) !== String(out.role_id);
    const deactivated = before.is_active === true && out.is_active === false;
    const reactivated = before.is_active === false && out.is_active === true;
    let eventType = 'USER_UPDATED';
    if (deactivated) eventType = 'USER_DEACTIVATED';
    else if (reactivated) eventType = 'USER_REACTIVATED';
    else if (roleChanged) eventType = 'USER_ROLE_CHANGED';

    // D5: a demotion/promotion or a deactivation forces re-login everywhere.
    let sessionsRevoked = false;
    if (roleChanged || deactivated) {
      await revokeAllForUser(id, deactivated ? 'DEACTIVATED' : 'ROLE_CHANGE', cl);
      sessionsRevoked = true;
    }

    await auditMutation(cl, req, {
      entityType: 'USER', entityId: id, eventType,
      payload: {
        fields: fields.filter((f) => !f.startsWith('updated_at')).map((f) => f.split(' = ')[0]),
        role_change: roleChanged ? { from: before.role_id, to: out.role_id } : undefined,
        is_active: deactivated || reactivated ? out.is_active : undefined,
        sessions_revoked: sessionsRevoked,
      },
    });

    await cl.query('COMMIT');
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cl.release();
  }

  res.json(out);
}));

// ── GET /api/auth/mandates/:userId — get full mandate for a user ───────────
router.get('/auth/mandates/:userId', asyncHandler(async (req, res) => {
  // Identity from the verified token. A user may read their OWN mandate;
  // reading anyone else's requires Chief Underwriter / Chief Executive (<=2).
  const callerId = req.user?.userId;
  const target = req.params.userId;
  if (target !== callerId && Number(req.user?.hierarchyLevel) > 2) {
    return res.status(403).json({ error: 'You may only view your own mandate.', code: 'FORBIDDEN' });
  }
  const { rows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
    [target]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json(rows[0]);
}));

// ── PUT /api/auth/mandates/:userId — set/update mandate for a user ─────────
// A mandate carries the user's authority (UW limit, single-risk limit, COB
// allow/exclude lists, treaty-type scope, approvals). Changing any of those is a
// CRITICAL audit event and FORCES re-login (D5: a UW-limit or COB-exclusion
// change bumps the epoch), so a user can't keep transacting under their old
// authority on a stale token. The whole thing runs in one transaction.
router.put('/auth/mandates/:userId', requireMinLevel(2), asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { userId } = req.params;

  // Fields whose change alters AUTHORITY (and therefore must force re-login).
  // limit_currency / effective_* / notes are descriptive and don't, by themselves.
  const AUTHORITY_FIELDS = [
    'treaty_limit_usd', 'single_risk_limit_usd', 'allowed_cob_ids',
    'restricted_cob_ids', 'allowed_country_ids', 'treaty_type_scope', 'approvals_required',
  ];
  // Order-insensitive, type-stable comparison so [a,b] vs [b,a] and 1 vs '1' match.
  const norm = (v) => (Array.isArray(v) ? JSON.stringify([...v].map(String).sort()) : JSON.stringify(v ?? null));

  const cl = await pool.connect();
  let out;
  try {
    await cl.query('BEGIN');

    const { rows: beforeRows } = await cl.query(
      `SELECT treaty_limit_usd, single_risk_limit_usd, allowed_cob_ids, restricted_cob_ids,
              allowed_country_ids, treaty_type_scope, approvals_required
         FROM public.user_mandate WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const before = beforeRows[0] || null;

    const { rows } = await cl.query(
      `INSERT INTO public.user_mandate
         (user_id, treaty_limit_usd, single_risk_limit_usd, limit_currency,
          allowed_cob_ids, restricted_cob_ids, allowed_country_ids,
          treaty_type_scope, approvals_required, effective_from, effective_to, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id) DO UPDATE SET
         treaty_limit_usd      = EXCLUDED.treaty_limit_usd,
         single_risk_limit_usd = EXCLUDED.single_risk_limit_usd,
         limit_currency        = EXCLUDED.limit_currency,
         allowed_cob_ids       = EXCLUDED.allowed_cob_ids,
         restricted_cob_ids    = EXCLUDED.restricted_cob_ids,
         allowed_country_ids   = EXCLUDED.allowed_country_ids,
         treaty_type_scope     = EXCLUDED.treaty_type_scope,
         approvals_required    = EXCLUDED.approvals_required,
         effective_from        = EXCLUDED.effective_from,
         effective_to          = EXCLUDED.effective_to,
         notes                 = EXCLUDED.notes,
         updated_at            = now()
       RETURNING *`,
      [
        userId,
        b.treaty_limit_usd ?? null,
        b.single_risk_limit_usd ?? null,
        b.limit_currency || 'USD',
        b.allowed_cob_ids || [],
        b.restricted_cob_ids || [],
        b.allowed_country_ids || [],
        b.treaty_type_scope || 'BOTH',
        b.approvals_required ?? 1,
        b.effective_from || new Date().toISOString().slice(0, 10),
        b.effective_to || null,
        b.notes || null,
      ],
    );
    out = rows[0];

    // A first-ever mandate (before === null) is treated as an authority change;
    // otherwise compare each authority field before→after.
    const changedAuthority = AUTHORITY_FIELDS.filter(
      (f) => !before || norm(before[f]) !== norm(out[f]),
    );
    let sessionsRevoked = false;
    if (changedAuthority.length) {
      await revokeAllForUser(userId, 'MANDATE_CHANGE', cl);
      sessionsRevoked = true;
    }

    await auditMutation(cl, req, {
      entityType: 'USER_MANDATE', entityId: userId,
      eventType: 'MANDATE_UPDATED',
      payload: { changed_authority: changedAuthority, sessions_revoked: sessionsRevoked },
    });

    await cl.query('COMMIT');
  } catch (e) {
    await cl.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cl.release();
  }

  res.json(out);
}));

// ── GET /api/auth/mandate-check — can this user offer a treaty? ─────────────
// Query params: contract_id OR quote_id, plus epi_usd (optional if server can compute)
router.get('/auth/mandate-check', asyncHandler(async (req, res) => {
  // Always the CALLER's own mandate, from the verified token — never a header
  // or a client-supplied id, so one user can't probe another's authority.
  const userId = req.user?.userId;
  const { contract_id, quote_id, epi_usd, cob_ids } = req.query;

  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  // Load user mandate
  const { rows: mandateRows } = await pool.query(
    `SELECT * FROM public.v_user_mandate WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (!mandateRows.length) return res.status(404).json({ error: 'User not found.' });
  const m = mandateRows[0];

  // If neither provided, just return mandate info
  if (!contract_id && !quote_id && !epi_usd) {
    return res.json({ allowed: true, mandate: buildMandateInfo(m), reasons: [] });
  }

  const reasons = [];
  let resolvedEpiUsd = epi_usd ? Number(epi_usd) : null;

  // If contract_id provided, compute EPI in USD from DB
  if (contract_id && !resolvedEpiUsd) {
    const { rows: epiRows } = await pool.query(
      `SELECT
         COALESCE(cpd.estimated_premium_income, 0)  AS epi,
         COALESCE(er.rate_to_usd, 1)                AS fx,
         cur.currency_code
       FROM public.contract c
       LEFT JOIN public.contract_prop_details cpd ON cpd.contract_id = c.contract_id
       LEFT JOIN public.currency cur ON cur.currency_id = c.currency_id
       LEFT JOIN public.exchange_rate er ON er.currency_code = cur.currency_code
       WHERE c.contract_id = $1`,
      [contract_id]
    );
    if (epiRows.length) {
      const r = epiRows[0];
      resolvedEpiUsd = (Number(r.epi) || 0) * (Number(r.fx) || 1);
    }
  }

  // Check treaty type scope
  if (contract_id) {
    const { rows: typeRows } = await pool.query(
      `SELECT tt.category FROM public.contract c JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id WHERE c.contract_id = $1`,
      [contract_id]
    );
    if (typeRows.length) {
      const isNP = String(typeRows[0].category || '').toUpperCase().includes('NON');
      if (isNP && m.treaty_type_scope === 'PROP_ONLY') {
        reasons.push('Your mandate covers proportional treaties only. This is a non-proportional treaty.');
      }
      if (!isNP && m.treaty_type_scope === 'NP_ONLY') {
        reasons.push('Your mandate covers non-proportional treaties only. This is a proportional treaty.');
      }
    }
  }

  // Check authority limit
  if (resolvedEpiUsd && m.effective_limit_usd !== null) {
    if (resolvedEpiUsd > Number(m.effective_limit_usd)) {
      reasons.push(
        `Treaty EPI (USD ${(resolvedEpiUsd / 1e6).toFixed(1)}M) exceeds your authority limit (USD ${(Number(m.effective_limit_usd) / 1e6).toFixed(1)}M). Escalate to ${nextRoleName(m.hierarchy_level)}.`
      );
    }
  }

  // Check COB restrictions
  const cobList = cob_ids ? String(cob_ids).split(',').filter(Boolean) : [];
  if (m.restricted_cob_ids && m.restricted_cob_ids.length && cobList.length) {
    const blocked = cobList.filter(id => m.restricted_cob_ids.includes(id));
    if (blocked.length) {
      reasons.push(`One or more lines of business require Chief Underwriter or Chief Executive sign-off.`);
    }
  }

  // Check COB authority requirements from cob_authority_requirement table
  if (cobList.length) {
    const { rows: cobAuthRows } = await pool.query(
      `SELECT c.class_of_business_id, c.min_hierarchy_level, c.requires_dual_approval, cb.class_of_business AS class_name
       FROM public.cob_authority_requirement c
       JOIN public.class_of_business cb ON cb.class_of_business_id = c.class_of_business_id
       WHERE c.class_of_business_id = ANY($1::uuid[])
         AND c.min_hierarchy_level < $2`,
      [cobList, m.hierarchy_level]
    );
    for (const row of cobAuthRows) {
      reasons.push(
        `Class "${row.class_name}" requires ${nextRoleName(row.min_hierarchy_level - 1)} authority or above.`
      );
    }
  }

  res.json({
    allowed: reasons.length === 0,
    reasons,
    mandate: buildMandateInfo(m),
    resolvedEpiUsd,
    approvalsRequired: m.approvals_required,
  });
}));

function buildMandateInfo(m) {
  return {
    roleName: m.role_name,
    roleCode: m.role_code,
    hierarchyLevel: m.hierarchy_level,
    effectiveLimitUsd: m.effective_limit_usd,
    singleRiskLimitUsd: m.single_risk_limit_usd,
    treatyTypeScope: m.treaty_type_scope,
    approvalsRequired: m.approvals_required,
    mandateActive: m.mandate_active,
  };
}

function nextRoleName(currentLevel) {
  const map = { 5: 'Treaty Manager', 4: 'Treaty Director', 3: 'Chief Underwriter', 2: 'Chief Executive', 1: 'Chief Executive' };
  return map[currentLevel] || 'a higher authority';
}

export default router;