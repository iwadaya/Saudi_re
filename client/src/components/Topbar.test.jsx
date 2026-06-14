// Topbar Settings: the "View treaties" tickbox writes the per-user preference.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Topbar from './Topbar.jsx';
import { setSession, clearSession } from '../utils/auth';
import { getViewAllTreaties } from '../utils/prefs';

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  getViewableUsers: vi.fn().mockResolvedValue([]),
  changePassword: vi.fn().mockResolvedValue({ ok: true }),
} }));
vi.mock('../api', () => ({ api: apiMock }));

afterEach(() => { cleanup(); localStorage.clear(); clearSession(); vi.clearAllMocks(); });
beforeEach(() => { setSession({ userId: 'me', roleCode: 'CU', hierarchyLevel: 2, displayName: 'Me' }); });

describe('Topbar — View treaties preference', () => {
  it('shows a working tickbox in Settings (default off → on, persisted)', () => {
    render(<Topbar title="X" />);
    fireEvent.click(screen.getByRole('button', { name: /SETTINGS/i }));

    expect(screen.getByText('View treaties')).toBeInTheDocument();
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();

    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(getViewAllTreaties('me')).toBe(true);
  });
});

describe('Topbar — change password', () => {
  const openForm = () => {
    render(<Topbar title="X" />);
    fireEvent.click(screen.getByRole('button', { name: /SETTINGS/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Change password$/i }));
  };
  const fill = (cur, next, conf) => {
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: cur } });
    fireEvent.change(screen.getByLabelText('New password (min 8)'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: conf } });
  };

  it('keeps Submit disabled until the input mirrors the server rules (>=8, match, differs)', () => {
    openForm();
    const submit = screen.getByRole('button', { name: /Update password/i });
    expect(submit).toBeDisabled();

    fill('oldpass1', 'short7', 'short7');               // < 8
    expect(submit).toBeDisabled();
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument();

    fill('oldpass1', 'brandnew2', 'different2');         // mismatch
    expect(submit).toBeDisabled();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();

    fill('oldpass1', 'oldpass1', 'oldpass1');            // same as current
    expect(submit).toBeDisabled();
    expect(screen.getByText('New password must differ')).toBeInTheDocument();

    fill('oldpass1', 'brandnew2', 'brandnew2');          // valid
    expect(submit).toBeEnabled();
  });

  it('submits the change, confirms, and collapses the form', async () => {
    apiMock.changePassword.mockResolvedValueOnce({ ok: true });
    openForm();
    fill('oldpass1', 'brandnew2', 'brandnew2');
    fireEvent.click(screen.getByRole('button', { name: /Update password/i }));

    await waitFor(() => expect(apiMock.changePassword).toHaveBeenCalledWith({
      currentPassword: 'oldpass1', newPassword: 'brandnew2', confirmPassword: 'brandnew2',
    }));
    expect(await screen.findByText(/Password updated/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).toBeNull(); // collapsed
  });

  it('surfaces the server message inline on a wrong current password and stays open', async () => {
    apiMock.changePassword.mockRejectedValueOnce(
      Object.assign(new Error('http 401'), { status: 401, body: { error: 'Current password is incorrect.' } }),
    );
    openForm();
    fill('WRONG', 'brandnew2', 'brandnew2');
    fireEvent.click(screen.getByRole('button', { name: /Update password/i }));

    expect(await screen.findByText('Current password is incorrect.')).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument(); // still open to retry
  });

  it('hides the Password section when logged out', () => {
    clearSession();
    render(<Topbar title="X" />);
    fireEvent.click(screen.getByRole('button', { name: /SETTINGS/i }));
    expect(screen.queryByRole('button', { name: /^Change password$/i })).toBeNull();
  });
});
