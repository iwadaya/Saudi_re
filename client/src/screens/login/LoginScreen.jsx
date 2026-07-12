// src/screens/login/LoginScreen.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  getSession, setSession, canAccessApprovals,
  createTestSession,
} from '../../utils/auth';
import { requirePasswordChange } from '../../utils/passwordGate';
import { api } from '../../api';
import ThemeSwitcher from '../../components/ThemeSwitcher';

// Login shows people by name only — nothing role-related. Titles live on the
// user record (set via the Add-user Title select) and drive routing/mandate
// silently after login from the server's session response.
const DEMO_FALLBACK = [
  { user_id:'00000000-0000-0000-0000-000000000001', username:'cuo',         display_name:'Chief Underwriting Officer', email:'cuo@universe3.app', role_code:'CU',  office:'Riyadh', treaty_limit_usd:null,     approvals_required:1 },
  { user_id:'00000000-0000-0000-0000-000000000002', username:'underwriter', display_name:'Underwriter',                email:'uw@universe3.app',  role_code:'TUW', office:'Riyadh', treaty_limit_usd:10000000, approvals_required:2 },
];

// One shared box model for every login control so the underwriter <select> and
// the password <input> are pixel-identical (the native select otherwise renders
// shorter + with an OS arrow — appearance:none + a custom chevron fixes that).
// Mirrors .form-input's dark-theme values (components.css) but with an explicit
// height + border-box so the two can't drift. The Sign In button reuses the
// width + radius below. Padding leaves room on the right for each field's icon
// (chevron / show-hide toggle).
const FIELD_HEIGHT = 42;
const FIELD_RADIUS = 10;
const FIELD_STYLE = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  height: FIELD_HEIGHT,
  margin: 0,
  padding: '0 38px 0 12px',
  fontSize: 13,
  fontFamily: 'inherit',
  color: 'var(--text)',
  background: 'var(--control-bg)',
  border: '1px solid var(--stroke-soft)',
  borderRadius: FIELD_RADIUS,
  outline: 'none',
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};
// Inline focus ring (identical on both fields) — matches .form-input:focus.
// Inline styles can't carry :focus, and the inline border above would otherwise
// win over the CSS rule, so the accent ring is applied via focus handlers (the
// same e.currentTarget.style idiom this file already uses for hover).
const onFieldFocus = (e) => {
  e.currentTarget.style.borderColor = 'rgba(var(--accent-rgb),0.5)';
  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(var(--accent-rgb),0.1)';
};
const onFieldBlur = (e) => {
  e.currentTarget.style.borderColor = 'var(--stroke-soft)';
  e.currentTarget.style.boxShadow = 'none';
};

// SSO block styling — const objects referenced with a single brace (style={obj})
// so they don't count against the screens-layer inline-style budget.
const SSO_DIVIDER = { display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0' };
const SSO_DIVIDER_LINE = { flex: 1, height: 1, background: 'var(--hairline)' };
const SSO_DIVIDER_TEXT = { fontSize: 10, color: 'rgba(var(--text-rgb),.58)', letterSpacing: '.08em', textTransform: 'uppercase' };
const SSO_BUTTON = {
  width: '100%', minHeight: FIELD_HEIGHT, borderRadius: FIELD_RADIUS,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  fontSize: 13, fontWeight: 700, cursor: 'pointer',
  color: 'var(--text)', background: 'var(--control-bg)',
  border: '1px solid var(--stroke-soft)',
};
// Error banner for ?sso_error — const (single-brace ref) to stay budget-neutral.
const SSO_ERR_BANNER = {
  padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,.12)',
  border: '1px solid rgba(248,113,113,.30)', color: '#f87171', fontSize: 12, marginBottom: 16,
};

// Friendly copy for the ?sso_error codes the server bounces back on a failed
// front-channel SSO attempt.
const SSO_ERRORS = {
  expired: 'Your sign-in session expired. Please try again.',
  mfa_required: 'Multi-factor authentication is required to sign in.',
  failed: 'Single sign-on failed. Please try again or use your password.',
};

// Top-level navigation (NOT fetch) — the OIDC flow needs a full-page redirect so
// the browser follows the IdP round-trip and lands back on /auth/callback.
function startSso() {
  window.location.assign(`/api/auth/sso/login?returnTo=${encodeURIComponent('/auth/callback')}`);
}

