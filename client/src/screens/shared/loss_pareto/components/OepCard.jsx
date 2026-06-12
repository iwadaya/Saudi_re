// loss_pareto/components/OepCard.jsx — the collapsible "Cat Model OEP
// Burning Cost" card (cat screen only): vendor OEP curve input grid +
// numerically-integrated layer burning costs. Moved verbatim from
// LossParetoScreen.jsx (Phase 4.2); setShowOep/setOepRows became the
// onToggle/onSetOepRow callbacks.

import { fmt } from '../format.js';

export default function OepCard({ showOep, onToggle, oepRows, onSetOepRow, oepLayerRols, oepPts }) {
  return (
    <div className="llp-card glass" style={{ marginTop: 14 }}>
      <div
        className="llp-card-head"
        style={{ cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        aria-expanded={showOep}
        onClick={() => onToggle()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div>
          <div className="llp-card-title">
            Cat Model OEP Burning Cost {showOep ? '▲' : '▼'}
          </div>
          <div className="llp-card-sub">
            Enter OEP curve from cat model (RMS / AIR / Verisk). Layer burning cost = ∫[D, D+L] P(occ loss &gt; x) dx.
          </div>
        </div>
      </div>

      {showOep && (
        <div style={{ padding: '0 14px 14px', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

          {/* OEP input grid */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(148,163,184,0.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>
              OEP Curve Input
            </div>
            <table className="llp-table" style={{ width: 300 }}>
              <thead>
                <tr>
                  <th>Return Period (yrs)</th>
                  <th className="num">Ground-Up Loss</th>
                </tr>
              </thead>
              <tbody>
                {oepRows.map((row, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="text"
                        value={row.rp}
                        onChange={e => onSetOepRow(i, 'rp', e.target.value)}
                        style={{
                          width: '100%', textAlign: 'center', fontSize: 12,
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.10)',
                          borderRadius: 4, color: '#00d4ff', padding: '4px 6px', outline: 'none',
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        value={row.loss}
                        placeholder="0"
                        onChange={e => onSetOepRow(i, 'loss', e.target.value)}
                        style={{
                          width: '100%', textAlign: 'right', fontSize: 12,
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.10)',
                          borderRadius: 4, color: 'rgba(226,232,240,0.9)', padding: '4px 6px', outline: 'none',
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', marginTop: 6 }}>
              Minimum 2 rows with values. Piecewise linear interpolation between points.
            </div>
          </div>

          {/* OEP layer results */}
          {oepLayerRols.length > 0 && oepLayerRols.some(l => l.rol > 0) && (
            <div style={{ flex: 1, minWidth: 300 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(148,163,184,0.5)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                OEP Layer Burning Cost
              </div>
              <table className="llp-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Layer</th>
                    <th className="num">RP at Attach.</th>
                    <th className="num">Annual Loss</th>
                    <th className="num" style={{ color: '#f59e0b' }}>OEP ROL</th>
                  </tr>
                </thead>
                <tbody>
                  {oepLayerRols.map(row => {
                    const rpLabel = row.rp == null ? '—'
                      : row.rp >= 10000 ? '>10,000y'
                      : row.rp >= 100   ? `1-in-${Math.round(row.rp)}y`
                      :                   `1-in-${row.rp.toFixed(1)}y`;
                    return (
                      <tr key={row.idx}>
                        <td style={{ color: '#00d4ff', fontWeight: 700 }}>{row.layer}</td>
                        <td className="num" style={{ color: 'rgba(226,232,240,0.7)' }}>{rpLabel}</td>
                        <td className="num" style={{ color: '#4ade80' }}>{fmt(Math.round(row.annualLoss))}</td>
                        <td className="num" style={{ fontWeight: 700, color: '#f59e0b' }}>
                          {row.rol > 0 ? (row.rol * 100).toFixed(3) + '%' : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', marginTop: 6 }}>
                Integration: 500-step trapezoidal rule. OEP ROL is independent of the Pareto/distribution fit above.
              </div>
            </div>
          )}

          {oepPts.length < 2 && (
            <div style={{ fontSize: 11, color: 'rgba(251,191,36,0.65)', alignSelf: 'center' }}>
              Enter at least 2 loss values to compute layer costs.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
