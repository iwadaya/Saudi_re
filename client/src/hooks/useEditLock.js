// useEditLock — reports whether the current user may edit a treaty/quote, so
// the pricing editors can lock their UI. Reads are open; the server still
// enforces on write, so this fails OPEN (canEdit:true) on error and only locks
// when the server explicitly says canEdit:false.
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
      .catch(() => setState({ canEdit: true, isOwner: false, assignedToName: null, loading: false, loaded: true }));
  }, [id, fetchFn]);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, readOnly: state.loaded && state.canEdit === false, refresh };
}

export default useEditLock;
