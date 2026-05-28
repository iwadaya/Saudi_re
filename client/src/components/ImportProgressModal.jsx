// Modal shown while a renewal-pack import job runs.
//
// The server kicks off async work and returns 202 + jobId; this modal
// holds the caller while the underlying job moves processing → done|failed.
// Stage labels cycle on a timer rather than from a streaming hook —
// there's no progress feed from the server, but the durations match
// the typical phases (parse → extract → cresta-match) so the underwriter
// has something to read besides a spinner.
//
// Closing the modal mid-job is allowed but the job continues server-side;
// the caller normally drives close() itself once polling reports a
// terminal state.

import { useEffect, useState } from 'react';

const PROGRESS_PHASES = [
  { key: 'parse',   label: 'Reading sheets',        minMs: 0 },
  { key: 'extract', label: 'Extracting fields',     minMs: 1_500 },
  { key: 'cresta',  label: 'Matching CRESTA zones', minMs: 6_000 },
];

export default function ImportProgressModal({ open, filename }) {
  const [phaseIdx, setPhaseIdx] = useState(0);

  useEffect(() => {
    if (!open) { setPhaseIdx(0); return undefined; }
    const started = Date.now();
    const t = setInterval(() => {
      const elapsed = Date.now() - started;
      let next = 0;
      for (let i = PROGRESS_PHASES.length - 1; i >= 0; i--) {
        if (elapsed >= PROGRESS_PHASES[i].minMs) { next = i; break; }
      }
      setPhaseIdx(next);
    }, 500);
    return () => clearInterval(t);
  }, [open]);

  if (!open) return null;
  const phase = PROGRESS_PHASES[phaseIdx];

  return (
    <>
      <style>{`
        .ipm-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.62);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000; padding: 24px;
        }
        .ipm-panel {
          width: min(440px, 100%);
          border-radius: 18px;
          border: 1px solid rgba(var(--accent-rgb), .18);
          background: linear-gradient(180deg, rgba(var(--accent-rgb), .08), rgba(10,18,32,.92));
          box-shadow: 0 30px 80px rgba(0,0,0,.45);
          color: rgba(226,232,240,0.92);
          padding: 22px;
        }
        .ipm-title { font-size: 13px; font-weight: 800; letter-spacing: 0;
                     text-transform: uppercase; color: var(--accent); margin-bottom: 8px; }
        .ipm-file  { font-size: 12px; color: rgba(226,232,240,0.60); margin-bottom: 14px;
                     overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ipm-phase-list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
        .ipm-phase { display: flex; align-items: center; gap: 8px;
                     font-size: 12px; color: rgba(226,232,240,0.45); }
        .ipm-phase.active { color: var(--accent); font-weight: 700; }
        .ipm-phase.done   { color: rgba(226,232,240,0.7); }
        .ipm-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: rgba(226,232,240,0.18);
        }
        .ipm-phase.active .ipm-dot {
          background: var(--accent);
          box-shadow: 0 0 6px var(--accent);
          animation: ipm-pulse 1.3s ease-in-out infinite;
        }
        .ipm-phase.done .ipm-dot { background: rgba(226,232,240,0.55); }
        @keyframes ipm-pulse {
          0%, 100% { opacity: .55; transform: scale(1); }
          50%      { opacity: 1;   transform: scale(1.18); }
        }
      `}</style>
      <div className="ipm-overlay">
        <div className="ipm-panel" role="dialog" aria-modal="true" aria-labelledby="ipm-title">
          <div className="ipm-title" id="ipm-title">Importing renewal pack…</div>
          {filename && <div className="ipm-file">📎 {filename}</div>}
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}>
            {phase.label}…
          </div>
          <div className="ipm-phase-list">
            {PROGRESS_PHASES.map((p, i) => {
              const cls = i < phaseIdx ? 'done' : i === phaseIdx ? 'active' : '';
              return (
                <div key={p.key} className={`ipm-phase ${cls}`.trim()}>
                  <span className="ipm-dot" />
                  <span>{p.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
