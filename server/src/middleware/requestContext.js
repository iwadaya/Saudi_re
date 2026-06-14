// server/src/middleware/requestContext.js
// Authentication: identity comes from a VERIFIED bearer token; role + level are
// re-read from the DB (v_user_mandate) on every request, so a stale token can
// never carry elevated rights after a demotion. x-user-* headers are NOT trusted
// for authorization in production — only as a dev/test convenience gated behind
// ALLOW_DEMO_AUTH, and otherwise for logging.
import { pool } from '../db/pool.js';
import { verifyAuthToken } from '../lib/authToken.js';
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

/** Pull the bearer token from the Authorization header or an httpOnly cookie. */
function extractToken(req) {
  const h = req.header && (req.header('authorization') || req.header('Authorization'));
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const cookie = req.headers && req.headers.cookie;
  if (cookie) {
    const m = /(?:^|;\s*)auth_token=([^;]+)/.exec(cookie);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  }
  return null;
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
    const token = extractToken(req);
    if (token) {
      const payload = verifyAuthToken(token);
      if (payload && payload.sub) {
        const user = await loadUserFromDb(payload.sub);
        if (user) { req.user = user; return next(); }
      }
      // invalid/expired token or unknown user → fall through to demo/anon
    }
    req.user = process.env.ALLOW_DEMO_AUTH === 'true' ? demoUserFromHeaders(req) : null;
    return next();
  } catch (e) {
    logger.warn('authenticate failed', { error: e.message });
    req.user = null;
    return next();
  }
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
