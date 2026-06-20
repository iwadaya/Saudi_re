// SsoCallback hydrates the session from the httpOnly cookie via /auth/me after
// the server's SSO redirect, then routes the user on (or back to /login on fail).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import SsoCallback from './SsoCallback.jsx';
import { getSession } from '../../utils/auth';

const { apiMock, navigateMock } = vi.hoisted(() => ({
  apiMock: { getMe: vi.fn() },
  navigateMock: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { localStorage.clear(); });

describe('SsoCallback', () => {
  it('hydrates the session from /auth/me and routes a normal user to /select', async () => {
    apiMock.getMe.mockResolvedValue({ session: { userId: 'u1', roleCode: 'TUW', displayName: 'Ada' } });
    render(<SsoCallback />);
    expect(screen.getByText(/completing sign-in/i)).toBeInTheDocument();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/select', { replace: true }));
    expect(getSession()?.userId).toBe('u1');
  });

  it('routes an approver to /approvals', async () => {
    apiMock.getMe.mockResolvedValue({ session: { userId: 'u2', roleCode: 'CU', displayName: 'Chief' } });
    render(<SsoCallback />);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/approvals', { replace: true }));
  });

  it('bounces back to /login on a failed /auth/me', async () => {
    apiMock.getMe.mockRejectedValue(new Error('401'));
    render(<SsoCallback />);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login?sso_error=failed', { replace: true }));
    expect(getSession()).toBeNull();
  });

  it('bounces back to /login when /auth/me returns no session', async () => {
    apiMock.getMe.mockResolvedValue({ session: null });
    render(<SsoCallback />);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/login?sso_error=failed', { replace: true }));
  });
});
