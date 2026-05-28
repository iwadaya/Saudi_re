// src/screens/login/LoginScreen.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getSession, setSession, ROLE_LABELS, canAccessApprovals,
  createTestSession,
} from '../../utils/auth';
import { api } from '../../api';
import ThemeSwitcher from '../../components/ThemeSwitcher';

const ROLE_COLORS = {
  CE:  { bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.40)', text: '#a78bfa' },
  CU:  { bg: 'rgba(251,191,36,0.13)',  border: 'rgba(251,191,36,0.40)',  text: '#fbbf24' },
  TD:  { bg: 'rgba(96,165,250,0.13)',  border: 'rgba(96,165,250,0.40)',  text: '#60a5fa' },
  TM:  { bg: 'rgba(45,212,191,0.13)',  border: 'rgba(45,212,191,0.40)',  text: '#2dd4bf' },
  TUW: { bg: 'rgba(35,209,139,0.13)', border: 'rgba(35,209,139,0.40)', text: '#23d18b' },
};

const LOGIN_ROLE_ORDER = ['CU', 'TUW'];
const LOGIN_ROLE_CODES = new Set(LOGIN_ROLE_ORDER);

function RoleBadge({ code }) {
  const c = ROLE_COLORS[code] || ROLE_COLORS.TUW;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 20,
      fontSize: 10, fontWeight: 700, letterSpacing: 0,
      background: c.bg, border: `1px solid ${c.border}`, color: c.text,
    }}>{code}</span>
  );
}

