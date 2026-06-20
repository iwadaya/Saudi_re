// useEditLock — reports whether the current user may edit a treaty/quote, so
// the pricing editors can lock their UI. Reads are open; the server still
// enforces on write. This fails CLOSED (canEdit:false) on a permission-lookup
// ERROR: a failed/unauthorized check locks the editor rather than silently
// leaving it open, so a flaky or rejected lookup can't hand out edit access the
// server would refuse anyway. It unlocks only when the lookup succeeds and the
// server explicitly says canEdit is not false.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export function useEditLock({ contractId, quoteId, facRiskId, isQuote = false } = {}) {
  let id, fetchFn;
  if (facRiskId) { id = facRiskId; fetchFn = api.getFacEditPermission; }
  else if (isQuote) { id = quoteId; fetchFn = api.getQuoteEditPermission; }
  else { id = contractId; fetchFn = api.getEditPermission; }
  const [state, setState] = useState({ canEdit: true, isOwner: false, assignedToName: null, loading: false, loaded: false });

  const refresh = useCallback(() => {
    if (!id || typeof fetchFn !== 'function') return;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve(fetchFn(id))
      .then((p) => setState({
        canEdit: p?.canEdit !== false,
        isOwner: !!p?.isOwner,
        assignedToName: p?.assignedToName || null,
        loading: false,
        loaded: true,
      }))
      .catch(() => setState({ canEdit: false, isOwner: false, assignedToName: null, loading: false, loaded: true }));
  }, [id, fetchFn]);

  // Force the lock closed immediately. The editor calls this when a save comes
  // back 403 READ_ONLY (the permission lookup raced the first write, or failed
  // open): the verdict is authoritative, so flip the UI to read-only at once
  // rather than waiting for an async re-check. `loaded` is set true so the
  // derived `readOnly` below fires this render.
  const markReadOnly = useCallback((assignedToName) => {
    setState((s) => ({
      ...s,
      canEdit: false,
      assignedToName: assignedToName ?? s.assignedToName,
      loading: false,
      loaded: true,
    }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, readOnly: state.loaded && state.canEdit === false, refresh, markReadOnly };
}

export default useEditLock;
