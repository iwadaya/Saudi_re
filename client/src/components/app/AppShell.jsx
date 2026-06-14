// src/components/app/AppShell.jsx
import React, { Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { getSession, canAccessApprovals } from '../../utils/auth';
import { usePasswordChangeRequired } from '../../utils/passwordGate';
import { appRoutes } from '../../routes/appRoutes';
import ScreenErrorBoundary from '../ScreenErrorBoundary';
import ForcePasswordChange from './ForcePasswordChange';
import ScreenFallback from './ScreenFallback';
import { ToastProvider } from '../ToastProvider';

function AuthGuard({ children, requireApprovals = false }) {
  const session = getSession();
  if (!session) return <Navigate to="/login" replace />;
  if (requireApprovals && !canAccessApprovals()) return <Navigate to="/select" replace />;
  return children;
}

// Catches stale JS chunk errors after a new deploy and reloads once
class ChunkErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(err) {
    const isChunkError =
      err?.name === 'ChunkLoadError' ||
      (err?.message && (
        err.message.includes('Failed to fetch dynamically imported module') ||
        err.message.includes('Loading chunk') ||
        err.message.includes('Loading CSS chunk') ||
        err.message.includes('MIME type')
      ));
    return { hasError: true, isChunkError };
  }
  componentDidCatch(_err) {
    if (this.state.isChunkError) {
      // Only reload once — guard against infinite reload loop
      const reloaded = sessionStorage.getItem('chunk_reload');
      if (!reloaded) {
        sessionStorage.setItem('chunk_reload', '1');
        window.location.reload();
      }
    }
  }
  render() {
    if (this.state.hasError && !this.state.isChunkError) {
      return (
        <div style={{ padding: '2rem', color: '#f87171', fontFamily: 'var(--font-mono)' }}>
          Something went wrong. Please refresh the page.
        </div>
      );
    }
    return this.props.children;
  }
}

// Resets the per-screen error boundary whenever the route changes, so a failure
// on /np/final-pricing doesn't persist if the user navigates to /select.
function RoutedScreenBoundary({ children }) {
  const location = useLocation();
  return <ScreenErrorBoundary key={location.pathname}>{children}</ScreenErrorBoundary>;
}

// Reset scroll to the top of the page on every route change, so navigating
// from a scrolled-down screen doesn't land the user mid-page on the next one.
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

// Mandatory password-change overlay: rendered above everything whenever the
// forced-change gate is active (seeded must-change user, or any API 423
// PWD_CHANGE_REQUIRED). Non-dismissable — blocks the app until the reset lands.
function PasswordGateOverlay() {
  const required = usePasswordChangeRequired();
  return required ? <ForcePasswordChange /> : null;
}

export default function AppShell() {
  return (
    <AppProvider>
      <ScrollToTop />
      <ToastProvider>
        <PasswordGateOverlay />
        <ChunkErrorBoundary>
          <Suspense fallback={<ScreenFallback />}>
            <RoutedScreenBoundary>
              <Routes>
                {appRoutes.map(({ path, component: Component, public: isPublic, approvalsOnly }) => (
                  <Route
                    key={path}
                    path={path}
                    element={
                      isPublic
                        ? <Component />
                        : <AuthGuard requireApprovals={!!approvalsOnly}><Component /></AuthGuard>
                    }
                  />
                ))}
                <Route path="*" element={<Navigate to={getSession() ? '/select' : '/login'} replace />} />
              </Routes>
            </RoutedScreenBoundary>
          </Suspense>
        </ChunkErrorBoundary>
      </ToastProvider>
    </AppProvider>
  );
}
