// WordingAnalysisModal.jsx
// Modal wrapper for slip wording analysis. Opens when `doc` is non-null
// and re-uses WordingChecker's analysis logic but scopes it to the slip
// the user clicked Analyze on (passed through as targetDoc). The modal
// auto-runs on mount so the analysis is in flight as soon as the user
// opens it — no second click to "Run". Escape and backdrop click close.

import { useEffect } from 'react';
import WordingChecker from './WordingChecker';

export default function WordingAnalysisModal({ contractId, parentContractId, docs, doc, onClose, quoteMode = false }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!doc) return null;
  const docTitle = doc.title || doc.file_name || 'Slip';

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wording-analysis-title"
        style={{
          width: 'min(920px, 96vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          background: 'var(--surface-elevated)',
          border: '1px solid var(--hairline-strong)',
          borderRadius: 16,
          padding: 22,
          color: 'var(--text)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div id="wording-analysis-title" style={{ fontSize: 14, fontWeight: 900, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text)' }}>
              Wording Analysis
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{doc.doc_type} — {docTitle}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: 'var(--text-subtle)',
              fontSize: 20, cursor: 'pointer',
            }}
          >✕</button>
        </div>

        <WordingChecker
          contractId={contractId}
          parentContractId={parentContractId}
          docs={docs}
          targetDoc={doc}
          quoteMode={quoteMode}
          autoRun={true}
        />
      </div>
    </div>
  );
}
