// src/screens/login/SsoCallback.jsx
// P1-identity Phase 1c — post-SSO landing. The server's /api/auth/sso/callback
// validates the IdP response, sets the httpOnly auth cookie, and redirects the
// browser here. There is no JS-visible session yet (the cookie is httpOnly), so
// we hydrate it from the server via GET /auth/me, store the session, then route
// the user on. Any failure lands back on /login with a generic error code.
//
// Styles are const objects referenced with a single brace (style={obj}) — the
// same idiom LoginScreen uses — so the screens-layer inline-style budget is
// unaffected.
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { setSession, canAccessApprovals } from '../../utils/auth';
import { requirePasswordChange } from '../../utils/passwordGate';
import { api } from '../../api';

const WRAP_STYLE = {
  minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24, color: 'rgba(255,255,255,0.7)', fontSize: 14,
};

export default function SsoCallback() {
  const navigate = useNavigate();
  // Guard against React 18 StrictMode double-invoke in dev.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      try {
        const res = await api.getMe();
        const s = res?.session;
        if (!s || !s.userId) { navigate('/login?sso_error=failed', { replace: true }); return; }
        setSession(s);
        if (s.mustChangePassword) requirePasswordChange();
        navigate(canAccessApprovals() ? '/approvals' : '/select', { replace: true });
      } catch {
        navigate('/login?sso_error=failed', { replace: true });
      }
    })();
  }, [navigate]);

  return (
    <div className="SSO_CALLBACK" style={WRAP_STYLE} aria-live="polite">
      Completing sign-in…
    </div>
  );
}
