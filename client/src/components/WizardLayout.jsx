// src/components/WizardLayout.jsx — Layout wrapper for wizard screens
import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import WizardTabs from './WizardTabs';
import WizardNav from './WizardNav';
import ThemeSwitcher from './ThemeSwitcher';
import useWizard from '../hooks/useWizard';
import Toast from './Toast';
import SaveStateIndicator from './SaveStateIndicator';
import { useToast } from '../hooks/useToast';
import { useAppState } from '../context/AppContext';
import { clearRole } from '../utils/auth';

/**
 * Tracks every wizard save (Back/Next click) and renders the shared
 * SaveStateIndicator banner. Screens pass their save function as
 * onBeforeBack / onBeforeNext; WizardLayout wraps the call so every
 * screen gets saving → saved / failed feedback without each of them
 * having to wire its own tracker.
 *
 * Save contract (unchanged):
 *   - Return true (or undefined) → navigation proceeds
 *   - Return false → navigation blocked, banner shows "Save failed"
 *   - Throw        → navigation blocked, banner shows thrown message
 *
 * Screens that render their own SaveStateIndicator (NpFinalPricing
 * does, via explicit workflow actions like Mark Signed that don't
 * flow through wizard nav) can opt out by passing
 * `suppressSaveIndicator` — prevents a double banner.
 */
export default function WizardLayout({
  routeKey, title, headerPill, children,
  onBeforeBack, onBeforeNext,
  suppressSaveIndicator = false,
}) {
  const wizard = useWizard(routeKey);
  const { toasts, show: showToast } = useToast();
  const navigate = useNavigate();
  // Autosave toggle is held in AppContext so it survives screen-to-screen
  // navigation (each WizardLayout instance is recreated when the route
  // changes) and is observable by other code paths — most importantly the
  // PropTreatyDetail unmount-save effect, which would otherwise persist
  // edits even after the user explicitly turned autosave off.
  const { state: appState, set: setApp } = useAppState();
  const autosave = appState.settings?.autosave !== false;
  const setAutosave = useCallback((next) => {
    const value = typeof next === 'function' ? next(autosave) : next;
    setApp({ settings: { ...(appState.settings || {}), autosave: !!value } });
  }, [appState.settings, autosave, setApp]);
  const [saveState, setSaveState] = useState({ status: 'idle', at: null, error: null });
  // Remember which handler produced the current saveState so the
  // SaveStateIndicator's Retry button replays the right direction
  // (back vs next). Both save the same data; the difference is only
  // where the user wanted to navigate.
  const lastHandlerRef = useRef(null);

  const runTrackedSave = useCallback(async (handler, direction) => {
    if (!autosave) return true;
    if (!handler) return true;
    setSaveState({ status: 'saving', at: null, error: null });
    lastHandlerRef.current = { handler, direction };
    try {
      const result = await handler();
      if (result === false) {
        setSaveState({ status: 'error', at: Date.now(), error: 'Save returned false' });
        return false;
      }
      setSaveState({ status: 'saved', at: Date.now(), error: null });
      return true;
    } catch (err) {
      setSaveState({ status: 'error', at: Date.now(), error: err?.message || 'Server error' });
      return false;
    }
  }, [autosave]);

  const handleBack = async () => {
    const ok = await runTrackedSave(onBeforeBack, 'back');
    if (ok) wizard.goPrev();
  };

  const handleNext = async () => {
    const ok = await runTrackedSave(onBeforeNext, 'next');
    if (ok) wizard.goNext();
  };

  const retrySave = useCallback(async () => {
    const last = lastHandlerRef.current;
    if (!last) return;
    const ok = await runTrackedSave(last.handler, last.direction);
    if (ok) {
      if (last.direction === 'back') wizard.goPrev();
      else                           wizard.goNext();
    }
  }, [runTrackedSave, wizard]);

  return (
    <div className="app-shell">
      {/* Skip link — first tabbable element, jumps keyboard users past
          the topbar and sidebar straight into the page content. */}
      <a href="#wizard-main" className="skip-link">Skip to main content</a>

      {/* ── Top Bar ── */}
      <header className="topbar glass" role="banner">
        <div className="topbar-left">
          <div className="logo-badge" aria-hidden="true">U</div>
          <div className="topbar-title">MODELLING TOOL</div>
        </div>
        <div className="topbar-right" role="toolbar" aria-label="Top bar actions">
          <button className="topbar-btn" type="button"
            aria-label="Refresh page"
            onClick={() => window.location.reload()}>
            <span aria-hidden="true">↻</span> <span>REFRESH</span>
          </button>
          <button className={`topbar-pill${autosave ? '' : ' is-off'}`} type="button"
            aria-pressed={autosave}
            aria-label={`Autosave ${autosave ? 'on — click to turn off' : 'off — click to turn on'}`}
            onClick={() => setAutosave(a => !a)}>
            <span aria-hidden="true">●</span> <span>AUTOSAVE:</span> <b>{autosave ? 'ON' : 'OFF'}</b>
          </button>
          <ThemeSwitcher compact />
          <button className="topbar-home" type="button"
            aria-label="Go to home screen"
            onClick={() => navigate(wizard.wizardMode === 'FAC' ? '/fac' : '/')}>
            <span aria-hidden="true">↑</span> HOME
          </button>
          <button className="topbar-home" type="button"
            aria-label="Log out"
            onClick={() => { clearRole(); navigate('/login'); }}>
            <span aria-hidden="true">⎋</span> LOG OUT
          </button>
        </div>
      </header>

      <div className="wizard-layout">
        <WizardTabs activeKey={routeKey} />
        <main id="wizard-main" className="wizard-content" role="main" aria-label={title || 'Wizard content'}>
          {headerPill && (
            <div className="wizard-header-pill" role="status" aria-live="polite">{headerPill}</div>
          )}
          {!suppressSaveIndicator && (
            <SaveStateIndicator saveState={saveState} onRetry={retrySave} />
          )}
          <div className="wizard-page-body">
            {typeof children === 'function' ? children({ showToast, wizard, saveState }) : children}
          </div>
          <WizardNav
            onBack={handleBack}
            onNext={handleNext}
            hasPrev={!!wizard.prev}
            hasNext={!!wizard.next}
          />
          {/* Toasts announced to screen readers via aria-live on the Toast host */}
          <Toast toasts={toasts} />
        </main>
      </div>
    </div>
  );
}
