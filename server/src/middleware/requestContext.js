// server/src/middleware/requestContext.js
// Authentication: identity comes from a VERIFIED token carried in an httpOnly
// `auth_token` cookie; role + level are re-read from the DB (v_user_mandate) on
// every request, so a stale token can never carry elevated rights after a
// demotion. The `Authorization: Bearer` header is honoured ONLY under
// ALLOW_DEMO_AUTH (dev/test), never in production. x-user-* headers are NOT
// trusted for authorization — only the demo-header fallback (ALLOW_DEMO_AUTH)
// and otherwise logging. csrfProtection adds a double-submit guard for cookie-
// authenticated mutations.
import { pool } from '../db/pool.js';
import { verifyAuthToken } from '../lib/authToken.js';
import { verifyCsrfToken } from '../lib/csrf.js';
import { readCookie, AUTH_COOKIE, CSRF_COOKIE, CSRF_HEADER } from '../lib/authCookies.js';
import { logger } from '../lib/logger.js';

const ROLE_HIERARCHY = {
  CE: 1, CU: 2, TD: 3, TM: 4, TUW: 5, UW: 5, // UW = legacy alias for TUW
};
const ROLE_LABELS = {
  CE: 'Chief Executive', CU: 'Chief Underwriter',
  TD: 'Treaty Director', TM: 'Treaty Manager', TUW: 'Treaty Underwriter', UW: 'Treaty Underwriter',
};
const VALID_ROLES = new Set(Object.keys(ROLE_HIERARCHY));

function normalizeRole(rawRole) {
  const r = String(rawRole || '').trim().toUpperCase();
  return ROLE_HIERARCHY[r] ? r : 'TUW';
}

/**
 * Pull the auth token and record HOW it arrived. The httpOnly cookie is the
 * primary, CSRF-protected credential. The `Authorization: Bearer` header is
 * honoured ONLY as a dev/test convenience (ALLOW_DEMO_AUTH) and NEVER in
 * production — a browser cannot read the httpOnly cookie to forge that header,
 * so leaving it on in prod would reopen the very surface the cookie closes.
 * @returns {{ token: string|null, via: 'cookie'|'bearer'|null }}
 */
function extractToken(req) {
  const cookieToken = readCookie(req, AUTH_COOKIE);
  if (cookieToken) return { token: cookieToken, via: 'cookie' };
  if (process.env.ALLOW_DEMO_AUTH === 'true') {
    const h = req.header && (req.header('authorization') || req.header('Authorization'));
    if (h && /^Bearer\s+/i.test(h)) return { token: h.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  }
  return { token: null, via: null };
}

/** Load the user FRESH from the DB — the source of truth for role/level. */
async function loadUserFromDb(sub) {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, display_name, role_code, hierarchy_level, can_override_below,
              effective_limit_usd, restricted_cob_ids, treaty_type_scope, must_change_password
       FROM public.v_user_mandate WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [sub],
    );
    const u = rows[0];
    if (!u) return null;
    const hierarchyLevel = u.hierarchy_level ?? 5;
    return {
      userId: u.user_id,
      role: u.role_code,
      roleCode: u.role_code,
      displayName: u.display_name,
      hierarchyLevel,
      canApprove: hierarchyLevel <= 4,
      isSupervisor: hierarchyLevel <= 2,
      effectiveLimit: u.effective_limit_usd ?? null,
      excludedCobIds: Array.isArray(u.restricted_cob_ids) ? u.restricted_cob_ids : [],
      treatyTypeScope: u.treaty_type_scope || 'BOTH',
      mustChangePassword: u.must_change_password === true,
      source: 'token',
    };
  } catch (e) {
    logger.warn('loadUserFromDb failed', { error: e.message });
    return null;
  }
}

