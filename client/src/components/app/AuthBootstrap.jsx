// Boot-time session verification. Wraps AppShell so that a stored session is
// confirmed against the server BEFORE any protected route renders — a stale /
// expired / invalid token can no longer flash a protected screen before the
// AuthGuard catches up.
//
// Flow:
//   • No stored session            → render immediately (AuthGuard sends
//                                     protected routes to /login).
//   • Stored session → GET /auth/me (awaited):
//       - 200      → refresh the local session from server truth, then render.
//                    mustChangePassword:true flips the forced-change gate so the
//                    mandatory modal shows instead of /select.
//       - 401      → clearSession() (genuinely invalid token) and render
//                    logged-out → /login.
//       - network / 5xx / timeout → do NOT log out; show a retry state. We only
//                    clear on a definitive 401, never on a transient fetch error,
//                    so "stay logged in" is preserved across blips.
import { useCallback, useEffect, useState } from 'react';
import { getSession, setSession, clearSession } from '../../utils/auth';
import { requirePasswordChange } from '../../utils/passwordGate';
import { api } from '../../api';
import ScreenFallback from './ScreenFallback';

function BootOffline({ onRetry }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 360, textAlign: 'center', color: '#d7dceb' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Can&apos;t reach the server</div>
        <p style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(215,220,235,0.7)', margin: '0 0 16px' }}>
          We couldn&apos;t verify your session. You&apos;re still signed in — check your
          connection and try again.
        </p>
        <button type="button" onClick={onRetry}
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(96,165,250,0.5)', background: 'rgba(59,130,246,0.18)', color: '#bfdbfe', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    </div>
  );
}

export default function AuthBootstrap({ children }) {
  // 'checking' (verifying a stored token) | 'ready' (render) | 'offline' (retry)
  const [phase, setPhase] = useState(() => (getSession() ? 'checking' : 'ready'));

  const verify = useCallback(async () => {
    const session = getSession();
    if (!session) { setPhase('ready'); return; } // AuthGuard handles /login
    setPhase('checking');
    try {
      const res = await api.getMe();
      const s = res?.session;
      if (s && s.userId) {
        // Refresh from server truth; the token only lives in the stored session
        // (the /auth/me payload doesn't echo it), so preserve it explicitly.
        setSession({ ...session, ...s, token: session.token });
        if (s.mustChangePassword) requirePasswordChange();
      }
      setPhase('ready');
    } catch (err) {
      // ONLY a definitive 401 means the token is invalid/expired → log out.
      if (err?.status === 401) {
        clearSession();
        setPhase('ready'); // now session-less → AuthGuard → /login
      } else {
        // Network error / timeout / 5xx → keep the session, offer a retry.
        setPhase('offline');
      }
    }
  }, []);

  useEffect(() => { verify(); }, [verify]);

  if (phase === 'checking') return <ScreenFallback />;
  if (phase === 'offline') return <BootOffline onRetry={verify} />;
  return children;
}
