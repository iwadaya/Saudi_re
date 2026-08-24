// src/hooks/useTreatyHeaderUnmountAutosave.js
//
// The treaty-detail screens save their header when the component unmounts
// (SPA navigation away). Shared by PropTreatyDetail and NpTreatyDetail; the
// gates, in order:
//   • the AppContext autosave setting (user turned autosave off);
//   • read-only viewers never write (audit F10);
//   • a save that just ran explicitly isn't repeated;
//   • a brand-new treaty missing NOT NULL header columns can't be POSTed —
//     that skip and a failed save both surface via the app-root toast, which
//     survives the navigation (audit F4).
import { useEffect, useRef } from 'react';
import { logger } from '../utils/logger';

export function useTreatyHeaderUnmountAutosave({
  stateRef, saveRef, dirtyRef, lastExplicitSaveAtRef,
  readOnly, sliceKey, canPersist, showToast, logLabel,
}) {
  // Live mirror: the unmount cleanup must see the edit-lock verdict at
  // unmount time, not the value captured when the effect registered.
  const readOnlyRef = useRef(readOnly);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);

  /* eslint-disable react-hooks/exhaustive-deps -- reading the LIVE ref values
     inside the cleanup is this hook's whole point: the saves and gates must
     reflect state at unmount time, not values captured at registration. */
  useEffect(() => {
    return () => {
      const snap = stateRef.current || {};
      if (snap.settings?.autosave === false) return;
      if (readOnlyRef.current) return;
      const cur = snap[sliceKey];
      if (Date.now() - lastExplicitSaveAtRef.current < 2000) return;
      const persistable = cur?.contractId || canPersist(cur);
      if (!persistable) {
        if (dirtyRef.current) showToast('Treaty Detail not saved — complete Cedant, Broker, Currency, Country, Treaty Type and Inception Date, then press Next.', 6000);
        return;
      }
      if (saveRef.current) {
        // draft: true — never let the required-fields gate throw away a
        // partially-filled form on navigation (screens whose save() has no
        // draft mode simply ignore the option). save() resolves false for
        // ordinary failures (network/5xx — it swallows and logs internally)
        // and only REJECTS for re-thrown required-field errors, so both
        // shapes must reach the toast.
        saveRef.current({ draft: true }).then((ok) => {
          if (ok === false) showToast('Treaty Detail not saved — the save failed. Reopen the screen and try again.', 6000);
        }).catch(e => {
          logger.error(`[${logLabel}] unmount save failed:`, e);
          showToast(`Treaty Detail not saved — ${e?.message || 'save failed'}`, 6000);
        });
      }
    };
    // All inputs are refs or per-screen constants (slice key, helper fn, the
    // stable global toast), so this registers once and fires at unmount only.
  }, [stateRef, saveRef, dirtyRef, lastExplicitSaveAtRef, sliceKey, canPersist, showToast, logLabel]);
  /* eslint-enable react-hooks/exhaustive-deps */
}

export default useTreatyHeaderUnmountAutosave;
