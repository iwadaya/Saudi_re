const SESSION_KEY = 'UNIVERSE3_SESSION_V2';
const TEST_NAME_KEY = 'UNIVERSE_TEST_NAME';

// UUID of the seeded TUW demo user — all test sessions share this so FK
// constraints (created_by_user_id, assigned_to_user_id) are satisfied.
export const TEST_USER_UUID = '00000000-0000-0000-0000-000000000002';

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
  safeStorage(s => s.setItem(SESSION_KEY, JSON.stringify(sessionData)));
}

export function clearSession() {
  safeStorage(s => s.removeItem(SESSION_KEY));
  safeStorage(s => s.removeItem('UNIVERSE_APP_SESSION_V1'));
  safeStorage(s => s.removeItem(TEST_NAME_KEY));
}

// ── Test-mode helpers ────────────────────────────────────────────────────────

export function getTestName() {
  return safeStorage(s => s.getItem(TEST_NAME_KEY)) || '';
}

export function setTestName(name) {
  safeStorage(s => s.setItem(TEST_NAME_KEY, name));
}

export function isTestSession() {
  return getSession()?.isTestUser === true;
}

/**
 * Creates and stores a test session for a named tester.
 * Reuses the seeded TUW UUID so no DB migration is needed.
 */
export function createTestSession(displayName) {
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
/** The signed bearer token issued by /auth/login (persisted in the session). */
export function getAuthToken() { return getSession()?.token || ''; }
export function getHierarchyLevel() { return getSession()?.hierarchyLevel ?? 99; }
export function getEffectiveLimitUsd() { return getSession()?.effectiveLimitUsd ?? null; }
export function getTreatyTypeScope() { return getSession()?.treatyTypeScope || 'BOTH'; }

export function isCE() { return getSession()?.roleCode === 'CE'; }
export function isCU() { return getSession()?.roleCode === 'CU'; }
export function isAtLeast(level) { return getHierarchyLevel() <= level; }
export function canAccessApprovals() { return APPROVALS_ROLES.has(getSession()?.roleCode); }
export function canOverrideBelow() { return getSession()?.canOverrideBelow === true; }

/** @returns {Record<string, string>} auth headers for every API request.
 *  Authorization (Bearer <token>) is the real identity the server trusts; the
 *  x-user-* headers are kept for logging and the dev/test ALLOW_DEMO_AUTH path. */
export function getAuthHeaders() {
  const s = getSession();
  if (!s) return { 'x-user-role': 'TUW', 'x-user-name': 'User', 'x-user-id': '' };

  // Test sessions: send the tester's real name so server logs are meaningful.
  // Regular sessions: send the role title to keep audit logs persona-free.
  const userName = s.isTestUser
    ? (getTestName() || s.displayName || 'Tester')
    : (ROLE_LABELS[s.roleCode] || s.displayName || 'User');

  const headers = {
    'x-user-id':    s.userId,
    'x-user-role':  s.roleCode,
    'x-user-name':  userName,
    'x-user-level': String(s.hierarchyLevel || 99),
  };
  if (s.token) headers.Authorization = `Bearer ${s.token}`;
  return headers;
}

// Backward-compat alias used by WizardLayout's logout button.
export function clearRole() { clearSession(); }
