// server/src/config/identity.js
// P1-identity Phase 0c — config-driven, PROVIDER-AGNOSTIC IdP abstraction.
//
// This is the skeleton the SSO work (Phase 1) plugs into. It commits to NO
// provider and makes NO network call: it only reads + validates the
// CONFIGURATION any OIDC integration will need, and exposes pure helpers over
// it. Three concerns, all driven by reviewable configuration rather than code:
//
//   • claim→role mapping (D3): map an IdP claim value to an INTERNAL role,
//     always DEFAULTING to the lowest-privilege role — a missing/unknown claim
//     can never provision an elevated account. The map itself is config.
//   • required ACR/AMR (D2): the MFA assurance the app enforces ITSELF rather
//     than trusting the IdP's own policy. Stored as configuration, checked here.
//   • break-glass local admins (D4): the small, audited set of usernames allowed
//     to sign in with a LOCAL password while SSO is the default login path.
//
// TOLERANT while SSO is off (the default): getIdentityConfig() returns safe
// defaults, validateIdentityConfig() reports nothing fatal, and the login gate
// (routes/auth.js) is a pure pass-through until IDENTITY_SSO_ENABLED=true.
//
// Config is read from process.env on every call (not snapshotted) so tests and
// per-request gates always see the live value, mirroring openRegistrationEnabled().