function fmtLimit(usd) {
  if (usd === null || usd === undefined) return 'Unlimited';
  const n = Number(usd);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

const DEMO_FALLBACK = [
  { user_id:'00000000-0000-0000-0000-000000000001', username:'cuo',         email:'cuo@universe3.app', role_code:'CU',  office:'Riyadh', treaty_limit_usd:null,     approvals_required:1 },
  { user_id:'00000000-0000-0000-0000-000000000002', username:'underwriter', email:'uw@universe3.app',  role_code:'TUW', office:'Riyadh', treaty_limit_usd:10000000, approvals_required:2 },
];

function titleFor(u) {
  return ROLE_LABELS[u?.role_code] || 'User';
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
      background: 'rgba(35,209,139,0.07)',
      border: '1px solid rgba(35,209,139,0.25)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(35,209,139,0.8)', letterSpacing: 0, textTransform: 'uppercase', marginBottom: 10 }}>
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

  // Already authenticated — skip login
  useEffect(() => {
    if (getSession()) navigate(canAccessApprovals() ? '/approvals' : '/select', { replace: true });
  }, [navigate]);

  useEffect(() => {
    api.getUsers({ headers: { 'x-user-role': 'CU', 'x-user-id': 'system', 'x-user-name': 'System' } })
      .then(data => {
        const rawList = Array.isArray(data) ? data.filter(u => LOGIN_ROLE_CODES.has(u?.role_code)) : [];
        const seen = new Map();
        for (const u of rawList) {
          if (!seen.has(u.role_code)) seen.set(u.role_code, u);
        }
        const list = Array.from(seen.values()).sort(
          (a, b) => LOGIN_ROLE_ORDER.indexOf(a.role_code) - LOGIN_ROLE_ORDER.indexOf(b.role_code)
        );
        if (!list.length) {
          setUsers(DEMO_FALLBACK);
          setSelectedUser(DEMO_FALLBACK[0]);
          return;
        }
        setUsers(list);
        if (list.length) setSelectedUser(list[0]);
      })
      .catch(() => { setUsers(DEMO_FALLBACK); setSelectedUser(DEMO_FALLBACK[0]); })
      .finally(() => setLoadingUsers(false));
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
      const roleTitle = ROLE_LABELS[session.roleCode] || session.displayName || 'User';
      setSession({ ...session, displayName: roleTitle });
      navigate(canAccessApprovals() ? '/approvals' : '/select');
    } catch (err) {
      setError(err.message || 'Login failed.');
    } finally { setLoading(false); }
  };

  const handleTestLogin = (name) => {
    createTestSession(name);
    navigate('/select');
  };

  const sel = selectedUser;
  const rc  = sel?.role_code;
  const c   = ROLE_COLORS[rc] || ROLE_COLORS.TUW;

  return (
    <div className="LOGIN_SCREEN" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 16, right: 20 }}>
        <ThemeSwitcher />
      </div>
      <div style={{ width: '100%', maxWidth: 420 }}>

        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,rgba(35,209,139,.9),rgba(18,160,100,.9))', fontSize: 22, fontWeight: 900, color: '#04120b', marginBottom: 12, boxShadow: '0 8px 24px rgba(35,209,139,.3)' }}>U3</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'rgba(255,255,255,.92)', letterSpacing: 0 }}>The Universe™</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,.35)', marginTop: 3, letterSpacing: 0, textTransform: 'uppercase' }}>Reinsurance Underwriting Platform</div>
        </div>

        <div className="glass" style={{ borderRadius: 16, padding: 24, border: '1px solid rgba(255,255,255,.10)' }}>
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.40)', letterSpacing: 0, textTransform: 'uppercase', marginBottom: 8 }}>Select User</div>
            {loadingUsers ? (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,.35)', padding: '10px 0' }} aria-live="polite">Loading users…</div>
            ) : (
              <div role="radiogroup" aria-label="Select role" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {users.map(u => {
                  const urc = u.role_code;
                  const uc  = ROLE_COLORS[urc] || ROLE_COLORS.TUW;
                  const isSel = sel?.user_id === u.user_id || sel?.email === u.email;
                  return (
                    <button key={u.user_id || u.email}
                      type="button"
                      role="radio"
                      aria-checked={isSel}
                      aria-label={`Select ${titleFor(u)}`}
                      onClick={() => { setSelectedUser(u); setError(''); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: isSel ? `1px solid ${uc.border}` : '1px solid rgba(255,255,255,.08)', background: isSel ? uc.bg : 'rgba(255,255,255,.03)', cursor: 'pointer', textAlign: 'left', transition: 'all .12s', width: '100%' }}>
                      <div style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, background: isSel ? uc.border : 'rgba(255,255,255,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: isSel ? uc.text : 'rgba(255,255,255,.45)' }}>
                        {titleFor(u).split(' ').filter(p=>p).map(p => p[0]).join('').slice(0,2).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: isSel ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.65)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleFor(u)}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                        <RoleBadge code={urc} />
                        <div style={{ fontSize: 9, color: 'rgba(255,255,255,.28)' }}>{fmtLimit(u.treaty_limit_usd)}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {sel && (
            <div style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 16, background: c.bg, border: `1px solid ${c.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: c.text }}>{ROLE_LABELS[rc] || rc}</div>
              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,.30)', textTransform: 'uppercase', letterSpacing: 0 }}>Treaty Limit</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,.80)' }}>{fmtLimit(sel.treaty_limit_usd ?? sel.authority_limit_usd)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,.30)', textTransform: 'uppercase', letterSpacing: 0 }}>Approvals</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,.80)' }}>{sel.approvals_required ?? 1}×</div>
                </div>
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} aria-label="Sign in">
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="login-password" style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,.40)', letterSpacing: 0, textTransform: 'uppercase', marginBottom: 6 }}>Password</label>
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

          {/* ── Test Access ─────────────────────────────────────────────── */}
          <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,.07)', paddingTop: 14 }}>
            {!showTestPanel ? (
              <button
                type="button"
                onClick={() => setShowTestPanel(true)}
                style={{ width: '100%', background: 'none', border: '1px dashed rgba(35,209,139,0.30)', borderRadius: 8, padding: '9px 12px', color: 'rgba(35,209,139,0.65)', fontSize: 12, fontWeight: 600, cursor: 'pointer', letterSpacing: 0, transition: 'all .15s' }}
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

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 10, color: 'rgba(255,255,255,.18)', letterSpacing: 0 }}>
          The Universe™ · by Darchville Analytics
        </div>
      </div>
    </div>
  );
}
