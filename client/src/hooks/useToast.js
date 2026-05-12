// src/hooks/useToast.js
//
// Two exports:
//   useToast()       legacy local-state hook kept for back-compat
//                    (WizardLayout's own <Toast/> host still uses it).
//   useGlobalToast() reads from <ToastProvider/>; works in any screen,
//                    whether or not it is a child of WizardLayout.
//
// The global flavour exists so the 10 "shell-less" screens (dev
// factors, profile, claims profile, …) can emit the same toast UX
// as the wizard-nested screens without each of them mounting its
// own <Toast/> host.

import { useState, useCallback, useContext } from 'react';
import { ToastContext } from '../components/ToastProvider';

export function useToast() {
  const [toasts, setToasts] = useState([]);

  const show = useCallback((msg, duration = 2200) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);

  return { toasts, show };
}

// Stable no-op fallback used when a component calls useGlobalToast()
// outside a ToastProvider (e.g. unit tests). Module-scoped so every
// caller gets the SAME function reference — if we returned a fresh
// `() => {}` each render, downstream useEffect deps that include the
// toast function would re-run on every render of those callers.
const NOOP_TOAST = () => {};

/**
 * Dispatches to the app-wide <ToastProvider/>. Safe to call outside a
 * provider — falls back to a stable no-op so unit tests that don't
 * mount the provider don't crash and don't thrash dep arrays.
 *
 * @returns {(msg: string, duration?: number) => void}
 */
export function useGlobalToast() {
  const ctx = useContext(ToastContext);
  return ctx?.show || NOOP_TOAST;
}

export default useToast;