// Internal role vocabulary (mirrors middleware/requestContext.js ROLE_HIERARCHY;
// kept local so this config module has no import cycle with the auth middleware).
const ROLE_LEVEL = { CE: 1, CU: 2, TD: 3, TM: 4, TUW: 5, UW: 5 };
const VALID_ROLE_CODES = new Set(Object.keys(ROLE_LEVEL));
// Lowest-privilege role new SSO users are provisioned into by default (D3).
export const DEFAULT_LOW_PRIV_ROLE = 'TUW';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const toBool = (v) => TRUTHY.has(String(v ?? '').trim().toLowerCase());
const parseList = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// OIDC scopes are space- or comma-separated; `openid` is always required and is
// folded in (deduped) so a misconfigured list can't drop it.
function parseScopes(v) {
  const raw = String(v ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const set = new Set(['openid', ...raw]);
  return [...set];
}

/** Parse IDENTITY_ROLE_MAP (a JSON object of claimValue→roleCode); bad JSON → {}. */
function parseRoleMap(v) {
  if (!v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Read + normalise the identity configuration from the environment.
 * @param {NodeJS.ProcessEnv} [envObj]
 * @returns {{
 *   ssoEnabled: boolean, provider: string|null, issuer: string|null,
 *   clientId: string|null, roleClaim: string, roleMap: Record<string,string>,
 *   defaultRole: string, requiredAcr: string[], requiredAmr: string[],
 *   breakGlassUsers: string[]
 * }}
 */
export function getIdentityConfig(envObj = process.env) {
  const defaultRoleRaw = String(envObj.IDENTITY_DEFAULT_ROLE ?? '').trim().toUpperCase();
  return {
    ssoEnabled: toBool(envObj.IDENTITY_SSO_ENABLED),
    // Provider-agnostic: a label only. No provider is committed or wired here.
    provider: String(envObj.IDENTITY_PROVIDER ?? '').trim() || null,
    issuer: String(envObj.IDENTITY_ISSUER ?? '').trim() || null,
    clientId: String(envObj.IDENTITY_CLIENT_ID ?? '').trim() || null,
    clientSecret: String(envObj.IDENTITY_CLIENT_SECRET ?? '').trim() || null,
    redirectUri: String(envObj.IDENTITY_REDIRECT_URI ?? '').trim() || null,
    postLogoutRedirectUri: String(envObj.IDENTITY_POST_LOGOUT_REDIRECT_URI ?? '').trim() || null,
    // OIDC scopes requested at authorization; openid is always implied.
    scopes: parseScopes(envObj.IDENTITY_SCOPES || 'openid profile email'),
    roleClaim: String(envObj.IDENTITY_ROLE_CLAIM ?? '').trim() || 'groups',
    roleMap: parseRoleMap(envObj.IDENTITY_ROLE_MAP),
    defaultRole: VALID_ROLE_CODES.has(defaultRoleRaw) ? defaultRoleRaw : DEFAULT_LOW_PRIV_ROLE,
    requiredAcr: parseList(envObj.IDENTITY_REQUIRED_ACR),
    requiredAmr: parseList(envObj.IDENTITY_REQUIRED_AMR),
    breakGlassUsers: parseList(envObj.IDENTITY_BREAK_GLASS_USERS).map((s) => s.toLowerCase()),
  };
}

/** Is SSO the configured login path? Default false → everything stays tolerant. */
export function isSsoEnabled(config = getIdentityConfig()) {
  return config.ssoEnabled === true;
}

/**
 * Map IdP claims to an INTERNAL role code (D3). Reads the configured role claim
 * (which may be a single value or an array of groups), maps each value through
 * the configured roleMap, and returns the MOST-privileged mapped role found —
 * or the low-privilege default when nothing matches. A missing/unknown claim can
 * therefore only ever yield the default role; it can never silently elevate.
 */
export function mapClaimsToRole(claims, config = getIdentityConfig()) {
  const def = VALID_ROLE_CODES.has(config.defaultRole) ? config.defaultRole : DEFAULT_LOW_PRIV_ROLE;
  if (!claims || typeof claims !== 'object') return def;
  const raw = claims[config.roleClaim];
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  let best = def;
  let bestLevel = ROLE_LEVEL[def] ?? 5;
  for (const v of values) {
    const mapped = String(config.roleMap[String(v)] ?? '').trim().toUpperCase();
    if (VALID_ROLE_CODES.has(mapped) && ROLE_LEVEL[mapped] < bestLevel) {
      best = mapped;
      bestLevel = ROLE_LEVEL[mapped];
    }
  }
  return best;
}

/**
 * Enforce the required assurance level IN-APP (D2): the token's acr must be one
 * of the configured required values (when any are set), and every configured
 * required amr method must be present. No requirements configured → satisfied
 * (tolerant). Returns { ok, reasons } so the caller can audit the denial reason.
 */
export function acrSatisfied(claims, config = getIdentityConfig()) {
  const reasons = [];
  const acr = claims?.acr;
  const amr = Array.isArray(claims?.amr) ? claims.amr : [];
  if (config.requiredAcr.length && !config.requiredAcr.includes(String(acr))) {
    reasons.push(`acr "${acr ?? '(none)'}" does not satisfy required [${config.requiredAcr.join(', ')}]`);
  }
  for (const need of config.requiredAmr) {
    if (!amr.includes(need)) reasons.push(`amr is missing required method "${need}"`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Is this username one of the configured break-glass local admins (D4)? */
export function isBreakGlassUser(username, config = getIdentityConfig()) {
  if (!username) return false;
  return config.breakGlassUsers.includes(String(username).trim().toLowerCase());
}

/**
 * Validate the identity configuration (pure; testable). Returns { errors,
 * warnings }. `errors` are always returned (e.g. a role-map value that isn't a
 * real role is a config bug regardless of SSO state). SSO-on adds requirements
 * (issuer/clientId) as errors and MFA/break-glass gaps as warnings. Nothing is
 * thrown — bootstrap logs these so a misconfig is visible without taking the
 * API down.
 */
export function validateIdentityConfig(config = getIdentityConfig()) {
  const errors = [];
  const warnings = [];

  for (const [claimVal, role] of Object.entries(config.roleMap)) {
    if (!VALID_ROLE_CODES.has(String(role).trim().toUpperCase())) {
      errors.push(`IDENTITY_ROLE_MAP: "${claimVal}" → "${role}" is not a valid role code.`);
    }
  }
  // Never let the mapping default to an elevated role.
  if ((ROLE_LEVEL[config.defaultRole] ?? 5) < ROLE_LEVEL[DEFAULT_LOW_PRIV_ROLE]) {
    warnings.push(`IDENTITY_DEFAULT_ROLE "${config.defaultRole}" is above the lowest privilege — new SSO users will be over-provisioned by default (D3).`);
  }

  if (!config.ssoEnabled) return { errors, warnings }; // tolerant while off

  if (!config.issuer) errors.push('IDENTITY_ISSUER is required when SSO is enabled.');
  if (!config.clientId) errors.push('IDENTITY_CLIENT_ID is required when SSO is enabled.');
  if (!config.clientSecret) errors.push('IDENTITY_CLIENT_SECRET is required when SSO is enabled (confidential client).');
  if (!config.redirectUri) errors.push('IDENTITY_REDIRECT_URI is required when SSO is enabled.');
  if (!config.requiredAcr.length && !config.requiredAmr.length) {
    warnings.push('SSO enabled but no IDENTITY_REQUIRED_ACR/AMR set — MFA would not be enforced in-app (D2).');
  }
  if (!config.breakGlassUsers.length) {
    warnings.push('SSO enabled but no IDENTITY_BREAK_GLASS_USERS set — there is no local break-glass admin path (D4).');
  }
  return { errors, warnings };
}
