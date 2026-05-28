// The banner that tells the underwriter whether their last save
// actually reached the server. Silent failures previously left users
// believing data was persisted when it wasn't — this is a thin but
// critical piece of the UX.
//
// Three states, each a different live-region politeness:
//   • saving  — role=status + aria-live=polite
//   • saved   — role=status + aria-live=polite (includes timestamp)
//   • error   — role=alert (announced immediately) with a Retry button

import { useState, useEffect } from 'react';
import { formatTime } from '../utils/format';

/**
 * @typedef {{
 *   status: 'idle' | 'saving' | 'saved' | 'error',
 *   at: number | null,
 *   error: string | null,
 * }} SaveState
 */

// How long an error banner stays visible before auto-collapsing to a
// small non-blocking chip. Long enough for a glance, short enough
// that the user doesn't forget about it 10 minutes later.
const ERROR_AUTO_COLLAPSE_MS = 8000;
// Success banners collapse faster — success is ambient feedback.
const SAVED_AUTO_COLLAPSE_MS = 3500;

/**
 * @param {{
 *   saveState: SaveState,
 *   onRetry: () => void,
 * }} props
 */
export default function SaveStateIndicator({ saveState, onRetry }) {
  const [dismissed, setDismissed] = useState(false);

  // Reset the dismiss flag whenever a new save cycle starts (saving /
  // new timestamp / status change) so each cycle gets its own chance
  // to be visible.
  useEffect(() => {
    setDismissed(false);
  }, [saveState?.status, saveState?.at]);

  // Auto-dismiss on a timer. Error collapses to "Save failed — retry"
  // chip; saved collapses entirely.
  useEffect(() => {
    if (!saveState) return undefined;
    if (saveState.status === 'error') {
      const id = setTimeout(() => setDismissed(true), ERROR_AUTO_COLLAPSE_MS);
      return () => clearTimeout(id);
    }
    if (saveState.status === 'saved') {
      const id = setTimeout(() => setDismissed(true), SAVED_AUTO_COLLAPSE_MS);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [saveState.status, saveState.at, saveState]);

  if (!saveState || saveState.status === 'idle') return null;

  const base = {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 14px', margin: '0 0 12px',
    borderRadius: 6, fontSize: 13, fontFamily: 'var(--font-sans)',
    border: '1px solid transparent',
  };

  if (saveState.status === 'saving') {
    return (
      <div role="status" aria-live="polite"
        style={{ ...base, background: '#1e293b', color: '#cbd5e1', borderColor: '#334155' }}>
        <span aria-hidden="true">● </span>Saving…
      </div>
    );
  }

  if (saveState.status === 'saved') {
    if (dismissed) return null;
    const t = formatTime(saveState.at);
    return (
      <div role="status" aria-live="polite"
        style={{ ...base, background: '#062e1d', color: '#86efac', borderColor: '#14532d' }}>
        <span aria-hidden="true">✓ </span>Saved at {t}
      </div>
    );
  }

  // error — dismissed state collapses to a persistent chip that still
  // surfaces the failure + retry, but doesn't hog the banner real estate.
  if (dismissed) {
    return (
      <button
        type="button"
        onClick={onRetry}
        aria-label="Retry save — last save failed"
        style={{
          ...base,
          display: 'inline-flex', margin: '0 0 8px',
          background: '#1f0707', color: '#fca5a5', borderColor: '#7f1d1d',
          fontSize: 11, padding: '4px 10px', cursor: 'pointer',
        }}
      >
        <span aria-hidden="true">⚠ </span>Save failed · Retry
      </button>
    );
  }

  // full banner — alert role announces immediately
  return (
    <div role="alert"
      style={{ ...base, background: '#3f0a0a', color: '#fca5a5', borderColor: '#7f1d1d' }}>
      <span><span aria-hidden="true">⚠ </span>Save failed: {saveState.error || 'unknown error'}</span>
      <button
        type="button"
        onClick={onRetry}
        aria-label="Retry save"
        style={{
          marginLeft: 'auto',
          background: '#7f1d1d', color: '#fff',
          border: 'none', padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
        }}>
        Retry save
      </button>
    </div>
  );
}
