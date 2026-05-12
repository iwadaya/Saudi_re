// src/hooks/useScreenSave.js
// The wizard-screen save/load state machine that every Fac + NP + Prop
// screen was reimplementing by hand — 30-50 lines of boilerplate per
// file:
//
//   const loaded = useRef(false);
//   const dirty  = useRef(false);
//   useEffect(() => {
//     if (!id) return;
//     loaded.current = false;
//     api.getX(id).then(d => { setState(d); loaded.current = true; dirty.current = false; })
//       .catch(console.error);
//   }, [id]);
//   const save = useCallback(async () => {
//     if (!id || !loaded.current || !dirty.current) return true;
//     try { await api.saveX(id, state); dirty.current = false; return true; }
//     catch (e) { console.error(e); alert(...); return false; }
//   }, [id, state]);
//
// Consolidated here so:
//   • All screens get the same error-surfacing behaviour
//   • The "skip save if not dirty" optimisation is never forgotten
//   • Fixing a bug in the pattern fixes it everywhere

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @template T
 * @typedef {Object} UseScreenSaveOptions
 * @property {string} entityId        The ID the load/save API takes. '' = skip.
 * @property {(id: string) => Promise<T>} load   Fetch the persisted state.
 * @property {(id: string, state: T) => Promise<any>} save   Persist the state.
 * @property {(loaded: T) => void} [onLoaded]    Called once with the loaded state so
 *                                                the screen can hydrate its local state.
 * @property {string} [errorLabel]    Short label used in the alert when save fails.
 *                                     e.g. "Coverage structure" → "Coverage structure save failed".
 * @property {T} [initialState]       Optional; if provided, save() reads from here instead
 *                                     of a caller-supplied snapshot.
 */

/**
 * Wizard-screen state machine. Returns helpers and a `save` function
 * shaped exactly like WizardLayout.onBeforeNext expects
 * (async () => true | false). Callers only provide `load`, `save`, and
 * a way to extract the current state when save is called.
 *
 * @template T
 * @param {UseScreenSaveOptions<T> & {
 *   currentState: () => T
 * }} opts
 */
export function useScreenSave(opts) {
  const { entityId, load, save: saveImpl, currentState, onLoaded, errorLabel = 'Screen' } = opts;

  const loaded = useRef(false);
  const dirty  = useRef(false);
  const [loadError, setLoadError] = useState(null);

  // ── Load on mount / when entityId changes ────────────────────────
  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    loaded.current = false;
    setLoadError(null);
    (async () => {
      try {
        const data = await load(entityId);
        if (cancelled) return;
        if (onLoaded && data != null) onLoaded(data);
        loaded.current = true;
        dirty.current = false;
      } catch (err) {
        if (cancelled) return;
        console.error(`[${errorLabel}] load failed:`, err);
        setLoadError(err);
      }
    })();
    return () => { cancelled = true; };
  }, [entityId, errorLabel, load, onLoaded]);

  /** Call whenever the user edits a field. Cheap — just flips a ref. */
  const markDirty = useCallback(() => { dirty.current = true; }, []);

  /**
   * Wizard-compatible save. Returns true on success (or no-op),
   * false on failure. Alerts the user on failure so wizard navigation
   * blocks.
   */
  const save = useCallback(async () => {
    if (!entityId || !loaded.current || !dirty.current) return true;
    try {
      await saveImpl(entityId, currentState());
      dirty.current = false;
      return true;
    } catch (err) {
      console.error(`[${errorLabel}] save failed:`, err);
      if (typeof window !== 'undefined') {
        window.alert(`${errorLabel} save failed: ${err?.message || 'Server error'}`);
      }
      return false;
    }
  }, [entityId, saveImpl, currentState, errorLabel]);

  return {
    save,
    markDirty,
    loadedRef: loaded,
    dirtyRef: dirty,
    loadError,
  };
}

export default useScreenSave;
