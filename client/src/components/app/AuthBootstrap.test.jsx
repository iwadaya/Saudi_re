// Boot-time session verification (AuthBootstrap). Uses the real session store +
// password gate; mocks only api.getMe. A sentinel child stands in for AppShell so
// "did a protected screen render?" is a single assertion.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AuthBootstrap from './AuthBootstrap.jsx';
import { getSession, setSession, clearSession } from '../../utils/auth';
import { isPasswordChangeRequired, clearPasswordChange } from '../../utils/passwordGate';

const { apiMock } = vi.hoisted(() => ({ apiMock: { getMe: vi.fn() } }));
vi.mock('../../api', () => ({ api: apiMock }));

const CHILD = 'PROTECTED-APP';
const Child = () => <div>{CHILD}</div>;
const httpErr = (status) => Object.assign(new Error(`http ${status}`), { status });
const validSession = { userId: 'u1', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'Me', token: 'tok-123' };

afterEach(() => { cleanup(); clearSession(); clearPasswordChange(); vi.clearAllMocks(); });

describe('AuthBootstrap — verify-on-boot', () => {
  it('with NO session, renders straight through without calling /auth/me', () => {
    render(<AuthBootstrap><Child /></AuthBootstrap>);
    expect(screen.getByText(CHILD)).toBeInTheDocument();
    expect(apiMock.getMe).not.toHaveBeenCalled();
  });

  it('with a VALID token, shows the splash first (no protected flash) then renders, refreshing the session', async () => {
    setSession(validSession);
    apiMock.getMe.mockResolvedValueOnce({ session: { userId: 'u1', roleCode: 'CU', hierarchyLevel: 2, displayName: 'Chief', effectiveLimitUsd: 5 } });
    render(<AuthBootstrap><Child /></AuthBootstrap>);

    expect(screen.queryByText(CHILD)).toBeNull(); // in-flight: no protected screen yet
    expect(await screen.findByText(CHILD)).toBeInTheDocument();
    const s = getSession();
    expect(s.roleCode).toBe('CU');           // refreshed from server truth
    expect(s.hierarchyLevel).toBe(2);
    expect(s.token).toBe('tok-123');         // token preserved (not echoed by /auth/me)
  });

  it('with an EXPIRED/INVALID token (401), clears the session and renders logged-out — no protected flash', async () => {
    setSession(validSession);
    apiMock.getMe.mockRejectedValueOnce(httpErr(401));
    render(<AuthBootstrap><Child /></AuthBootstrap>);

    expect(screen.queryByText(CHILD)).toBeNull();
    expect(await screen.findByText(CHILD)).toBeInTheDocument();
    expect(getSession()).toBeNull(); // cleared → AuthGuard will route to /login
  });

  it('with mustChangePassword, flips the forced-change gate (modal, not /select)', async () => {
    setSession(validSession);
    apiMock.getMe.mockResolvedValueOnce({ session: { userId: 'u1', roleCode: 'TUW', mustChangePassword: true } });
    render(<AuthBootstrap><Child /></AuthBootstrap>);

    await screen.findByText(CHILD);
    expect(isPasswordChangeRequired()).toBe(true);
    expect(getSession().mustChangePassword).toBe(true);
  });

  it('on a transient network error, does NOT log out — shows retry, keeps the session, and recovers on retry', async () => {
    setSession(validSession);
    apiMock.getMe
      .mockRejectedValueOnce(httpErr(0)) // network / timeout
      .mockResolvedValueOnce({ session: { userId: 'u1', roleCode: 'TUW' } });
    render(<AuthBootstrap><Child /></AuthBootstrap>);

    expect(await screen.findByRole('button', { name: /Retry/i })).toBeInTheDocument();
    expect(screen.queryByText(CHILD)).toBeNull();
    expect(getSession()).not.toBeNull(); // still signed in

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText(CHILD)).toBeInTheDocument();
  });

  it('a 5xx on /auth/me also keeps the session (offline, not logged out)', async () => {
    setSession(validSession);
    apiMock.getMe.mockRejectedValueOnce(httpErr(503));
    render(<AuthBootstrap><Child /></AuthBootstrap>);

    expect(await screen.findByRole('button', { name: /Retry/i })).toBeInTheDocument();
    expect(getSession()).not.toBeNull();
  });
});
