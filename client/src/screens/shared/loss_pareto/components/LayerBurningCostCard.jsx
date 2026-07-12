// loss_pareto/components/LayerBurningCostCard.jsx — empirical / model /
// blended layer ROL table with the weight presets and custom weight
// inputs. Moved verbatim from LossParetoScreen.jsx (Phase 4.2);
// setWEmp/setWModel became the onSetWeights callback (same clamping).
// Renders nothing when there are no blended rows — same guard as before.

import { fmt } from '../format.js';
import { DISTS } from '../math/distributions';

export default function LayerBurningCostCard({
  blendedLayerRols, structureLayers, uwYrs, activeDist, wEmp, wModel, onSetWeights,
}) {
  if (!(blendedLayerRols.length > 0)) return null;
  return (
    <div className="llp-card glass" style={{ marginTop: 14 }}>
      <div className="llp-card-head">
        <div>
          <div className="llp-card-title">Layer Burning Cost</div>
          <div className="llp-card-sub">
            Empirical = layerHit per loss ÷ {uwYrs} years &nbsp;·&nbsp;
            Model = {DISTS.find(d => d.key === activeDist)?.label} freq × E[loss in layer] &nbsp;·&nbsp;
            Blend = weighted average
          </div>
        </div>
      </div>

      {/* Weight controls */}
      <div style={{ padding: '10px 14px 4px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' }}>Method</span>

        {/* Presets */}
        {[
          { label: 'Empirical',  wE: 100, wM: 0   },
          { label: '50 / 50',   wE: 50,  wM: 50  },
          { label: 'Model',     wE: 0,   wM: 100 },
        ].map(p => {
          const active = wEmp === p.wE && wModel === p.wM;
          return (
            <button
              key={p.label}
              onClick={() => { onSetWeights({ wEmp: p.wE, wModel: p.wM }); }}
              style={{
                fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
                border: `1px solid ${active ? 'rgba(0,212,255,0.6)' : 'var(--hairline-strong)'}`,
                background: active ? 'rgba(0,212,255,0.12)' : 'transparent',
                color: active ? 'var(--accent-blue)' : 'var(--muted)',
              }}
            >
              {p.label}
            </button>
          );
        })}

        {/* Custom weight inputs */}
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>Custom:</span>
        {[
          { label: 'Empirical %', val: wEmp,   set: v => onSetWeights({ wEmp: Math.max(0, Math.min(100, Number(v) || 0)) })  },
          { label: 'Model %',     val: wModel, set: v => onSetWeights({ wModel: Math.max(0, Math.min(100, Number(v) || 0)) }) },
        ].map(({ label, val, set }) => (
          <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)' }}>
            {label}
            <input
              type="number" min="0" max="100" value={val}
              onChange={e => set(e.target.value)}
              style={{
                width: 54, textAlign: 'center', fontSize: 12, fontWeight: 700,
                background: 'var(--control-bg)', border: '1px solid var(--hairline-strong)',
                borderRadius: 6, color: 'var(--accent-blue)', padding: '3px 6px', outline: 'none',
              }}
            />
          </label>
        ))}

        {/* Weight total indicator */}
        {(wEmp + wModel) > 0 && (wEmp + wModel) !== 100 && (
          <span style={{ fontSize: 10, color: 'var(--accent-amber)', marginLeft: 4 }}>
            ⚠ Weights sum to {wEmp + wModel}% — blended ROL uses proportional share, not 100% total.
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="llp-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Layer</th>
              <th className="num">Deductible</th>
              <th className="num">Limit</th>
              <th className="num">RP at Attach.</th>
              <th className="num">Empirical ROL</th>
              <th className="num">Model ROL</th>
              <th className="num" style={{ color: 'var(--accent-blue)' }}>Blended ROL</th>
              <th className="num" style={{ color: 'var(--accent-blue)' }}>Annual Loss</th>
            </tr>
          </thead>
          <tbody>
            {blendedLayerRols.map(row => {
              const rpLabel = row.rp == null ? '—'
                : row.rp >= 10000 ? '>10,000y'
                : row.rp >= 100   ? `1-in-${Math.round(row.rp)}y`
                :                   `1-in-${row.rp.toFixed(1)}y`;
              const rpColor = row.rp == null ? 'var(--muted)'
                : row.rp >= 50 ? 'var(--accent-rose)' : row.rp >= 10 ? 'var(--accent-amber)' : 'var(--accent)';
              return (
                <tr key={row.idx}>
                  <td style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>{row.layer}</td>
                  <td className="num">{fmt(row.D)}</td>
                  <td className="num">{fmt(row.L)}</td>
                  <td className="num" style={{ color: rpColor, fontWeight: 600 }}>{rpLabel}</td>
                  <td className="num" style={{ color: 'rgba(var(--text-rgb),.7)' }}>
                    {row.empiricalRol > 0 ? (row.empiricalRol * 100).toFixed(3) + '%' : '—'}
                  </td>
                  <td className="num" style={{ color: '#a78bfa' }}>
                    {row.modelRol > 0 ? (row.modelRol * 100).toFixed(3) + '%' : '—'}
                    {row.error && <span style={{ fontSize: 10, color: 'var(--accent-amber)', marginLeft: 4 }}>⚠</span>}
                  </td>
                  <td className="num" style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>
                    {row.blendedRol > 0 ? (row.blendedRol * 100).toFixed(3) + '%' : '—'}
                  </td>
                  <td className="num" style={{ color: 'var(--accent)' }}>
                    {fmt(Math.round(row.blendedAnnual))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {structureLayers.length === 0 && (
        <div style={{ padding: '10px 14px', fontSize: 11, color: 'var(--accent-amber)' }}>
          No structure layers found for this peril type. Define layers in the Structure screen first.
        </div>
      )}
    </div>
  );
}
