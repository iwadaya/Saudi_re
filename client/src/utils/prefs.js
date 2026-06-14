// client/src/utils/prefs.js
// Per-user UI preferences in localStorage. Currently: viewAllTreaties — whether
// the home lists show everyone's treaties (read-only for non-owned rows) or just
// the current user's. This is a DISPLAY preference only; the server still
// enforces edit rights (canEdit / assertCanEdit) regardless of this flag.
import { useState, useEffect, useCallback } from 'react';
import { getSession } from './auth';

const PREFS_EVENT = 'prefs-changed';
const keyFor = (userId) => `prefs:viewAllTreaties:${userId || 'anon'}`;

function readBool(key) {
  try { return window.localStorage.getItem(key) === 'true'; } catch { return false; }
}

export function getViewAllTreaties(userId) {
  return readBool(keyFor(userId));
}

export function setViewAllTreaties(userId, val) {
  try { window.localStorage.setItem(keyFor(userId), val ? 'true' : 'false'); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { key: 'viewAllTreaties' } })); } catch { /* ignore */ }
}

/**
 * [viewAll, setViewAll] for the current session user. Re-renders all consumers
 * when the preference flips (via the 'prefs-changed' CustomEvent and cross-tab
 * 'storage' events). Default false (= "Mine").
 */
export function useViewAllTreaties() {
  const userId = getSession()?.userId || '';
  const [viewAll, setLocal] = useState(() => getViewAllTreaties(userId));

  useEffect(() => {
    const sync = () => setLocal(getViewAllTreaties(userId));
    const onPrefs = (e) => { if (!e?.detail || e.detail.key === 'viewAllTreaties') sync(); };
    window.addEventListener(PREFS_EVENT, onPrefs);
    window.addEventListener('storage', sync);
    sync(); // pick up a userId change
    return () => {
      window.removeEventListener(PREFS_EVENT, onPrefs);
      window.removeEventListener('storage', sync);
    };
  }, [userId]);

  const setViewAll = useCallback((val) => {
    setViewAllTreaties(userId, !!val);
    setLocal(!!val); // optimistic; the event syncs other consumers
  }, [userId]);

  return [viewAll, setViewAll];
}
