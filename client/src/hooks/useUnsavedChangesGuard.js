// src/hooks/useUnsavedChangesGuard.js
// Native leave-warning for hard refresh / tab close while a form has
// unsaved edits. SPA navigation is unaffected — the treaty-detail
// screens autosave on unmount; this covers the paths where that
// effect never runs (F5, tab close, browser/OS crash-restart).
import { useEffect } from 'react';

export function useUnsavedChangesGuard(dirtyRef) {
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = ''; // Chrome requires returnValue to show the prompt
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyRef]);
}

export default useUnsavedChangesGuard;
