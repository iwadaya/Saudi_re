import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { getViewAllTreaties, setViewAllTreaties, useViewAllTreaties } from './prefs';
import { setSession, clearSession } from './auth';

afterEach(() => { localStorage.clear(); clearSession(); });

describe('viewAllTreaties preference', () => {
  it('defaults false and round-trips per user', () => {
    expect(getViewAllTreaties('u1')).toBe(false);
    setViewAllTreaties('u1', true);
    expect(getViewAllTreaties('u1')).toBe(true);
    expect(getViewAllTreaties('u2')).toBe(false); // per-user key
  });

  it('useViewAllTreaties reads the session user and its setter persists + updates', () => {
    setSession({ userId: 'u1', roleCode: 'CU', hierarchyLevel: 2, displayName: 'X' });
    const { result } = renderHook(() => useViewAllTreaties());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(getViewAllTreaties('u1')).toBe(true);
  });

  it('re-renders consumers when another caller flips the pref (prefs-changed event)', () => {
    setSession({ userId: 'u1', roleCode: 'CU', hierarchyLevel: 2, displayName: 'X' });
    const { result } = renderHook(() => useViewAllTreaties());
    act(() => setViewAllTreaties('u1', true));
    expect(result.current[0]).toBe(true);
  });
});
