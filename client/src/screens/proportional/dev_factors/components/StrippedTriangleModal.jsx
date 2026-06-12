// components/StrippedTriangleModal.jsx — full vs stripped (attritional)
// incurred comparison modal (Phase 4.2 decomposition of
// DevFactorsScreen.jsx). JSX moved VERBATIM, including the
// role="presentation" backdrop-dismiss pattern; grid contents pinned by
// goldenMaster.test.jsx.

/* Read-only cumulative triangle grid (years × dev months). */
export function TriangleGrid({ matrix, years, numDevYears }) {
  if (!matrix) return <div className="muted" style={{ padding: 12 }}>No triangle data.</div>;
  const cols = Array.from({ length: numDevYears }, (_, i) => (i + 1) * 12);
  const fmtCell = v => (v == null ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tri-table">
        <thead><tr><th className="tri-hdr" style={{ minWidth: 60 }}>Year</th>{cols.map(c => <th key={c} className="tri-hdr">{c}</th>)}</tr></thead>
        <tbody>
          {years.map((yr, r) => (
            <tr key={yr}>
              <td className="tri-yr">{yr}</td>
              {cols.map((c, ci) => {
                const v = matrix[r]?.[ci];
                return <td key={ci} className={v == null ? 'tri-off' : 'tri-cell'}>{v != null && <div className="tri-inp">{fmtCell(v)}</div>}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StrippedTriangleModal({ onClose, stripLargeCat, exclusions, fullMatrix, strippedMatrix, years, numDevYears }) {
  return (
    <div
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 120000, background: 'rgba(2,6,23,0.72)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div role="dialog" aria-modal="true" className="glass" style={{ width: 'min(1100px,97vw)', maxHeight: '88vh', overflow: 'auto', borderRadius: 16, border: '1px solid rgba(148,163,184,0.18)', background: 'rgba(8,16,40,0.97)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(148,163,184,0.14)' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.03em', color: '#e2e8f0' }}>Incurred Triangle — Stripped of Large/CAT</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>
              {stripLargeCat
                ? `Cumulative incurred (Paid + OS) with ${exclusions.largeLossCount} large and ${exclusions.catLossCount} CAT loss${(exclusions.largeLossCount + exclusions.catLossCount) === 1 ? '' : 'es'} removed — the attritional basis used for dev-factor selection.`
                : 'Stripping is OFF — development factors are calculated on the full triangle. The attritional view below shows what stripping would remove, for reference only.'}
            </div>
          </div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(148,163,184,0.25)', background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', color: '#fbbf24', marginBottom: 8 }}>FULL (ORIGINAL — BEFORE STRIPPING)</div>
          <TriangleGrid matrix={fullMatrix} years={years} numDevYears={numDevYears} />
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.04em', color: '#6ee7b7', margin: '20px 0 8px' }}>{stripLargeCat ? 'STRIPPED (ATTRITIONAL)' : 'ATTRITIONAL BASIS (reference — not active)'}</div>
          <TriangleGrid matrix={strippedMatrix} years={years} numDevYears={numDevYears} />
        </div>
      </div>
    </div>
  );
}
