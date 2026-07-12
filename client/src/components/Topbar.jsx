// src/components/Topbar.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSession, ROLE_LABELS, canAccessApprovals, isAtLeast } from '../utils/auth';
import { performLogout } from '../utils/logout';
import { useViewAllTreaties } from '../utils/prefs';
import { api } from '../api';
import ChangePasswordForm from './ChangePasswordForm';
import ThemeSwitcher from './ThemeSwitcher';

const ROLE_COLORS = {
  CE:  { bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.35)', text: '#a78bfa' },
  CU:  { bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)',  text: '#fbbf24' },
  TD:  { bg: 'rgba(96,165,250,0.12)',  border: 'rgba(96,165,250,0.35)',  text: '#60a5fa' },
  TM:  { bg: 'rgba(45,212,191,0.12)',  border: 'rgba(45,212,191,0.35)',  text: '#2dd4bf' },
  TUW: { bg: 'rgba(35,209,139,0.10)', border: 'rgba(35,209,139,0.30)', text: '#23d18b' },
};

const ROLE_COLORS_MINI = { CE:'#a78bfa', CU:'#fbbf24', TD:'#60a5fa', TM:'#2dd4bf', TUW:'#23d18b' };

function fmtLimit(usd) {
  if (usd === null || usd === undefined) return null;
  const n = Number(usd);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

// Exposed so HomeScreen can read & set viewing user without prop drilling
export const viewingUserStore = { user: null, listeners: [] };
export function setViewingUser(u) {
  viewingUserStore.user = u;
  viewingUserStore.listeners.forEach(fn => fn(u));
}
export function useViewingUser() {
  const [u, setU] = useState(viewingUserStore.user);
  useEffect(() => {
    const fn = (v) => setU(v);
    viewingUserStore.listeners.push(fn);
    return () => { viewingUserStore.listeners = viewingUserStore.listeners.filter(f => f !== fn); };
  }, []);
  return u;
}

export default function Topbar({ title, subtitle, actions }) {
  const navigate = useNavigate();
  const session  = getSession();
  const rc = session?.roleCode;
  const sessionRoleCode = session?.roleCode;
  const c  = ROLE_COLORS[rc] || ROLE_COLORS.TUW;
  const limit = fmtLimit(session?.effectiveLimitUsd);

  const [open, setOpen]         = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewAll, setViewAll]   = useViewAllTreaties();
  const [teamUsers, setTeamUsers] = useState([]);
  const [viewingUser, setVU]    = useState(viewingUserStore.user);
  const ref = useRef(null);
  const settingsRef = useRef(null);

  // ── Self-service password change (shared ChangePasswordForm) ──
  const [pwOpen, setPwOpen] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  // Sync with store
  useEffect(() => {
    const fn = (u) => setVU(u);
    viewingUserStore.listeners.push(fn);
    return () => { viewingUserStore.listeners = viewingUserStore.listeners.filter(f => f !== fn); };
  }, []);

  // Login is currently scoped to Chief Underwriter and Treaty Underwriter
  // demo roles. Keep the portfolio view unfiltered for both.
  useEffect(() => {
    if (!sessionRoleCode || sessionRoleCode === 'CU' || sessionRoleCode === 'TUW') {
      setTeamUsers([]);
      setViewingUser(null);
      return;
    }
    api.getViewableUsers().then(rows => setTeamUsers(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, [sessionRoleCode]);

  // Close on outside click — both popovers
  useEffect(() => {
    if (!open && !settingsOpen) return;
    const handler = (e) => {
      if (open && ref.current && !ref.current.contains(e.target)) setOpen(false);
      if (settingsOpen && settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, settingsOpen]);

  const selectUser = (user) => {
    setViewingUser(user);
    setOpen(false);
  };
  const selectSelf = () => {
    setViewingUser(null);
    setOpen(false);
  };

  const displayRc = viewingUser ? viewingUser.role_code : rc;
  const displayC  = (viewingUser ? { bg: ROLE_COLORS_MINI[displayRc]+'20', border: ROLE_COLORS_MINI[displayRc]+'60', text: ROLE_COLORS_MINI[displayRc]||'#94a3b8' } : c);
  const isViewing = !!viewingUser;
  const canAllocateFrom = viewingUser && (session?.hierarchyLevel || 99) <= (viewingUser.hierarchy_level || 99);

  return (
    <header className="topbar glass" role="banner" style={{ position:"relative", zIndex:10001 }}>
      <div className="topbar-left">
        <div className="logo-badge" aria-hidden="true">U</div>
        <h1 className="topbar-title" style={{ margin: 0, fontSize: 'inherit', fontWeight: 'inherit', letterSpacing: 'inherit' }}>{title || 'MODELLING TOOL'}</h1>
        {subtitle && <div className="topbar-sub muted" style={{ marginLeft: 8 }}>{subtitle}</div>}
      </div>
      <div className="topbar-right" role="toolbar" aria-label="Top bar actions">
        {actions}

        {/* Settings — consolidated home for the theme switcher and the
            view-as / role chip. Both used to live inline in the topbar;
            grouping them here keeps the topbar focused on workflow
            actions (Approvals / Users / Home) and gives "settings"-y
            controls a single, predictable location. */}
        <div ref={settingsRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className="topbar-home"
            onClick={() => setSettingsOpen(v => !v)}
            aria-haspopup="true"
            aria-expanded={settingsOpen}
          >⚙ SETTINGS</button>

          {settingsOpen && (
            <div style={{ position: 'fixed', top: 52, right: 12, width: 300, background: 'var(--panel-bg-strong)', border: '1px solid var(--hairline-strong)', borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,0.35)', zIndex: 99999, overflow: 'hidden' }}>
              {/* Heading */}
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hairline)', fontSize: 12, fontWeight: 800, color: 'rgba(var(--text-rgb),0.85)', textTransform: 'uppercase', letterSpacing: '.10em' }}>
                Settings
              </div>

              {/* Theme */}
              {session && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hairline)' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(var(--text-rgb),0.45)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Theme</div>
                  <ThemeSwitcher />
                </div>
              )}

              {/* View treaties — display preference only; edit rights are
                  always enforced server-side regardless of this toggle. */}
              {session && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hairline)' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(var(--text-rgb),0.45)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>View treaties</div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={viewAll} onChange={(e) => setViewAll(e.target.checked)}
                      style={{ width: 14, height: 14, accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.80)' }}>Show everyone&apos;s treaties (read-only)</span>
                  </label>
                  <div style={{ fontSize: 9, color: 'rgba(var(--text-rgb),0.45)', marginTop: 4, lineHeight: 1.4 }}>
                    You can view others&apos; treaties but can only edit ones assigned to you.
                  </div>
                </div>
              )}

              {/* Identity / view-as */}
              {session && (
                <div ref={ref} style={{ position: 'relative', padding: '12px 16px', borderBottom: '1px solid var(--hairline)' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(var(--text-rgb),0.45)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Role</div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 6px', borderRadius: 20, background: displayC.bg, border: `1px solid ${displayC.border}`, cursor: 'pointer', position: 'relative', width: '100%' }}
                  >
                    <div style={{ width: 22, height: 22, borderRadius: '50%', background: displayC.border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: displayC.text, flexShrink: 0 }}>
                      {(isViewing ? viewingUser.role_code : session.roleCode) || '—'}
                    </div>
                    <div style={{ lineHeight: 1.2, textAlign: 'left', flex: 1 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: displayC.text }}>
                        {isViewing ? (viewingUser.role_name || ROLE_LABELS[viewingUser.role_code] || viewingUser.role_code) : (ROLE_LABELS[session.roleCode] || session.roleCode)}
                        {isViewing && <span style={{ marginLeft: 4, fontSize: 8, opacity: 0.7 }}>▼</span>}
                      </div>
                      <div style={{ fontSize: 9, color: 'rgba(var(--text-rgb),.40)' }}>
                        {isViewing
                          ? <span style={{ color: displayC.text }}>Viewing · {canAllocateFrom ? 'Can allocate' : 'View only'}</span>
                          : <>{ROLE_LABELS[rc] || rc}{limit ? ` · ${limit}` : ''}</>
                        }
                      </div>
                    </div>
                    <span style={{ fontSize: 9, color: 'rgba(var(--text-rgb),0.45)', marginLeft: 2 }}>▾</span>
                  </button>

                  {/* View Portfolio sub-dropdown — anchored to the role
                      row so it overlays the rest of the settings panel
                      without resizing it. */}
                  {open && (
                    <div style={{ position: 'absolute', top: '100%', left: 16, right: 16, marginTop: 6, background: 'var(--panel-bg-strong)', border: '1px solid var(--hairline-strong)', borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,0.35)', zIndex: 99999, overflow: 'hidden' }}>
                      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--hairline)', fontSize: 10, fontWeight: 700, color: 'rgba(var(--text-rgb),0.45)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                        View Portfolio
                      </div>
                      <button onClick={selectSelf} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', border: 'none', background: !isViewing ? 'rgba(var(--accent-rgb),0.10)' : 'transparent', cursor: 'pointer', borderBottom: '1px solid var(--hairline)' }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: !isViewing ? 'rgba(var(--accent-rgb),0.3)' : 'var(--surface-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: !isViewing ? 'var(--accent)' : 'rgba(var(--text-rgb),0.5)', flexShrink: 0 }}>
                          {session.roleCode || '—'}
                        </div>
                        <div style={{ flex: 1, textAlign: 'left' }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: !isViewing ? 'var(--accent)' : 'rgba(var(--text-rgb),0.80)' }}>{ROLE_LABELS[rc] || rc} <span style={{ fontSize: 9, opacity: 0.6 }}>(me)</span></div>
                          <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.45)' }}>{limit ? limit : '—'}</div>
                        </div>
                        {!isViewing && <span style={{ fontSize: 10, color: 'var(--accent)' }}>✓</span>}
                      </button>
                      {teamUsers.length > 0 && (
                        <div style={{ padding: '6px 14px 4px', fontSize: 9, fontWeight: 700, color: 'rgba(var(--text-rgb),0.40)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Team</div>
                      )}
                      {teamUsers.map(u => {
                        const urc = u.role_code;
                        const uc  = ROLE_COLORS_MINI[urc] || '#94a3b8';
                        const isSel = isViewing && viewingUser?.user_id === u.user_id;
                        const myLevel = session?.hierarchyLevel || 99;
                        const canAlloc = u.hierarchy_level >= myLevel;
                        return (
                          <button key={u.user_id} onClick={() => selectUser(u)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: isSel ? `${uc}15` : 'transparent', cursor: 'pointer', borderBottom: '1px solid var(--hairline)' }}>
                            <div style={{ width: 28, height: 28, borderRadius: '50%', background: isSel ? `${uc}30` : 'var(--surface-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: isSel ? uc : 'rgba(var(--text-rgb),0.45)', flexShrink: 0 }}>
                              {urc || '—'}
                            </div>
                            <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: isSel ? uc : 'rgba(var(--text-rgb),0.75)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.role_name || ROLE_LABELS[urc] || urc}</div>
                              <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.42)' }}>
                                {u.office || '—'}
                                {canAlloc && <span style={{ color: 'var(--accent)', marginLeft: 4 }}>· Can allocate</span>}
                              </div>
                            </div>
                            {isSel && <span style={{ fontSize: 10, color: uc, flexShrink: 0 }}>✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Password — self-service change for the logged-in user. The
                  server takes the actor from the verified token, never a body id. */}
              {session && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hairline)' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(var(--text-rgb),0.45)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Password</div>
                  {!pwOpen ? (
                    <>
                      <button type="button" onClick={() => { setPwOpen(true); setPwDone(false); }}
                        style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--hairline-strong)', background: 'var(--surface-hover)', color: 'rgba(var(--text-rgb),0.85)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        Change password
                      </button>
                      {pwDone && <div role="status" style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>✓ Password updated</div>}
                    </>
                  ) : (
                    <ChangePasswordForm
                      onSuccess={() => { setPwOpen(false); setPwDone(true); setTimeout(() => setPwDone(false), 4000); }}
                      onCancel={() => setPwOpen(false)}
                    />
                  )}
                </div>
              )}

              {/* Logout */}
              {session && (
                <div style={{ padding: 8 }}>
                  <button onClick={async () => { setViewingUser(null); await performLogout(); navigate('/login'); }} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(248,113,113,0.25)', background: 'rgba(248,113,113,0.08)', color: '#f87171', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                    ⎋ Log Out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {canAccessApprovals() && (
          <button className="topbar-home" type="button" onClick={() => navigate('/approvals')}>⊞ APPROVALS</button>
        )}
        {isAtLeast(2) && (
          <button className="topbar-home" type="button" onClick={() => navigate('/admin/users')}>⚙ USERS</button>
        )}
        <button className="topbar-home" type="button" onClick={() => navigate('/')}>↑ HOME</button>
      </div>
    </header>
  );
}
