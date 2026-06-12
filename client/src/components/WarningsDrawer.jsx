// Side panel listing import warnings and unmatched CRESTA zones.
//
// Opened from the warnings toast that fires after a renewal-pack
// import finishes with warnings.length > 0. Read-only — there's no
// "fix from here" affordance; the underwriter resolves the items in
// the relevant wizard pages (e.g. open CRESTA Aggregates to match
// zones manually).
//
// Closes on backdrop click or the X button. Esc-to-close is added
// via a keydown listener so keyboard users aren't trapped.

import { useEffect } from 'react';

export default function WarningsDrawer({ open, onClose, warnings = [], unmatchedCresta = [] }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const hasAnything = warnings.length || unmatchedCresta.length;

  return (
    <>
      <style>{`
        .wdr-backdrop {
          position: fixed; inset: 0; background: rgba(0,0,0,0.50);
          z-index: 1100;
        }
        .wdr-panel {
          position: fixed; top: 0; right: 0; bottom: 0;
          width: min(440px, 100%);
          background: linear-gradient(180deg, rgba(15,23,42,0.96), rgba(2,6,23,0.98));
          border-left: 1px solid rgba(var(--accent-rgb), 0.22);
          box-shadow: -20px 0 40px rgba(0,0,0,0.45);
          color: rgba(226,232,240,0.92);
          z-index: 1101;
          display: flex; flex-direction: column;
        }
        .wdr-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 16px 22px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .wdr-title {
          font-size: 13px; font-weight: 800; letter-spacing: .08em;
          text-transform: uppercase;
        }
        .wdr-close {
          background: none; border: none; color: rgba(255,255,255,0.55);
          font-size: 18px; cursor: pointer; padding: 4px 8px;
        }
        .wdr-close:hover { color: rgba(255,255,255,0.9); }
        .wdr-body { padding: 18px 22px; overflow-y: auto; flex: 1; }
        .wdr-section { margin-bottom: 22px; }
        .wdr-section h4 {
          font-size: 11px; font-weight: 800; letter-spacing: .12em;
          text-transform: uppercase; color: rgba(226,232,240,0.55);
          margin: 0 0 8px 0;
        }
        .wdr-list { list-style: none; padding: 0; margin: 0; display: flex;
                    flex-direction: column; gap: 8px; }
        .wdr-item {
          font-size: 12px; color: rgba(226,232,240,0.82);
          padding: 9px 12px; border-radius: 8px;
          background: rgba(250, 191, 36, 0.06);
          border: 1px solid rgba(250, 191, 36, 0.18);
          line-height: 1.5;
        }
        .wdr-item.cresta {
          background: rgba(248, 113, 113, 0.06);
          border-color: rgba(248, 113, 113, 0.22);
        }
        .wdr-empty {
          font-size: 12px; color: rgba(226,232,240,0.55);
          padding: 14px 0;
        }
      `}</style>
      {/* Backdrop dismissal is a pointer-only convenience; keyboard users
          close via the labelled ✕ button in the drawer header. */}
      <div className="wdr-backdrop" role="presentation" onClick={onClose} />
      <aside className="wdr-panel" role="dialog" aria-modal="true" aria-labelledby="wdr-title">
        <div className="wdr-head">
          <span className="wdr-title" id="wdr-title">Import warnings</span>
          <button className="wdr-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="wdr-body">
          {!hasAnything && <div className="wdr-empty">No warnings.</div>}

          {warnings.length > 0 && (
            <div className="wdr-section">
              <h4>Warnings ({warnings.length})</h4>
              <ul className="wdr-list">
                {warnings.map((w, i) => (
                  <li key={`w-${i}`} className="wdr-item">{w}</li>
                ))}
              </ul>
            </div>
          )}

          {unmatchedCresta.length > 0 && (
            <div className="wdr-section">
              <h4>Unmatched CRESTA zones ({unmatchedCresta.length})</h4>
              <ul className="wdr-list">
                {unmatchedCresta.map((z, i) => (
                  <li key={`c-${i}`} className="wdr-item cresta">
                    “{z}” — didn't match any zone in the reference table.
                    Resolve manually on the CRESTA Aggregates page.
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
