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

import { useCallback, useEffect, useRef } from 'react';
import { useResource } from './useResource';

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
 * @property {ReadonlyArray<unknown>} [reloadDeps]  Extra values that should trigger a
 *                                     re-load when they change (entityId always does).
 * @property {T} [initialState]       Optional; if provided, save() reads from here instead
 *                                     of a caller-supplied snapshot.
 */

/**
 * Wizard-screen state machine. Returns helpers and a `save` function
 * shaped exactly like WizardLayout.onBeforeNext expects
 * (async () => true | false). Callers only provide `load`, `save`, and
 * a way to extract the current state when save is called.
 *
 * The load half is built on useResource (Phase 2), so every screen gets
 * the same abort-on-change/unmount semantics plus `loading` / `loadError`
 * / `refetch` to feed an <AsyncBoundary>.
 *
 * @template T
 * @param {UseScreenSaveOptions<T> & {
 *   currentState: () => T
 * }} opts
 */
export function useScreenSave(opts) {
  const { entityId, load, save: saveImpl, currentState, onLoaded, errorLabel = 'Screen', reloadDeps = [] } = opts;

  const loaded = useRef(false);
  const dirty  = useRef(false);

  // ── Load on mount / when entityId (or a reloadDep) changes ───────
  // Hydration happens inside the fetcher so the ordering matches the
  // old hand-rolled effect exactly: onLoaded → loaded=true → dirty=false,
  // all before `loading` flips off, and never for a superseded request.
  // The fetcher always sees the caller's LATEST load/onLoaded, but their
  // identities deliberately don't trigger re-fetches — an inline closure
  // must not cause a fetch-render loop.
  const resource = useResource(
    async (signal) => {
      loaded.current = false;
      const data = await load(entityId);
      if (signal.aborted) return data; // superseded/unmounted — don't hydrate
      if (onLoaded && data != null) onLoaded(data);
      loaded.current = true;
      dirty.current = false;
      return data;
    },
    [entityId, ...reloadDeps],
    { enabled: !!entityId, reportLabel: `${errorLabel} load` },
  );
  const loadError = resource.error;

  useEffect(() => {
    if (loadError) console.error(`[${errorLabel}] load failed:`, loadError);
  }, [loadError, errorLabel]);

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
    /** True while the persisted state is being (re)fetched. */
    loading: resource.loading,
    /** Re-run the load (e.g. after a stale-write refresh choice). */
    refetch: resource.refetch,
  };
}

export default useScreenSave;
