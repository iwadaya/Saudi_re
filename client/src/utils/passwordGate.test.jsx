// Forced-password-change gate store + hook.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

let sessionValue = null;
vi.mock('./auth', () => ({ getSession: () => sessionValue }));

import {
  requirePasswordChange, clearPasswordChange, isPasswordChangeRequired, usePasswordChangeRequired,
} from './passwordGate';

function Probe() {
  const req = usePasswordChangeRequired();
  return <div>{req ? 'REQUIRED' : 'free'}</div>;
}

afterEach(() => { cleanup(); clearPasswordChange(); sessionValue = null; });

describe('passwordGate', () => {
  it('the store flag drives isPasswordChangeRequired', () => {
    expect(isPasswordChangeRequired()).toBe(false);
    requirePasswordChange();
    expect(isPasswordChangeRequired()).toBe(true);
    clearPasswordChange();
    expect(isPasswordChangeRequired()).toBe(false);
  });

  it('the session flag drives isPasswordChangeRequired (covers app load)', () => {
    sessionValue = { userId: 'u', roleCode: 'UW', mustChangePassword: true };
    expect(isPasswordChangeRequired()).toBe(true);
  });

  it('the hook re-renders on require()/clear()', () => {
    render(<Probe />);
    expect(screen.getByText('free')).toBeInTheDocument();
    act(() => requirePasswordChange());
    expect(screen.getByText('REQUIRED')).toBeInTheDocument();
    act(() => clearPasswordChange());
    expect(screen.getByText('free')).toBeInTheDocument();
  });
});