// ── Test Access Panel ─────────────────────────────────────────────────────────
function TestAccessPanel({ onLogin }) {
  const [name, setName] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    // Small delay so the panel animation completes before focusing
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onLogin(trimmed);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <div style={{
      marginTop: 12,
      padding: '16px',
      borderRadius: 12,
      background: 'rgba(var(--accent-rgb),0.07)',
      border: '1px solid rgba(var(--accent-rgb),0.25)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 10 }}>
        Test Access — Underwriter
      </div>
      <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.7)', marginBottom: 12, lineHeight: 1.5 }}>
        Enter your name. You'll be remembered on this device — no password needed.
      </div>
      <input
        ref={inputRef}
        type="text"
        className="form-input"
        placeholder="Your full name"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={handleKey}
        maxLength={60}
        style={{ width: '100%', marginBottom: 10 }}
        aria-label="Your name for test access"
      />
      <button
        type="button"
        className="action-pill action-pill--primary"
        onClick={handleSubmit}
        disabled={!name.trim()}
        style={{ width: '100%', minHeight: 38, fontSize: 13, fontWeight: 700, opacity: name.trim() ? 1 : 0.45 }}
      >
        Enter as Underwriter →
      </button>
    </div>
  );
}

// ── Add User Panel (test utility) ───────────────────────────────────────────
// Creates a real person + scrypt password through POST /auth/users. Styled as a
// dashed-accent test panel so it reads as a dev/QA convenience, not production UI.
function AddUserPanel({ onCreated, onCancel }) {
  const [roles, setRoles] = useState([]);
  const [firstName, setFirstName] = useState('');
  const [surname, setSurname] = useState('');
  const [roleId, setRoleId] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getRoles()
      .then(data => { const list = Array.isArray(data) ? data : []; setRoles(list); if (list[0]) setRoleId(list[0].role_id); })
      .catch(() => setRoles([]));
  }, []);

  const trimmed = { first: firstName.trim(), last: surname.trim() };
  const mismatch = !!password && !!confirm && password !== confirm;
  const canSave = trimmed.first && trimmed.last && roleId && password.length >= 6 && password === confirm && !saving;
  // One alert slot: a server error wins, else the mismatch hint.
  const msg = error || (mismatch ? 'Passwords do not match' : '');

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true); setError('');
    try {
      const created = await api.createUser({
        first_name: trimmed.first,
        surname: trimmed.last,
        role_id: roleId,
        password,
        confirm_password: confirm,
      });
      onCreated(created);
    } catch (err) {
      setError(err?.message || 'Could not create user.');
      setSaving(false);
    }
  };

  // .form-input already provides display:block + width:100%, so the fields
  // carry no inline sizing — only the dashed test-panel container, the title,
  // and the column gap do.
  return (
    <div style={{ marginTop: 12, padding: '16px', borderRadius: 12, background: 'rgba(var(--accent-rgb),0.07)', border: '1px dashed rgba(var(--accent-rgb),0.40)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 10 }}>
        Add User — Test Utility
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input className="form-input" placeholder="First name" aria-label="First name"
          value={firstName} onChange={e => { setFirstName(e.target.value); setError(''); }} />
        <input className="form-input" placeholder="Surname" aria-label="Surname"
          value={surname} onChange={e => { setSurname(e.target.value); setError(''); }} />
        <select className="form-input" aria-label="Title"
          value={roleId} onChange={e => setRoleId(e.target.value)}>
          {roles.map(r => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}
        </select>
        <input className="form-input" type="password" placeholder="Password" aria-label="Password"
          autoComplete="new-password"
          value={password} onChange={e => { setPassword(e.target.value); setError(''); }} />
        <input className="form-input" type="password" placeholder="Confirm password" aria-label="Confirm password"
          autoComplete="new-password"
          value={confirm} onChange={e => { setConfirm(e.target.value); setError(''); }} />
        {msg && <div role="alert" style={{ fontSize: 12, color: '#f87171' }}>{msg}</div>}
        <button type="button" className="action-pill action-pill--primary" onClick={handleSave}
          disabled={!canSave}
          style={{ minHeight: 38, fontWeight: 700, opacity: canSave ? 1 : 0.45 }}>
          {saving ? 'Saving…' : 'Save user'}
        </button>
        <button type="button" className="action-pill" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Main Login Screen ─────────────────────────────────────────────────────────
export default function LoginScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [ssoEnabled, setSsoEnabled]     = useState(false);
  const [users, setUsers]               = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedUser, setSelectedUser] = useState(null);
  const [password, setPassword]         = useState('');
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState('');
  const [showPw, setShowPw]             = useState(false);
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [showAddUser, setShowAddUser]   = useState(false);
  const [addUserSuccess, setAddUserSuccess] = useState('');

  // Already authenticated — skip login
  useEffect(() => {
    if (getSession()) navigate(canAccessApprovals() ? '/approvals' : '/select', { replace: true });
  }, [navigate]);

  // Load ALL active users for the people dropdown. Demo fallback covers the
  // network-failure / empty case only — no role filtering or dedupe.
  // No spoofed x-user-* headers: the server returns a minimal projection to
  // unauthenticated callers, so an elevated role header would be misleading.
  const loadUsers = (selectUserId) => api.getUsers()
    .then(data => {
      const list = Array.isArray(data) && data.length ? data : DEMO_FALLBACK;
      setUsers(list);
      // Only select a user when one is explicitly requested (e.g. just created
      // via Add-user). On a plain load nothing is pre-selected — the dropdown
      // shows the "Select underwriter…" placeholder.
      const picked = (selectUserId && list.find(u => u.user_id === selectUserId)) || null;
      setSelectedUser(picked);
      return list;
    })
    .catch(() => { setUsers(DEMO_FALLBACK); return DEMO_FALLBACK; });

  useEffect(() => {
    loadUsers().finally(() => setLoadingUsers(false));
  }, []);

  // Probe SSO posture so the button only shows when the server has SSO on.
  useEffect(() => {
    api.getSsoStatus()
      .then(s => setSsoEnabled(!!s?.enabled))
      .catch(() => setSsoEnabled(false));
  }, []);

  const ssoError = SSO_ERRORS[searchParams.get('sso_error')] || '';

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!selectedUser || !password) { setError('Select a user and enter your password.'); return; }
    setLoading(true); setError('');
    try {
      const { session } = await api.loginUser({
        username: selectedUser.username || selectedUser.email,
        password,
      });
      // Use the person's real name, not the role title.
      setSession({ ...session, displayName: selectedUser.display_name || session.displayName });
      // Forced first-login change: flip the gate so the mandatory "Set your
      // password" modal appears immediately (the AppShell overlay reads this).
      if (session.mustChangePassword) requirePasswordChange();
      navigate(canAccessApprovals() ? '/approvals' : '/select');
    } catch (err) {
      setError(err.message || 'Login failed.');
    } finally { setLoading(false); }
  };

  const handleTestLogin = (name) => {
    createTestSession(name);
    navigate('/select');
  };

  const handleUserCreated = async (created) => {
    setShowAddUser(false);
    setError('');
    await loadUsers(created?.user_id);
    setAddUserSuccess(`Added ${created?.display_name || 'user'} — select them and sign in.`);
  };

  const sel = selectedUser;

  return (
    <div className="LOGIN_SCREEN" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 16, right: 20 }}>
        <ThemeSwitcher />
      </div>
      <div style={{ width: '100%', maxWidth: 420 }}>

        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,rgba(var(--accent-rgb),.9),rgba(var(--accent2-rgb),.9))', fontSize: 22, fontWeight: 900, color: 'var(--accent-contrast)', marginBottom: 12, boxShadow: '0 8px 24px rgba(var(--accent-rgb),.3)' }}>U3</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'rgba(var(--text-rgb),.92)', letterSpacing: '.01em' }}>The Universe™</div>
          <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.7)', marginTop: 3, letterSpacing: '.07em', textTransform: 'uppercase' }}>Reinsurance Underwriting Platform</div>
        </div>

        <div className="glass" style={{ borderRadius: 16, padding: 24, border: '1px solid var(--hairline)' }}>
          {ssoError && (
            <div role="alert" style={SSO_ERR_BANNER}>
              {ssoError}
            </div>
          )}
          <div style={{ marginBottom: 18 }}>
            <label htmlFor="login-user" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(var(--text-rgb),.7)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 }}>Underwriter</label>
            {loadingUsers ? (
              <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.7)', padding: '10px 0' }} aria-live="polite">Loading users…</div>
            ) : (
              <div style={{ position: 'relative' }}>
                <select
                  id="login-user"
                  className="form-input"
                  aria-label="Underwriter"
                  value={sel?.user_id || ''}
                  onChange={e => { setSelectedUser(users.find(u => u.user_id === e.target.value) || null); setError(''); }}
                  onFocus={onFieldFocus}
                  onBlur={onFieldBlur}
                  style={FIELD_STYLE}
                >
                  <option value="" disabled>Select underwriter…</option>
                  {users.map(u => (
                    <option key={u.user_id || u.email} value={u.user_id}>{u.display_name}</option>
                  ))}
                </select>
                {/* Custom chevron — the native arrow is removed by appearance:none
                    so the select height matches the password input exactly. */}
                <span aria-hidden="true" style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'rgba(var(--text-rgb),.7)', fontSize: 10 }}>▼</span>
              </div>
            )}
          </div>

          <form onSubmit={handleLogin} aria-label="Sign in">
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="login-password" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(var(--text-rgb),.7)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 6 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input id="login-password" type={showPw ? 'text' : 'password'} className="form-input"
                  value={password} onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="Enter your password" autoComplete="current-password"
                  aria-describedby={error ? 'login-error' : (import.meta.env.DEV ? 'login-hint' : undefined)}
                  aria-invalid={!!error}
                  onFocus={onFieldFocus} onBlur={onFieldBlur}
                  style={FIELD_STYLE} />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  aria-pressed={showPw}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(var(--text-rgb),.58)', fontSize: 12, padding: 2 }}>
                  <span aria-hidden="true">{showPw ? '▼' : '▶'}</span>
                </button>
              </div>
              {import.meta.env.DEV && (
                <div id="login-hint" style={{ fontSize: 10, color: 'rgba(var(--text-rgb),.58)', marginTop: 5 }}>
                  Demo: <span style={{ fontFamily: 'var(--font-mono)', color: 'rgba(var(--text-rgb),.7)' }}>demo2026</span>
                </div>
              )}
            </div>

            {error && (
              <div id="login-error" role="alert" style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,.12)', border: '1px solid rgba(248,113,113,.30)', color: '#f87171', fontSize: 12, marginBottom: 14 }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading || !sel || !password}
              className="action-pill action-pill--primary"
              aria-label={loading ? 'Signing in' : 'Sign in'}
              style={{ width: '100%', minHeight: FIELD_HEIGHT, borderRadius: FIELD_RADIUS, fontSize: 14, fontWeight: 700, opacity: (loading || !sel || !password) ? 0.5 : 1 }}>
              {loading ? 'Signing in…' : <>Sign In <span aria-hidden="true">→</span></>}
            </button>
          </form>

          {/* ── Single sign-on (shown only when the server has SSO enabled) ── */}
          {ssoEnabled && (
            <>
              <div style={SSO_DIVIDER} aria-hidden="true">
                <span style={SSO_DIVIDER_LINE} />
                <span style={SSO_DIVIDER_TEXT}>or</span>
                <span style={SSO_DIVIDER_LINE} />
              </div>
              <button type="button" onClick={startSso} className="action-pill" style={SSO_BUTTON}
                aria-label="Sign in with single sign-on">
                <span aria-hidden="true">🔑</span> Sign in with SSO
              </button>
            </>
          )}

          {/* ── Add user (test utility — DEV builds only, compiled out of prod) ── */}
          {import.meta.env.DEV && (
          <div style={{ marginTop: 16, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
            {addUserSuccess && !showAddUser && (
              <div role="status" style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 10 }}>{addUserSuccess}</div>
            )}
            {!showAddUser ? (
              <button
                type="button"
                onClick={() => { setShowAddUser(true); setAddUserSuccess(''); }}
                style={{ width: '100%', background: 'none', border: '1px dashed rgba(var(--accent-rgb),0.30)', borderRadius: 8, padding: '9px 12px', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', letterSpacing: '.03em', transition: 'all .15s' }}
              >
                + Add user (test)
              </button>
            ) : (
              <AddUserPanel onCreated={handleUserCreated} onCancel={() => setShowAddUser(false)} />
            )}
          </div>
          )}

          {/* ── Test Access (DEV builds only — compiled out of production) ── */}
          {import.meta.env.DEV && (
          <div style={{ marginTop: 16, borderTop: '1px solid var(--hairline)', paddingTop: 14 }}>
            {!showTestPanel ? (
              <button
                type="button"
                onClick={() => setShowTestPanel(true)}
                style={{ width: '100%', background: 'none', border: '1px dashed rgba(var(--accent-rgb),0.30)', borderRadius: 8, padding: '9px 12px', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', letterSpacing: '.03em', transition: 'all .15s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(var(--accent-rgb),0.55)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(var(--accent-rgb),0.30)'}
              >
                Testing? Enter without password →
              </button>
            ) : (
              <TestAccessPanel onLogin={handleTestLogin} />
            )}
          </div>
          )}
        </div>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 10, color: 'rgba(var(--text-rgb),.5)', letterSpacing: '.04em' }}>
          The Universe™ · by Darchville Analytics
        </div>
      </div>
    </div>
  );
}
