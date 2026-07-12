// Small confirmation dialog for the "Undo" link on a renewal-pack-imported
// document row. Plain text + two buttons; the actual restore call is
// driven by the parent so this stays presentational.

export default function RestoreImportConfirm({ open, onConfirm, onCancel, busy = false }) {
  if (!open) return null;
  return (
    <>
      <style>{`
        .ric-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.55);
          display: flex; align-items: center; justify-content: center;
          z-index: 1200; padding: 24px;
        }
        .ric-panel {
          width: min(420px, 100%);
          border-radius: 14px;
          border: 1px solid var(--stroke-soft);
          background: var(--panel-bg-strong);
          color: var(--text);
          padding: 22px 22px 18px;
          box-shadow: 0 24px 60px rgba(0,0,0,.45);
        }
        .ric-title { font-size: 13px; font-weight: 800; letter-spacing: .06em;
                     text-transform: uppercase; margin-bottom: 10px; }
        .ric-msg { font-size: 13px; line-height: 1.5;
                   color: rgba(var(--text-rgb),0.80); margin-bottom: 18px; }
        .ric-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .ric-btn {
          padding: 8px 16px; border-radius: 8px; cursor: pointer;
          font-family: inherit; font-size: 12px; font-weight: 700;
          letter-spacing: .04em; border: 1px solid transparent;
        }
        .ric-btn--ghost {
          background: transparent; color: rgba(var(--text-rgb),0.78);
          border-color: var(--stroke-soft);
        }
        .ric-btn--ghost:hover { background: var(--surface-hover); }
        .ric-btn--primary {
          background: rgba(248, 113, 113, 0.90); color: #1a0a0a;
        }
        .ric-btn--primary:hover:not(:disabled) { filter: brightness(1.06); }
        .ric-btn--primary:disabled { opacity: 0.5; cursor: default; }
      `}</style>
      {/* Backdrop dismissal is a pointer-only convenience; keyboard users
          cancel via the labelled Cancel button below. */}
      <div className="ric-overlay" role="presentation" onClick={(e) => { if (e.target.classList.contains('ric-overlay') && !busy) onCancel?.(); }}>
        <div className="ric-panel" role="dialog" aria-modal="true" aria-labelledby="ric-title">
          <div className="ric-title" id="ric-title">Restore previous state?</div>
          <div className="ric-msg">
            Restore the wizard pages to their state before this import?
            This will discard the imported data.
          </div>
          <div className="ric-actions">
            <button type="button" className="ric-btn ric-btn--ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="ric-btn ric-btn--primary" onClick={onConfirm} disabled={busy}>
              {busy ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