/** Dev/test only: trust x-user-* headers, but only when a VALID role is given. */
function demoUserFromHeaders(req) {
  const raw = req.header ? req.header('x-user-role') : req.headers?.['x-user-role'];
  const role = String(raw || '').trim().toUpperCase();
  if (!VALID_ROLES.has(role)) return null; // no valid role header → anonymous
  const roleCode = normalizeRole(role);
  const levelHeader = req.header ? req.header('x-user-level') : req.headers?.['x-user-level'];
  const hierarchyLevel = levelHeader ? Number(levelHeader) : (ROLE_HIERARCHY[roleCode] || 5);
  return {
    userId: (req.header ? req.header('x-user-id') : req.headers?.['x-user-id']) || null,
    role: roleCode,
    roleCode,
    displayName: (req.header ? req.header('x-user-name') : req.headers?.['x-user-name']) || ROLE_LABELS[roleCode] || 'User',
    hierarchyLevel,
    canApprove: hierarchyLevel <= 4,
    isSupervisor: hierarchyLevel <= 2,
    effectiveLimit: null,
    excludedCobIds: [],
    treatyTypeScope: 'BOTH',
    source: 'demo-header',
  };
}

/**
 * Resolve req.user from the verified token (DB-backed), else the demo-header
 * fallback (only when ALLOW_DEMO_AUTH=true), else anonymous (null).
 */
export async function authenticate(req, _res, next) {
  try {
    const { token, via } = extractToken(req);
    if (token) {
      const payload = verifyAuthToken(token);
      if (payload && payload.sub) {
        const user = await loadUserFromDb(payload.sub);
        if (user) { req.user = user; req.authVia = via; return next(); }
      }
      // invalid/expired token or unknown user → fall through to demo/anon
    }
    const demo = process.env.ALLOW_DEMO_AUTH === 'true' ? demoUserFromHeaders(req) : null;
    req.user = demo;
    req.authVia = demo ? 'demo-header' : null;
    return next();
  } catch (e) {
    logger.warn('authenticate failed', { error: e.message });
    req.user = null;
    req.authVia = null;
    return next();
  }
}

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Bootstrap endpoints that legitimately carry no CSRF token: login is reached
// before any session/cookie exists, and logout's only effect is to drop the
// session (so it must succeed even if the csrf cookie is gone). Paths are
// relative to the /api mount, matching req.path under app.use('/api', …).
const CSRF_EXEMPT = new Set(['/auth/login', '/auth/logout']);

/**
 * CSRF double-submit guard. Enforced ONLY for cookie-authenticated, state-
 * changing requests: cookies are ambient credentials a cross-site page can ride,
 * whereas Bearer/demo-header auth carries an explicit credential an attacker
 * cannot read or forge — so those need no CSRF token (and the dev/test header
 * path keeps working). A request passes when the X-CSRF-Token header equals the
 * csrf cookie AND that value carries a valid server signature.
 */
export function csrfProtection(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (CSRF_SAFE_METHODS.has(method)) return next();
  if (req.authVia !== 'cookie') return next();
  if (CSRF_EXEMPT.has(req.path)) return next();

  const headerToken = req.header ? req.header(CSRF_HEADER) : req.headers?.[CSRF_HEADER];
  const cookieToken = readCookie(req, CSRF_COOKIE);
  if (headerToken && cookieToken && headerToken === cookieToken && verifyCsrfToken(headerToken)) {
    return next();
  }
  return res.status(403).json({ error: 'Invalid or missing CSRF token.', code: 'CSRF_FAILED' });
}

/** Block requests without a resolved identity. */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({
    error: 'Authentication required.',
    code: 'UNAUTHORIZED',
    requestId: res.locals?.requestId || req.id || null,
  });
}

/**
 * Authorize by role code, e.g. requireRole('CE','CU'). Reads the VERIFIED
 * req.user (set by authenticate) — never a client header. 401 if anonymous,
 * 403 if the role isn't allowed.
 */
export function requireRole(...codes) {
  const allowed = new Set(codes.map((c) => String(c).toUpperCase()));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
    if (allowed.has(String(req.user.roleCode || '').toUpperCase())) return next();
    return res.status(403).json({ error: `Requires role: ${codes.join(', ')}.`, code: 'FORBIDDEN' });
  };
}

/**
 * Authorize by minimum hierarchy level (lower number = higher authority), e.g.
 * requireMinLevel(2) = Chief Underwriter or above. Reads the VERIFIED req.user.
 */
export function requireMinLevel(n) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
    if (Number(req.user.hierarchyLevel) <= n) return next();
    return res.status(403).json({ error: 'You do not have sufficient authority for this action.', code: 'FORBIDDEN' });
  };
}

// Back-compat alias (older imports referenced attachRequestContext).
export const attachRequestContext = authenticate;
