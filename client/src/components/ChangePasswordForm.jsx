// Shared inline "change your password" form — used by the Topbar Settings panel
// and the mandatory first-login modal (ForcePasswordChange). Renders the three
// fields + show/hide + validation + submit; the CONTAINER and the success action
// are the caller's. Client validation mirrors the server (>=8, confirm match,
// differs from current); the server stays authoritative — it also rejects reuse
// of the seeded temporary password, so no such literal is baked into the client.
import { useState } from 'react';
import { api } from '../api';
import { parseErrorBody } from '../utils/errorBody';

export default function ChangePasswordForm({ onSuccess, onCancel, submitLabel = 'Update password' }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [conf, setConf] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const valid = cur.length > 0 && next.length >= 8 && next === conf && next !== cur;
  const hint = (() => {
    if (next.length > 0 && next.length < 8) return 'New password must be at least 8 characters.';
    if (conf.length > 0 && next !== conf) return 'Passwords do not match';
    if (next.length >= 8 && next === cur) return 'New password must differ';
    return '';
  })();

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      await api.changePassword({ currentPassword: cur, newPassword: next, confirmPassword: conf });
      onSuccess?.();
    } catch (e) {
      // Surface the server's message inline (e.g. 'Current password is incorrect').
      setError(parseErrorBody(e)?.error || e?.message || 'Could not change password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {[
        { key: 'cur', ph: 'Current password', val: cur, set: setCur, ac: 'current-password' },
        { key: 'new', ph: 'New password (min 8)', val: next, set: setNext, ac: 'new-password' },
        { key: 'conf', ph: 'Confirm new password', val: conf, set: setConf, ac: 'new-password' },
      ].map((f) => (
        <input key={f.key} type={show ? 'text' : 'password'} value={f.val} placeholder={f.ph}
          aria-label={f.ph} autoComplete={f.ac}
          onChange={(e) => { f.set(e.target.value); setError(''); }}
          style={{ width: '100%', padding: '7px 9px', borderRadius: 7, border: '1px solid var(--hairline-strong)', background: 'var(--control-bg)', color: 'var(--text)', fontSize: 12, boxSizing: 'border-box' }} />
      ))}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: 'rgba(var(--text-rgb),0.75)' }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)}
          style={{ width: 13, height: 13, accentColor: 'var(--accent)', cursor: 'pointer' }} />
        Show passwords
      </label>
      {hint && !error && <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.7)' }}>{hint}</div>}
      {error && <div role="alert" style={{ fontSize: 11, color: '#f87171' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={submit} disabled={!valid || busy}
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(35,209,139,0.30)', background: valid && !busy ? 'rgba(35,209,139,0.12)' : 'var(--surface-hover)', color: valid && !busy ? 'var(--accent)' : 'rgba(var(--text-rgb),0.35)', fontSize: 12, fontWeight: 700, cursor: valid && !busy ? 'pointer' : 'not-allowed' }}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--hairline-strong)', background: 'transparent', color: 'rgba(var(--text-rgb),0.75)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
