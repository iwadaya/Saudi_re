// src/components/Toast.jsx
// Toasts are announced to assistive tech via role=status + aria-live.
// The host stays in the DOM even when empty so screen readers don't
// have to re-discover it each time; that's what role=status expects.
//
// Toasts can be plain text (default) or actionable — when `onClick`
// is set, the toast renders as a button so keyboard users can fire
// the action with Enter/Space. The renewal-pack import uses this for
// the "Filled N pages with M warnings" toast that opens the warnings
// drawer on click.
//
// Memoized because the toast host re-renders on every parent re-render
// of WizardLayout (which is most keystrokes on NpFinalPricing). When
// `toasts` is the same array reference — which it usually is — we
// can skip the re-render entirely.
import { memo } from 'react';

function Toast({ toasts = [] }) {
  return (
    <div className="toast-host" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => {
        if (typeof t.onClick === 'function') {
          return (
            <button
              key={t.id}
              type="button"
              className="toast show toast--clickable"
              onClick={t.onClick}
            >
              {t.msg}
            </button>
          );
        }
        return <div key={t.id} className="toast show">{t.msg}</div>;
      })}
    </div>
  );
}

export default memo(Toast);
