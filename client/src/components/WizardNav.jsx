// src/components/WizardNav.jsx — Back/Next navigation dock
import { useState, useCallback, useEffect, useRef } from 'react';

// How long of an inactivity gap (ms) before the dock fades out. Picked
// to feel responsive: short enough that it gets out of the user's way
// when reading a table, long enough that casual pauses don't flicker.
const IDLE_MS = 2500;

export default function WizardNav({ onBack, onNext, hasPrev = true, hasNext = true, backLabel = null, nextLabel = null }) {
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const idleTimerRef = useRef(null);

  // Fade the dock out after IDLE_MS of no user activity; any scroll,
  // pointer move, keypress, or touch brings it back. CSS keeps it
  // visible on :hover and :focus-within so keyboard/mouse users can
  // still reach it mid-fade.
  useEffect(() => {
    function poke() {
      setHidden(false);
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setHidden(true), IDLE_MS);
    }
    const events = ['mousemove', 'keydown', 'touchstart', 'wheel', 'scroll'];
    for (const ev of events) window.addEventListener(ev, poke, { passive: true });
    poke(); // start the timer on mount
    return () => {
      clearTimeout(idleTimerRef.current);
      for (const ev of events) window.removeEventListener(ev, poke);
    };
  }, []);

  const handleBack = useCallback(async () => {
    if (busy || !hasPrev) return;
    setBusy(true);
    try {
      if (onBack) await onBack();
    } finally {
      setBusy(false);
    }
  }, [busy, hasPrev, onBack]);

  const handleNext = useCallback(async () => {
    if (busy || !hasNext) return;
    setBusy(true);
    try {
      if (onNext) await onNext();
    } finally {
      setBusy(false);
    }
  }, [busy, hasNext, onNext]);

  return (
    <nav
      className={`wizard-dock wizard-dock--autohide${hidden ? ' is-hidden' : ''}`}
      aria-label="Wizard navigation"
    >
      <button
        type="button"
        className="wizard-dock-btn wizard-dock-btn--back"
        onClick={handleBack}
        disabled={busy || !hasPrev}
        aria-label={backLabel ? `Go to previous step: ${backLabel}` : 'Go to previous step'}
        style={{ display: hasPrev ? '' : 'none' }}
      >
        <span aria-hidden="true">← </span>{backLabel ? `Back: ${backLabel}` : 'Back'}
      </button>
      <button
        type="button"
        className={`wizard-dock-btn wizard-dock-btn--next ${busy ? 'is-busy' : ''}`}
        onClick={handleNext}
        disabled={busy || !hasNext}
        aria-label={busy ? 'Saving and continuing' : (nextLabel ? `Go to next step: ${nextLabel}` : 'Go to next step')}
        aria-busy={busy}
        style={{ display: hasNext ? '' : 'none' }}
      >
        {nextLabel ? `Next: ${nextLabel}` : 'Next'}<span aria-hidden="true"> →</span>
      </button>
    </nav>
  );
}
