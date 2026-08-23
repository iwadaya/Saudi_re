const SESSION_KEY = 'UNIVERSE3_SESSION_V2';
const TEST_NAME_KEY = 'UNIVERSE_TEST_NAME';

// UUID of the seeded TUW demo user — all test sessions share this so FK
// constraints (created_by_user_id, assigned_to_user_id) are satisfied.
const TEST_USER_UUID = '00000000-0000-0000-0000-000000000002';

export const ROLE_LABELS = {
  CE:'Chief Executive', CU:'Chief Underwriter',
  TD:'Treaty Director', TM:'Treaty Manager', TUW:'Treaty Underwriter',
};
export const APPROVALS_ROLES = new Set(['CE', 'CU', 'TD', 'TM']);

function safeStorage(action) {
  try { return action(window.localStorage); } catch { return null; }
}

export function getSession() {
  const raw = safeStorage(s => s.getItem(SESSION_KEY));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.userId || !parsed?.roleCode) return null;
    return parsed;
  } catch { return null; }
}

export function setSession(sessionData) {
  // The auth token lives ONLY in the server's httpOnly cookie. Strip it before
  // persisting so it can never land in localStorage (XSS-readable) — even if a
  // caller accidentally passes one through.
  const safe = { ...(sessionData || {}) };
  delete safe.token;
  safeStorage(s => s.setItem(SESSION_KEY, JSON.stringify(safe)));
}

/** Read the double-submit CSRF token the server set as a readable cookie.
 *  Echoed back in the X-CSRF-Token header on mutating requests (see api.ts).
 *  Returns '' when absent (e.g. logged out). The auth token itself is httpOnly
 *  and intentionally NOT readable here. */
export function getCsrfToken() {
  try {
    const m = /(?:^|;\s*)csrf_token=([^;]+)/.exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  } catch { return ''; }
}

export function clearSession() {
  safeStorage(s => s.removeItem(SESSION_KEY));
  safeStorage(s => s.removeItem('UNIVERSE_APP_SESSION_V1'));
  safeStorage(s => s.removeItem(TEST_NAME_KEY));
}

// ── Test-mode helpers ────────────────────────────────────────────────────────

// Test-access helpers are a DEV-only convenience and are compiled out of
// production builds (import.meta.env.DEV is statically false in prod, so the
// bodies dead-code-eliminate to a no-op).
function getTestName() {
  if (!import.meta.env.DEV) return '';
  return safeStorage(s => s.getItem(TEST_NAME_KEY)) || '';
}

function setTestName(name) {
  if (!import.meta.env.DEV) return;
  safeStorage(s => s.setItem(TEST_NAME_KEY, name));
}

/**
 * Creates and stores a test session for a named tester.
 * Reuses the seeded TUW UUID so no DB migration is needed.
 */
export function createTestSession(displayName) {
  if (!import.meta.env.DEV) return; // no test sessions in production builds
  const name = displayName.trim();
  setTestName(name);
  setSession({
    userId: TEST_USER_UUID,
    roleCode: 'TUW',
    displayName: name,
    hierarchyLevel: 2,
    effectiveLimitUsd: 10000000,
    treatyTypeScope: 'BOTH',
    canOverrideBelow: false,
    isTestUser: true,
  });
}

// ── Standard session helpers ─────────────────────────────────────────────────

export function getRole() { return getSession()?.roleCode || ''; }

/**
 * Returns the display name to show in the UI.
 * Test sessions: show the tester's real name.
 * Regular sessions: show the role title (keeps demo free of placeholder names).
 */
export function getUserDisplayName() {
  const s = getSession();
  if (!s) return 'User';
  if (s.isTestUser) return getTestName() || s.displayName || 'Tester';
  return ROLE_LABELS[s.roleCode] || s.displayName || 'User';
}

export function getUserId() { return getSession()?.userId || ''; }
export function getHierarchyLevel() { return getSession()?.hierarchyLevel ?? 99; }
export function getEffectiveLimitUsd() { return getSession()?.effectiveLimitUsd ?? null; }
export function getTreatyTypeScope() { return getSession()?.treatyTypeScope || 'BOTH'; }

export function isCE() { return getSession()?.roleCode === 'CE'; }
export function isCU() { return getSession()?.roleCode === 'CU'; }
export function isAtLeast(level) { return getHierarchyLevel() <= level; }
export function canAccessApprovals() { return APPROVALS_ROLES.has(getSession()?.roleCode); }
export function canOverrideBelow() { return getSession()?.canOverrideBelow === true; }

// (Sign-out now flows through utils/logout.performLogout, which also clears the
//  server's httpOnly auth + CSRF cookies — see WizardLayout / Topbar / Approvals.)

/** @returns {Record<string, string>} non-auth headers for every API request.
 *  The real identity rides in the httpOnly auth cookie — never an Authorization
 *  header sourced from JS-readable storage. The x-user-* headers carry NO
 *  authority in production (the server ignores them unless ALLOW_DEMO_AUTH is on
 *  for dev/test); they are kept for audit logging and that dev/test path. */
export function getAuthHeaders() {
  const s = getSession();
  if (!s) return { 'x-user-role': 'TUW', 'x-user-name': 'User', 'x-user-id': '' };

  // Test sessions: send the tester's real name so server logs are meaningful.
  // Regular sessions: send the role title to keep audit logs persona-free.
  const userName = s.isTestUser
    ? (getTestName() || s.displayName || 'Tester')
    : (ROLE_LABELS[s.roleCode] || s.displayName || 'User');

  return {
    'x-user-id':    s.userId,
    'x-user-role':  s.roleCode,
    'x-user-name':  userName,
    'x-user-level': String(s.hierarchyLevel || 99),
  };
}
