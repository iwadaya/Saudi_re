const SESSION_KEY = 'UNIVERSE3_SESSION_V2';

export const ROLE_CODES = { CE:'CE', CU:'CU', TD:'TD', TM:'TM', TUW:'TUW' };
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
}

export function getRole() { return getSession()?.roleCode || ''; }
/**
 * Display name used throughout the UI (topbar, approval trail,
 * `_actor` on every workflow action). Deliberately derived from
 * roleCode, NOT from the stored `displayName` — demo seeds have
 * populated session.displayName with placeholder names in the past
 * ("Ahmed Al Rashidi" etc.). We show the role title instead so the
 * UI never leaks dummy personas.
 */
export function getUserDisplayName() {
  const s = getSession();
  if (!s) return 'User';
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

export function getAuthHeaders() {
  const s = getSession();
  if (!s) return { 'x-user-role': 'TUW', 'x-user-name': 'User', 'x-user-id': '' };
  return {
    'x-user-id':    s.userId,
    'x-user-role':  s.roleCode,
    // Always send the role title, not any stored personal name — keeps
    // server audit logs free of dummy personas too.
    'x-user-name':  ROLE_LABELS[s.roleCode] || s.displayName || 'User',
    'x-user-level': String(s.hierarchyLevel || 99),
  };
}

// Backward compat aliases
export function setRole() {}
export function clearRole() { clearSession(); }
