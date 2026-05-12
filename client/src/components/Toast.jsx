// src/components/Toast.jsx
// Toasts are announced to assistive tech via role=status + aria-live.
// The host stays in the DOM even when empty so screen readers don't
// have to re-discover it each time; that's what role=status expects.
//
// Memoized because the toast host re-renders on every parent re-render
// of WizardLayout (which is most keystrokes on NpFinalPricing). When
// `toasts` is the same array reference — which it usually is — we
// can skip the re-render entirely.
import { memo } from 'react';

function Toast({ toasts = [] }) {
  return (
    <div className="toast-host" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className="toast show">{t.msg}</div>
      ))}
    </div>
  );
}

export default memo(Toast);
