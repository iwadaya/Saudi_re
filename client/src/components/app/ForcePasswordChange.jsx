// Mandatory first-login "Set your password" modal. Shown by AppShell whenever the
// forced-change gate is active (seeded user with must_change_password, or any API
// 423 PWD_CHANGE_REQUIRED). Non-dismissable: no backdrop close, no Escape, no
// Cancel — the only way out is a successful change. Reuses ChangePasswordForm; the
// "current password" is the temporary one the user was given.
import { useNavigate } from 'react-router-dom';
import { getSession, setSession } from '../../utils/auth';
import { clearPasswordChange } from '../../utils/passwordGate';
import ChangePasswordForm from '../ChangePasswordForm';

export default function ForcePasswordChange() {
  const navigate = useNavigate();

  const onSuccess = () => {
    // Clear the flag on the persisted session and lift the gate, then proceed.
    const session = getSession();
    if (session) setSession({ ...session, mustChangePassword: false });
    clearPasswordChange();
    navigate('/', { replace: true });
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="force-pw-title"
      style={{ position: 'fixed', inset: 0, zIndex: 200000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(2,6,23,0.86)', backdropFilter: 'blur(2px)' }}>
      <div style={{ width: 'min(420px, 100%)', background: 'var(--panel-bg-strong)', border: '1px solid var(--hairline-strong)', borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,0.35)', padding: 22 }}>
        <div id="force-pw-title" style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>Set your password</div>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(var(--text-rgb),0.80)', margin: '0 0 16px' }}>
          You&apos;re signed in with a temporary password and must set your own before
          you can use the app. Enter the temporary password as your current password,
          then choose a new one (at least 8 characters).
        </p>
        <ChangePasswordForm onSuccess={onSuccess} submitLabel="Set password" />
      </div>
    </div>
  );
}
