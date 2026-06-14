import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSession, setSession, clearSession,
  getRole, getUserDisplayName, getUserId, getHierarchyLevel,
  getEffectiveLimitUsd, getTreatyTypeScope,
  isCE, isCU, isAtLeast, canAccessApprovals, canOverrideBelow,
  getAuthHeaders, getCsrfToken, ROLE_LABELS, APPROVALS_ROLES,
} from './auth.js';

const SESSION_KEY = 'UNIVERSE3_SESSION_V2';

const fixtureCU = {
  userId: 'u-1',
  displayName: 'Chief Underwriter',
  roleCode: 'CU',
  hierarchyLevel: 2,
  effectiveLimitUsd: null,
  treatyTypeScope: 'BOTH',
  canOverrideBelow: true,
};

const fixtureTUW = {
  ...fixtureCU,
  userId: 'u-2',
  displayName: 'Treaty Underwriter',
  roleCode: 'TUW',
  hierarchyLevel: 5,
  effectiveLimitUsd: 10_000_000,
  canOverrideBelow: false,
};

beforeEach(() => localStorage.clear());

describe('session lifecycle', () => {
  it('returns null when nothing is set', () => {
    expect(getSession()).toBe(null);
  });

  it('round-trips a valid session via setSession/getSession', () => {
    setSession(fixtureCU);
    expect(getSession()).toEqual(fixtureCU);
  });

  it('rejects malformed JSON in storage', () => {
    localStorage.setItem(SESSION_KEY, '{not json');
    expect(getSession()).toBe(null);
  });

  it('rejects sessions missing userId or roleCode', () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: 'u-1' }));
    expect(getSession()).toBe(null);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roleCode: 'CU' }));
    expect(getSession()).toBe(null);
  });

  it('clearSession wipes the v2 key', () => {
    setSession(fixtureCU);
    clearSession();
    expect(getSession()).toBe(null);
  });
});

describe('role helpers', () => {
  it('return safe defaults when not signed in', () => {
    expect(getRole()).toBe('');
    expect(getUserDisplayName()).toBe('User');
    expect(getUserId()).toBe('');
    expect(getHierarchyLevel()).toBe(99);
    expect(getEffectiveLimitUsd()).toBe(null);
    expect(getTreatyTypeScope()).toBe('BOTH');
    expect(isCE()).toBe(false);
    expect(isCU()).toBe(false);
    expect(canAccessApprovals()).toBe(false);
    expect(canOverrideBelow()).toBe(false);
  });

  it('reflect the active session', () => {
    setSession(fixtureCU);
    expect(getRole()).toBe('CU');
    expect(isCU()).toBe(true);
    expect(isCE()).toBe(false);
    expect(getHierarchyLevel()).toBe(2);
    expect(canAccessApprovals()).toBe(true);
    expect(canOverrideBelow()).toBe(true);
  });

  it('isAtLeast checks hierarchy correctly (lower number = higher role)', () => {
    setSession(fixtureCU);  // level 2 → CU
    expect(isAtLeast(1)).toBe(false);  // not CE
    expect(isAtLeast(2)).toBe(true);   // exactly CU
    expect(isAtLeast(5)).toBe(true);   // higher than TUW

    setSession(fixtureTUW); // level 5 → TUW
    expect(isAtLeast(1)).toBe(false);
    expect(isAtLeast(5)).toBe(true);
  });

  it('canAccessApprovals tracks APPROVALS_ROLES', () => {
    expect(APPROVALS_ROLES.has('CU')).toBe(true);
    expect(APPROVALS_ROLES.has('TUW')).toBe(false);

    setSession(fixtureTUW);
    expect(canAccessApprovals()).toBe(false);
  });
});

describe('getAuthHeaders', () => {
  it('falls back to a TUW guest when not signed in', () => {
    const h = getAuthHeaders();
    expect(h['x-user-role']).toBe('TUW');
    expect(h['x-user-name']).toBe('User');
    expect(h['x-user-id']).toBe('');
  });

  it('emits the active session as headers for the API', () => {
    setSession(fixtureCU);
    const h = getAuthHeaders();
    expect(h['x-user-id']).toBe('u-1');
    expect(h['x-user-role']).toBe('CU');
    expect(h['x-user-name']).toBe('Chief Underwriter');
    expect(h['x-user-level']).toBe('2');
  });

  it('NEVER emits an Authorization header — the token lives only in the cookie', () => {
    // Even if a caller smuggles a token into the session, no Authorization
    // header is produced and the token is not persisted.
    setSession({ ...fixtureCU, token: 'leak-me' });
    const h = getAuthHeaders();
    expect(h.Authorization).toBeUndefined();
    expect('Authorization' in h).toBe(false);
  });
});

describe('token is never persisted client-side (XSS-safe)', () => {
  it('setSession strips any token before writing to storage', () => {
    setSession({ ...fixtureCU, token: 'super-secret.sig' });
    // Not readable via the session API…
    expect(getSession().token).toBeUndefined();
    // …and not present in the raw localStorage blob.
    expect(localStorage.getItem(SESSION_KEY)).not.toContain('super-secret.sig');
  });
});

describe('getCsrfToken', () => {
  afterEach(() => {
    document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('returns the readable csrf cookie value', () => {
    document.cookie = 'csrf_token=abc123.def';
    expect(getCsrfToken()).toBe('abc123.def');
  });

  it('returns an empty string when no csrf cookie is set', () => {
    document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    expect(getCsrfToken()).toBe('');
  });
});

describe('ROLE_LABELS', () => {
  it('covers every role in the hierarchy', () => {
    ['CE', 'CU', 'TD', 'TM', 'TUW'].forEach(c => {
      expect(ROLE_LABELS[c]).toBeTypeOf('string');
      expect(ROLE_LABELS[c].length).toBeGreaterThan(0);
    });
  });
});
