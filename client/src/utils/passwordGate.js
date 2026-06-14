// Client-side forced-password-change gate.
//
// A user is "must change" when either:
//   • their session carries mustChangePassword: true (seeded forced-change user,
//     set by /auth/login), or
//   • an API call came back 423 PWD_CHANGE_REQUIRED (the server's hard gate —
//     covers a stale session whose token still has the flag).
//
// AppShell renders a non-dismissable "Set your password" modal whenever this is
// active. A tiny pub/sub lets the api layer (non-React) flip it on a 423, and
// the login screen flip it right after setSession, without prop-drilling.
import { useEffect, useState } from 'react';
import { getSession } from './auth';

const store = { required: false, listeners: new Set() };
const emit = () => { for (const fn of store.listeners) fn(); };

/** Force the gate on (e.g. on a 423, or right after a forced-change login). */
export function requirePasswordChange() {
  if (!store.required) { store.required = true; emit(); }
}

/** Clear the gate after a successful change. */
export function clearPasswordChange() {
  if (store.required) { store.required = false; emit(); }
}

/** True if the gate is active from either the store flag or the session flag. */
export function isPasswordChangeRequired() {
  return store.required || !!getSession()?.mustChangePassword;
}

/** React hook: re-renders when the gate flips (store) or on mount (session). */
export function usePasswordChangeRequired() {
  const [required, setRequired] = useState(isPasswordChangeRequired);
  useEffect(() => {
    const fn = () => setRequired(isPasswordChangeRequired());
    store.listeners.add(fn);
    fn(); // resync on mount — a forced-change login may have set the session first
    return () => { store.listeners.delete(fn); };
  }, []);
  return required;
}
