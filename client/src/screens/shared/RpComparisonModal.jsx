// RpComparisonModal.jsx
// Side-by-side comparison of the fitted-distribution Return Period curve
// against an underwriter-entered third-party RP curve (e.g. Aon Catalyst,
// Karen Clark, Verisk). Underwriter picks which to use, or sets a blend
// weight. The chosen source replaces the displayed RP table on the
// CAT Pareto screen.
//
// Inputs (props):
//   - isOpen, onClose
//   - fittedRows: [{rp, loss}] computed from the active distribution
//   - tpRows: [{rp: string, loss: string}] underwriter-typed third-party input
//   - tpSource: free-text label ("Aon Catalyst 2026" etc.)
//   - rpSource: 'FITTED' | 'TP' | 'BLEND'
//   - rpBlend: 0-100 (% fitted in the blend)
//   - distLabel: distribution name shown in the fitted column header
//   - fmt: number formatter (passed in to match the parent's locale)
//   - onApply: ({tpRows, tpSource, rpSource, rpBlend}) => void
//
// Layout: three columns — Fitted (read-only) | Third-Party (editable)
// | Blend (computed). Bottom row: source picker + weight slider + Apply.

import { useEffect, useMemo, useState } from 'react';

// Log-RP interpolation: returns the interpolated TP loss at any RP.
// Exceedance probabilities are spaced log-linearly, so interpolate on
// log(rp) rather than rp itself.
export function interpolateTpAtRp(validTpRows, rp) {
  if (!validTpRows.length) return null;
  if (rp <= validTpRows[0].rp) return validTpRows[0].loss;
  if (rp >= validTpRows[validTpRows.length - 1].rp) return validTpRows[validTpRows.length - 1].loss;
  for (let i = 0; i < validTpRows.length - 1; i++) {
    const lo = validTpRows[i];
    const hi = validTpRows[i + 1];
    if (rp >= lo.rp && rp <= hi.rp) {
      const t = (Math.log(rp) - Math.log(lo.rp)) / (Math.log(hi.rp) - Math.log(lo.rp));
      return lo.loss + t * (hi.loss - lo.loss);
    }
  }
  return null;
}

function parseRows(rows) {
  return (rows || [])
    .map(r => ({
      rp: parseFloat(r.rp),
      loss: parseFloat(String(r.loss).replace(/,/g, '')),
    }))
    .filter(r => r.rp > 0 && r.loss > 0)
    .sort((a, b) => a.rp - b.rp);
}

