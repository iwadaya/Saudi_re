// src/screens/login/LoginScreen.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getSession, setSession, canAccessApprovals,
  createTestSession,
} from '../../utils/auth';
import { api } from '../../api';
import ThemeSwitcher from '../../components/ThemeSwitcher';

// Login shows people by name only — nothing role-related. Titles live on the
// user record (set via the Add-user Title select) and drive routing/mandate
// silently after login from the server's session response.
const DEMO_FALLBACK = [
  { user_id:'00000000-0000-0000-0000-000000000001', username:'cuo',         display_name:'Chief Underwriting Officer', email:'cuo@universe3.app', role_code:'CU',  office:'Riyadh', treaty_limit_usd:null,     approvals_required:1 },
  { user_id:'00000000-0000-0000-0000-000000000002', username:'underwriter', display_name:'Underwriter',                email:'uw@universe3.app',  role_code:'TUW', office:'Riyadh', treaty_limit_usd:10000000, approvals_required:2 },
];

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
      background: 'rgba(35,209,139,0.07)',
      border: '1px solid rgba(35,209,139,0.25)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(35,209,139,0.8)', letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 10 }}>
        Test Access — Underwriter
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,.45)', marginBottom: 12, lineHeight: 1.5 }}>
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
    <div style={{ marginTop: 12, padding: '16px', borderRadius: 12, background: 'rgba(35,209,139,0.07)', border: '1px dashed rgba(35,209,139,0.40)' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(35,209,139,0.8)', letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 10 }}>
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
  const loadUsers = (selectUserId) => api.getUsers({ headers: { 'x-user-role': 'CU', 'x-user-id': 'system', 'x-user-name': 'System' } })
    .then(data => {
      const list = Array.isArray(data) && data.length ? data : DEMO_FALLBACK;
      setUsers(list);
      const picked = (selectUserId && list.find(u => u.user_id === selectUserId)) || list[0] || null;
      setSelectedUser(picked);
      return list;
    })
    .catch(() => { setUsers(DEMO_FALLBACK); setSelectedUser(DEMO_FALLBACK[0]); return DEMO_FALLBACK; });

  useEffect(() => {
    loadUsers().finally(() => setLoadingUsers(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,rgba(35,209,139,.9),rgba(18,160,100,.9))', fontSize: 22, fontWeight: 900, color: '#04120b', marginBottom: 12, boxShadow: '0 8px 24px rgba(35,209,139,.3)' }}>U3</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'rgba(255,255,255,.92)', letterSpacing: '.01em' }}>The Universe™</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)', marginTop: 3, letterSpacing: '.07em', textTransform: 'uppercase' }}>Reinsurance Underwriting Platform</div>
        </div>

        <div className="glass" style={{ borderRadius: 16, padding: 24, border: '1px solid rgba(255,255,255,.10)' }}>
          <div style={{ marginBottom: 18 }}>
            <label htmlFor="login-user" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.40)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 }}>Underwriter</label>
            {loadingUsers ? (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,.35)', padding: '10px 0' }} aria-live="polite">Loading users…</div>
            ) : (
              <select
                id="login-user"
                className="form-input"
                aria-label="Underwriter"
                value={sel?.user_id || ''}
                onChange={e => { setSelectedUser(users.find(u => u.user_id === e.target.value) || null); setError(''); }}
              >
                {users.map(u => (
                  <option key={u.user_id || u.email} value={u.user_id}>{u.display_name}</option>
                ))}
              </select>
            )}
          </div>

          <form onSubmit={handleLogin} aria-label="Sign in">
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="login-password" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.40)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 6 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input id="login-password" type={showPw ? 'text' : 'password'} className="form-input"
                  value={password} onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="Enter your password" autoComplete="current-password"
                  aria-describedby={error ? 'login-error' : 'login-hint'}
                  aria-invalid={!!error}
                  style={{ width: '100%', paddingRight: 40 }} />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  aria-pressed={showPw}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,.30)', fontSize: 12, padding: 2 }}>
                  <span aria-hidden="true">{showPw ? '▼' : '▶'}</span>
                </button>
              </div>
              <div id="login-hint" style={{ fontSize: 10, color: 'rgba(255,255,255,.22)', marginTop: 5 }}>
                Demo: <span style={{ fontFamily: 'var(--font-mono)', color: 'rgba(255,255,255,.38)' }}>demo2026</span>
              </div>
            </div>

            {error && (
              <div id="login-error" role="alert" style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,.12)', border: '1px solid rgba(248,113,113,.30)', color: '#f87171', fontSize: 12, marginBottom: 14 }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading || !sel || !password}
              className="action-pill action-pill--primary"
              aria-label={loading ? 'Signing in' : 'Sign in'}
              style={{ width: '100%', minHeight: 42, fontSize: 14, fontWeight: 700, opacity: (loading || !sel || !password) ? 0.5 : 1 }}>
              {loading ? 'Signing in…' : <>Sign In <span aria-hidden="true">→</span></>}
            </button>
          </form>

          {/* ── Add user (test utility) ─────────────────────────────────── */}
          <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 14 }}>
            {addUserSuccess && !showAddUser && (
              <div role="status" style={{ fontSize: 11, color: 'rgba(35,209,139,0.85)', marginBottom: 10 }}>{addUserSuccess}</div>
            )}
            {!showAddUser ? (
              <button
                type="button"
                onClick={() => { setShowAddUser(true); setAddUserSuccess(''); }}
                style={{ width: '100%', background: 'none', border: '1px dashed rgba(35,209,139,0.30)', borderRadius: 8, padding: '9px 12px', color: 'rgba(35,209,139,0.65)', fontSize: 12, fontWeight: 600, cursor: 'pointer', letterSpacing: '.03em', transition: 'all .15s' }}
              >
                + Add user (test)
              </button>
            ) : (
              <AddUserPanel onCreated={handleUserCreated} onCancel={() => setShowAddUser(false)} />
            )}
          </div>

          {/* ── Test Access ─────────────────────────────────────────────── */}
          <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 14 }}>
            {!showTestPanel ? (
              <button
                type="button"
                onClick={() => setShowTestPanel(true)}
                style={{ width: '100%', background: 'none', border: '1px dashed rgba(35,209,139,0.30)', borderRadius: 8, padding: '9px 12px', color: 'rgba(35,209,139,0.65)', fontSize: 12, fontWeight: 600, cursor: 'pointer', letterSpacing: '.03em', transition: 'all .15s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(35,209,139,0.55)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(35,209,139,0.30)'}
              >
                Testing? Enter without password →
              </button>
            ) : (
              <TestAccessPanel onLogin={handleTestLogin} />
            )}
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 10, color: 'rgba(255,255,255,.18)', letterSpacing: '.04em' }}>
          The Universe™ · by Darchville Analytics
        </div>
      </div>
    </div>
  );
}
