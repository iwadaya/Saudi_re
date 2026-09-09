// Mandatory first-login "Set your password" modal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ForcePasswordChange from './ForcePasswordChange.jsx';
import { setSession, clearSession, getSession } from '../../utils/auth';
import { requirePasswordChange, clearPasswordChange, isPasswordChangeRequired } from '../../utils/passwordGate';

const { apiMock } = vi.hoisted(() => ({ apiMock: { changePassword: vi.fn().mockResolvedValue({ ok: true }) } }));
vi.mock('../../api', () => ({ api: apiMock }));

afterEach(() => { cleanup(); clearSession(); clearPasswordChange(); vi.clearAllMocks(); });
beforeEach(() => {
  setSession({ userId: 'underwriter2', roleCode: 'UW', hierarchyLevel: 4, displayName: 'Underwriter 2', mustChangePassword: true, token: 't' });
  requirePasswordChange();
});

describe('ForcePasswordChange (mandatory modal)', () => {
  it('is non-dismissable: shows the set-password form with no Cancel', () => {
    render(<ForcePasswordChange />);
    expect(screen.getByText('Set your password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set password/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel/i })).toBeNull();
  });

  it('on success: changes the password, clears the must-change flag, and lifts the gate', async () => {
    render(<ForcePasswordChange />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Universe#1234' } });
    fireEvent.change(screen.getByLabelText('New password (min 8)'), { target: { value: 'Newpass123' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Newpass123' } });
    fireEvent.click(screen.getByRole('button', { name: /Set password/i }));

    await waitFor(() => expect(apiMock.changePassword).toHaveBeenCalledWith({
      currentPassword: 'Universe#1234', newPassword: 'Newpass123', confirmPassword: 'Newpass123',
    }));
    await waitFor(() => expect(getSession()?.mustChangePassword).toBe(false));
    expect(isPasswordChangeRequired()).toBe(false);
  });

  it('will not let the temp password be reused as the new password (Submit disabled)', () => {
    render(<ForcePasswordChange />);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Universe#1234' } });
    fireEvent.change(screen.getByLabelText('New password (min 8)'), { target: { value: 'Universe#1234' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Universe#1234' } });
    expect(screen.getByRole('button', { name: /Set password/i })).toBeDisabled();
    expect(apiMock.changePassword).not.toHaveBeenCalled();
  });
});