export default function RpComparisonModal({
  isOpen, onClose,
  fittedRows = [],
  tpRows: initialTpRows = [],
  tpSource: initialTpSource = '',
  rpSource: initialRpSource = 'FITTED',
  rpBlend: initialRpBlend = 50,
  distLabel = '',
  fmt = (v) => String(Math.round(v || 0)),
  onApply,
}) {
  // Local drafts so Cancel discards. Sync from props each time the
  // modal opens to pick up parent-state edits.
  const [tpRows, setTpRows] = useState(initialTpRows);
  const [tpSource, setTpSource] = useState(initialTpSource);
  const [rpSource, setRpSource] = useState(initialRpSource);
  const [rpBlend, setRpBlend] = useState(initialRpBlend);

  useEffect(() => {
    if (!isOpen) return;
    setTpRows(initialTpRows.length ? initialTpRows
      : (fittedRows.length ? fittedRows.map(r => ({ rp: String(r.rp), loss: '' })) : []));
    setTpSource(initialTpSource);
    setRpSource(initialRpSource);
    setRpBlend(initialRpBlend);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const validTp = useMemo(() => parseRows(tpRows), [tpRows]);

  // Compute the interpolated TP and blended loss at every fitted RP.
  const compareRows = useMemo(() => {
    const w = Math.max(0, Math.min(100, rpBlend)) / 100;
    return fittedRows.map(p => {
      const tpLoss = interpolateTpAtRp(validTp, p.rp);
      const blendedLoss = tpLoss != null ? (w * p.loss + (1 - w) * tpLoss) : null;
      return {
        rp: p.rp,
        fitted: p.loss,
        tp: tpLoss,
        blend: blendedLoss,
        diffPct: tpLoss != null && p.loss > 0 ? (tpLoss - p.loss) / p.loss : null,
      };
    });
  }, [fittedRows, validTp, rpBlend]);

  const canSave = rpSource === 'FITTED' || validTp.length >= 2;

  if (!isOpen) return null;

  const apply = () => {
    if (!canSave) return;
    onApply?.({
      tpRows,
      tpSource: tpSource.trim(),
      rpSource,
      rpBlend: Number(rpBlend) || 0,
    });
    onClose();
  };

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
        aria-labelledby="rp-comparison-title"
        style={{
          width: 'min(1100px, 98vw)',
          maxHeight: '92vh', overflowY: 'auto',
          background: 'var(--surface-elevated)',
          border: '1px solid var(--hairline-strong)',
          borderRadius: 16, padding: 22, color: 'var(--text)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div id="rp-comparison-title" style={{
              fontSize: 14, fontWeight: 900, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text)',
            }}>
              Return Period Comparison
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Compare the fitted-distribution curve against a third-party CAT
              model (e.g. Aon Catalyst, Karen Clark, Verisk). Pick one or
              blend with a weighting.
            </div>
          </div>
          <button
            type="button" aria-label="Close" onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-subtle)', fontSize: 20, cursor: 'pointer' }}
          >✕</button>
        </div>

        {/* Third-party source label */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Third-party source
          </label>
          <input
            type="text" value={tpSource}
            onChange={(e) => setTpSource(e.target.value)}
            placeholder="e.g. Aon Catalyst 2026, Karen Clark RDS, Verisk Touchstone…"
            style={{
              flex: 1, maxWidth: 420, padding: '6px 10px', fontSize: 12,
              background: 'rgba(0,0,0,0.25)', border: '1px solid var(--hairline)',
              color: 'var(--text)', borderRadius: 6, outline: 'none',
            }}
          />
        </div>

        {/* Side-by-side comparison */}
        <div style={{
          border: '1px solid var(--hairline)', borderRadius: 10,
          overflow: 'hidden', marginBottom: 14,
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th style={th('left')}>Return Period</th>
                <th style={th('right')}>Fitted{distLabel ? ` — ${distLabel}` : ''}</th>
                <th style={th('right')}>Third-Party (editable)</th>
                <th style={th('right')}>Δ vs Fitted</th>
                <th style={th('right')}>Blend</th>
              </tr>
            </thead>
            <tbody>
              {compareRows.map((r, i) => (
                <tr key={r.rp} style={{ borderTop: '1px solid var(--hairline)' }}>
                  <td style={td('left')}>1 in {r.rp} yr</td>
                  <td style={td('right', 'mono')}>{fmt(r.fitted)}</td>
                  <td style={td('right')}>
                    <input
                      type="text"
                      value={tpRows[i]?.loss ?? ''}
                      onChange={(e) => setTpRows(prev => {
                        const next = [...prev];
                        // Pad with empty rows if needed to align with fittedRows
                        while (next.length <= i) next.push({ rp: String(fittedRows[next.length]?.rp ?? ''), loss: '' });
                        next[i] = { rp: String(r.rp), loss: e.target.value };
                        return next;
                      })}
                      placeholder="—"
                      style={{
                        width: 110, textAlign: 'right',
                        background: 'rgba(0,0,0,0.25)',
                        border: '1px solid var(--hairline)', color: 'var(--text)',
                        padding: '4px 8px', borderRadius: 6,
                        fontFamily: 'var(--font-mono)', fontSize: 12,
                      }}
                    />
                  </td>
                  <td style={{
                    ...td('right', 'mono'),
                    color: r.diffPct == null ? 'var(--muted)'
                      : Math.abs(r.diffPct) < 0.05 ? 'var(--muted)'
                      : r.diffPct > 0 ? 'var(--accent-amber)' : 'var(--accent-rose)',
                  }}>
                    {r.diffPct == null ? '—' : `${(r.diffPct * 100).toFixed(1)}%`}
                  </td>
                  <td style={{
                    ...td('right', 'mono'),
                    fontWeight: rpSource === 'BLEND' ? 800 : 500,
                    color: rpSource === 'BLEND' ? 'var(--accent)' : 'var(--text)',
                  }}>
                    {r.blend == null ? '—' : fmt(r.blend)}
                  </td>
                </tr>
              ))}
              {compareRows.length === 0 && (
                <tr><td colSpan={5} style={{ ...td('center'), color: 'var(--muted)', padding: 16 }}>
                  No fitted return periods yet — set the Pareto threshold (xm) on the screen first.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {!validTp.length && tpRows.some(r => r.loss) && (
          <div style={{
            fontSize: 11, color: 'var(--accent-amber)', marginBottom: 12,
          }}>
            Enter at least 2 valid (rp &gt; 0, loss &gt; 0) third-party points before applying.
          </div>
        )}

        {/* Source picker */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: '12px 14px', borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--hairline)',
          marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Use
          </div>
          {[
            { key: 'FITTED', label: 'Fitted only' },
            { key: 'TP',     label: 'Third-party only', disabled: !validTp.length },
            { key: 'BLEND',  label: 'Blend', disabled: !validTp.length },
          ].map(opt => {
            const active = rpSource === opt.key;
            return (
              <button
                key={opt.key} type="button"
                disabled={opt.disabled}
                onClick={() => setRpSource(opt.key)}
                style={{
                  padding: '6px 12px', borderRadius: 7, fontSize: 11, fontWeight: 700,
                  letterSpacing: '.04em', textTransform: 'uppercase',
                  border: '1px solid ' + (active ? 'var(--accent)' : 'var(--hairline)'),
                  background: active ? 'rgba(var(--accent-rgb), 0.15)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--muted)',
                  cursor: opt.disabled ? 'not-allowed' : 'pointer',
                  opacity: opt.disabled ? 0.4 : 1,
                }}
              >
                {opt.label}
              </button>
            );
          })}
          {rpSource === 'BLEND' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Fitted</span>
              <input
                type="range" min="0" max="100" step="5"
                value={rpBlend}
                onChange={(e) => setRpBlend(Number(e.target.value))}
                style={{ width: 180, accentColor: 'var(--accent)' }}
              />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Third-party</span>
              <span style={{
                fontSize: 12, fontWeight: 800, color: 'var(--accent)',
                fontFamily: 'var(--font-mono)', minWidth: 80, textAlign: 'right',
              }}>
                {rpBlend}% / {100 - rpBlend}%
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={onClose} style={secondaryBtn}>Discard</button>
          <button
            type="button" onClick={apply} disabled={!canSave}
            style={{ ...primaryBtn, opacity: canSave ? 1 : 0.5, cursor: canSave ? 'pointer' : 'not-allowed' }}
            title={canSave ? '' : 'Add ≥ 2 valid third-party points before applying'}
          >
            Apply &amp; Save
          </button>
        </div>
      </div>
    </div>
  );
}

const th = (align) => ({
  padding: '10px 12px', textAlign: align,
  fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase',
  color: 'var(--muted)',
  borderBottom: '1px solid var(--hairline)',
});
const td = (align, mono) => ({
  padding: '8px 12px', textAlign: align,
  fontSize: 12, color: 'var(--text)',
  fontFamily: mono === 'mono' ? 'var(--font-mono)' : undefined,
});
const primaryBtn = {
  background: 'var(--accent)', color: 'var(--accent-contrast)',
  border: 'none', padding: '8px 18px', borderRadius: 8,
  fontWeight: 800, fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase',
};
const secondaryBtn = {
  background: 'transparent', color: 'var(--muted)',
  border: '1px solid var(--hairline)', padding: '8px 18px', borderRadius: 8,
  fontWeight: 700, fontSize: 12, letterSpacing: '.06em', textTransform: 'uppercase',
  cursor: 'pointer',
};
