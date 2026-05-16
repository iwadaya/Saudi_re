// Renewal-pack import modal.
//
// One drop zone, one POST to /api/quotes/import-renewal-pack, then route
// based on the response's match.mode. The LLM extraction takes 10–20s,
// so we cycle through staged "progress" labels client-side rather than
// leaving the user staring at a static spinner. The phases are
// purely cosmetic — there's no streaming hook yet — but ordered so the
// last visible label matches the actual longest step.
//
// Visual language: matches the dashboard's dark card / teal accent
// palette via the existing CSS tokens (--accent, --bg0/1, --radius).
// No new styles are added to global CSS; everything is scoped to a
// single <style> block keyed by the .rpi-* prefix.

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { setActiveContractId } from '../hooks/useContractId';

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

const PROGRESS_PHASES = [
  { key: 'parse',   label: 'Reading sheets',          minMs: 0 },
  { key: 'classify',label: 'Detecting treaty type',   minMs: 1_500 },
  { key: 'extract', label: 'Extracting fields',       minMs: 3_500 },
  { key: 'cresta',  label: 'Matching CRESTA zones',   minMs: 11_000 },
  { key: 'match',   label: 'Looking for prior treaty', minMs: 14_000 },
];

export default function ImportRenewalPackModal({ open, onClose }) {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [ambiguous, setAmbiguous] = useState(null); // { quoteId, candidates, type }

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setFile(null);
      setError('');
      setBusy(false);
      setPhaseIdx(0);
      setAmbiguous(null);
    }
  }, [open]);

  // Phase cycler — advance through progress labels until completion.
  useEffect(() => {
    if (!busy) return undefined;
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
  }, [busy]);

  const validateFile = useCallback((f) => {
    if (!f) return 'Choose a .xlsx file to import.';
    if (!/\.xlsx$/i.test(f.name)) return 'Only .xlsx files are supported.';
    if (f.type && !ALLOWED_MIME.has(f.type)) return `Unsupported MIME type "${f.type}".`;
    if (f.size > MAX_BYTES) return `File is ${(f.size / 1024 / 1024).toFixed(1)} MB — max is 25 MB.`;
    return '';
  }, []);

  const onPickFile = useCallback((f) => {
    setError('');
    const msg = validateFile(f);
    if (msg) {
      setError(msg);
      setFile(null);
      return;
    }
    setFile(f);
  }, [validateFile]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    onPickFile(e.dataTransfer.files?.[0]);
  }, [busy, onPickFile]);

  const handleImport = useCallback(async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setPhaseIdx(0);
    try {
      const res = await api.importRenewalPack(file);
      setBusy(false);
      // Route based on match mode.
      const mode = res?.match?.mode;
      if (mode === 'renewal') {
        // Drop user into the wizard with the imported draft as the
        // active "contract" (the wizard hydrates quotes the same way
        // it hydrates contracts via setActiveContractId).
        setActiveContractId(res.quoteId);
        const path = res.type === 'non_proportional' ? '/np/treaty-detail' : '/prop/treaty-detail';
        navigate(path, {
          state: {
            contractId: res.quoteId,
            importedFromPack: true,
            sourceFilename: file.name,
            priorTreatyId: res.match.priorTreatyId,
            priorQuoteId: res.match.priorQuoteId,
          },
        });
        onClose?.();
        return;
      }
      if (mode === 'ambiguous') {
        // Modal stays open; render candidates list.
        setAmbiguous({ quoteId: res.quoteId, candidates: res.match.candidates, type: res.type, filename: file.name });
        return;
      }
      // Default: mode === 'new' (or anything unexpected) → review screen.
      navigate(`/quotes/${res.quoteId}/review-import`, { state: { sourceFilename: file.name } });
      onClose?.();
    } catch (e) {
      setBusy(false);
      setError(e?.message || 'Import failed. Please try again.');
    }
  }, [file, busy, navigate, onClose]);

  const onPickCandidate = useCallback((candidate, asRenewal) => {
    // The draft is already created. For an "ambiguous → renewal" pick,
    // we route into the wizard with the draft as the active id and the
    // chosen prior treaty in nav state. The server-side parent_contract_id
    // link can be updated by a follow-up PUT — out of scope for this
    // modal; the wizard's next save covers it.
    if (!ambiguous) return;
    setActiveContractId(ambiguous.quoteId);
    if (asRenewal && candidate) {
      const path = ambiguous.type === 'non_proportional' ? '/np/treaty-detail' : '/prop/treaty-detail';
      navigate(path, {
        state: {
          contractId: ambiguous.quoteId,
          importedFromPack: true,
          sourceFilename: ambiguous.filename,
          priorTreatyId: candidate.id,
          priorQuoteId: candidate.priorQuoteId,
        },
      });
    } else {
      navigate(`/quotes/${ambiguous.quoteId}/review-import`, { state: { sourceFilename: ambiguous.filename } });
    }
    onClose?.();
  }, [ambiguous, navigate, onClose]);

  if (!open) return null;
  const phase = PROGRESS_PHASES[phaseIdx];

  return (
    <>
      <style>{`
        .rpi-overlay {
          position: fixed; inset: 0; background: rgba(0,0,0,0.62);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000; padding: 24px;
        }
        .rpi-panel {
          width: min(640px, 100%);
          border-radius: 18px;
          border: 1px solid rgba(var(--accent-rgb), .18);
          background: linear-gradient(180deg, rgba(var(--accent-rgb), .08), rgba(10,18,32,.92));
          box-shadow: 0 30px 80px rgba(0,0,0,.45);
          color: rgba(226,232,240,0.92);
          font-family: inherit;
          overflow: hidden;
        }
        .rpi-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 16px 22px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .rpi-title { font-size: 14px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
        .rpi-x {
          background: none; border: none; color: rgba(255,255,255,0.5);
          font-size: 18px; cursor: pointer; padding: 4px 8px;
        }
        .rpi-x:hover { color: rgba(255,255,255,0.85); }
        .rpi-body { padding: 22px; }
        .rpi-drop {
          border: 2px dashed rgba(255,255,255,0.14);
          border-radius: 14px;
          padding: 36px 20px;
          text-align: center;
          cursor: pointer;
          transition: border-color .15s, background .15s;
          background: rgba(255,255,255,0.02);
        }
        .rpi-drop.over, .rpi-drop:hover {
          border-color: rgba(var(--accent-rgb), 0.45);
          background: rgba(var(--accent-rgb), 0.04);
        }
        .rpi-drop.busy { cursor: default; opacity: .65; }
        .rpi-drop-icon { font-size: 30px; margin-bottom: 8px; }
        .rpi-drop-primary { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
        .rpi-drop-sub { font-size: 11px; color: rgba(226,232,240,0.45); }
        .rpi-filename {
          margin-top: 12px; display: inline-block;
          background: rgba(var(--accent-rgb), .12); color: var(--accent);
          padding: 4px 12px; border-radius: 20px; font-size: 12px;
        }
        .rpi-error {
          margin-top: 14px; padding: 9px 12px; border-radius: 8px;
          background: rgba(248, 113, 113, 0.10); border: 1px solid rgba(248,113,113,0.28);
          color: #fda4a4; font-size: 12px;
        }
        .rpi-actions {
          display: flex; gap: 10px; justify-content: flex-end;
          margin-top: 18px;
        }
        .rpi-btn {
          padding: 10px 18px; border-radius: 10px;
          font-family: inherit; font-size: 12px; font-weight: 700;
          letter-spacing: .08em; text-transform: uppercase;
          cursor: pointer; border: 1px solid transparent;
          transition: filter .15s, background .15s;
        }
        .rpi-btn--primary {
          background: var(--accent); color: #07120c;
        }
        .rpi-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
        .rpi-btn--primary:disabled { opacity: 0.4; cursor: default; }
        .rpi-btn--ghost {
          background: transparent; color: rgba(226,232,240,0.75);
          border-color: rgba(255,255,255,0.12);
        }
        .rpi-btn--ghost:hover { background: rgba(255,255,255,0.04); }
        .rpi-progress {
          margin-top: 20px; padding: 14px 16px;
          border-radius: 10px; border: 1px solid rgba(var(--accent-rgb),.18);
          background: rgba(var(--accent-rgb), .04);
        }
        .rpi-phase-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
        .rpi-phase {
          display: flex; align-items: center; gap: 8px;
          font-size: 11px; color: rgba(226,232,240,0.45);
        }
        .rpi-phase.active { color: var(--accent); font-weight: 700; }
        .rpi-phase.done { color: rgba(226,232,240,0.7); }
        .rpi-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: rgba(226,232,240,0.18);
        }
        .rpi-phase.active .rpi-dot {
          background: var(--accent);
          box-shadow: 0 0 6px var(--accent);
          animation: rpi-pulse 1.3s ease-in-out infinite;
        }
        .rpi-phase.done .rpi-dot { background: rgba(226,232,240,0.55); }
        @keyframes rpi-pulse {
          0%, 100% { opacity: .55; transform: scale(1); }
          50%      { opacity: 1;   transform: scale(1.18); }
        }
        .rpi-candidates {
          display: flex; flex-direction: column; gap: 10px;
          max-height: 320px; overflow-y: auto; padding-right: 4px;
        }
        .rpi-cand {
          border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
          padding: 12px 14px; background: rgba(255,255,255,0.025);
          display: flex; flex-direction: column; gap: 10px;
        }
        .rpi-cand-head {
          display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
        }
        .rpi-cand-name { font-size: 13px; font-weight: 700; color: #e2e8f0; }
        .rpi-cand-year {
          font-size: 10px; padding: 2px 8px; border-radius: 10px;
          background: rgba(var(--accent-rgb), .12); color: var(--accent);
          letter-spacing: .08em; text-transform: uppercase;
        }
        .rpi-cand-treaty { font-size: 11px; color: rgba(226,232,240,0.55); }
        .rpi-cand-actions { display: flex; gap: 8px; }
        .rpi-cand-actions .rpi-btn { padding: 6px 12px; font-size: 10px; }
      `}</style>

      <div className="rpi-overlay" onClick={(e) => { if (e.target.classList.contains('rpi-overlay') && !busy) onClose?.(); }}>
        <div className="rpi-panel" role="dialog" aria-modal="true" aria-labelledby="rpi-title">
          <div className="rpi-head">
            <span className="rpi-title" id="rpi-title">⬆ Import Renewal Pack</span>
            <button className="rpi-x" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
          </div>

          <div className="rpi-body">
            {ambiguous ? (
              <AmbiguousCandidates
                candidates={ambiguous.candidates}
                onPick={onPickCandidate}
              />
            ) : (
              <>
                <div
                  className={`rpi-drop${dragOver ? ' over' : ''}${busy ? ' busy' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); if (!busy) setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => !busy && fileRef.current?.click()}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".xlsx"
                    style={{ display: 'none' }}
                    onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <div className="rpi-drop-icon">📊</div>
                  <div className="rpi-drop-primary">
                    {file ? 'File ready to import' : 'Drop a .xlsx renewal pack here'}
                  </div>
                  <div className="rpi-drop-sub">or click to browse — max 25 MB</div>
                  {file && <div className="rpi-filename">📎 {file.name}</div>}
                </div>

                {error && <div className="rpi-error">{error}</div>}

                {busy && (
                  <div className="rpi-progress">
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)' }}>
                      {phase.label}…
                    </div>
                    <div className="rpi-phase-list">
                      {PROGRESS_PHASES.map((p, i) => {
                        const cls = i < phaseIdx ? 'done' : i === phaseIdx ? 'active' : '';
                        return (
                          <div key={p.key} className={`rpi-phase ${cls}`.trim()}>
                            <span className="rpi-dot" />
                            <span>{p.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="rpi-actions">
                  <button className="rpi-btn rpi-btn--ghost" onClick={onClose} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    className="rpi-btn rpi-btn--primary"
                    onClick={handleImport}
                    disabled={!file || busy}
                  >
                    {busy ? 'Importing…' : 'Import'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function AmbiguousCandidates({ candidates, onPick }) {
  return (
    <>
      <div style={{ fontSize: 12, color: 'rgba(226,232,240,0.7)', marginBottom: 12 }}>
        We found {candidates.length} possible existing treaty{candidates.length === 1 ? '' : 's'} for this cedant.
        Pick one to treat the import as a renewal, or start a new quote.
      </div>
      <div className="rpi-candidates">
        {candidates.map((c) => (
          <div key={c.id} className="rpi-cand">
            <div className="rpi-cand-head">
              <div>
                <div className="rpi-cand-name">{c.cedant}</div>
                <div className="rpi-cand-treaty">{c.treatyName || '—'}</div>
              </div>
              <span className="rpi-cand-year">UW {c.lastUwYear}</span>
            </div>
            <div className="rpi-cand-actions">
              <button className="rpi-btn rpi-btn--primary" onClick={() => onPick(c, true)}>
                Use as renewal
              </button>
              <button className="rpi-btn rpi-btn--ghost" onClick={() => onPick(c, false)}>
                Treat as new quote
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
