// components/ComparisonGraph.jsx — the benchmark comparison strip (Phase 4.2
// decomposition of DevFactorsScreen.jsx): actual vs parametrized vs
// country/region/all benchmark LDF curves on one SVG. JSX moved VERBATIM;
// the series legend and value axis are pinned by goldenMaster.test.jsx.
import { deriveLdfsFromCdfs } from '../../../../logic/chainLadder';

/* ═══════════════ Comparison Graph (SVG) ═══════════════ */
export default function ComparisonGraph({ pattern, paramCdfs, benchmarks }) {
  const N = pattern?.length || 0;
  if (!N) return <div className="muted" style={{ padding: 12 }}>No data for graph.</div>;
  const paramLdfs = deriveLdfsFromCdfs(paramCdfs || []);
  const devLabels = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);

  const series = [
    { name: 'Actual (Weighted)', data: pattern, color: '#22c55e' },
    { name: 'Parametrized', data: paramLdfs, color: '#3b82f6' },
    { name: 'Country Average', data: (benchmarks?.country || []).slice(0, N).map(b => b.ldf), color: '#f59e0b' },
    { name: 'Region Average', data: (benchmarks?.region || []).slice(0, N).map(b => b.ldf), color: '#a855f7' },
    { name: 'All Countries', data: (benchmarks?.all || []).slice(0, N).map(b => b.ldf), color: '#ef4444' },
  ].filter(s => s.data.some(v => v != null && v !== 0));

  const W = 1200, H = 640, PAD = { t: 40, r: 30, b: 50, l: 65 };
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
  const allVals = series.flatMap(s => s.data.filter(v => v != null));
  if (!allVals.length) return <div className="muted" style={{ padding: 12 }}>No data for graph.</div>;
  const minV = Math.min(...allVals) * 0.98, maxV = Math.max(...allVals) * 1.02;
  const range = maxV - minV || 0.01;
  const scaleX = i => PAD.l + (i / (N - 1 || 1)) * plotW;
  const scaleY = v => PAD.t + plotH - ((v - minV) / range) * plotH;
  const gridLines = 8;

  return (
    <div style={{ width: '100%' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.90)', marginBottom: 12 }}>Development Factor Comparison</div>
      <div style={{ width: '100%', aspectRatio: `${W} / ${H}`, minHeight: 400, maxHeight: 'calc(100vh - 260px)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ width: '100%', height: '100%', background: 'rgba(2,6,23,0.35)', borderRadius: 16, border: '1px solid rgba(255,255,255,0.08)', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
          {/* Grid lines */}
          {Array.from({ length: gridLines + 1 }, (_, i) => { const v = minV + (range * i) / gridLines; const y = scaleY(v); return (
            <g key={`g${i}`}>
              <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="rgba(255,255,255,0.06)" strokeDasharray={i === 0 || i === gridLines ? "0" : "4 4"} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
              <text x={PAD.l - 10} y={y + 4} textAnchor="end" fill="rgba(255,255,255,0.55)" fontSize={11} fontWeight={500}>{v.toFixed(3)}</text>
            </g>
          ); })}
          {/* Vertical grid + labels */}
          {devLabels.map((l, i) => (
            <g key={`x${i}`}>
              <line x1={scaleX(i)} y1={PAD.t} x2={scaleX(i)} y2={H - PAD.b} stroke="rgba(255,255,255,0.04)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
              <text x={scaleX(i)} y={H - 14} textAnchor="middle" fill="rgba(255,255,255,0.60)" fontSize={11} fontWeight={500}>{l}</text>
            </g>
          ))}
          {/* Lines */}
          {series.map(s => {
            const pts = s.data.map((v, i) => v != null ? `${scaleX(i)},${scaleY(v)}` : null).filter(Boolean);
            return pts.length >= 2 ? <polyline key={s.name} points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null;
          })}
          {/* Data points */}
          {series.map(s => s.data.map((v, i) => v != null ? (
            <g key={`${s.name}-${i}`}>
              <circle cx={scaleX(i)} cy={scaleY(v)} r={5} fill={s.color} opacity={0.2} />
              <circle cx={scaleX(i)} cy={scaleY(v)} r={3.5} fill={s.color} />
            </g>
          ) : null))}
        </svg>
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 14, padding: '10px 0' }}>
        {series.map(s => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
            <div style={{ width: 12, height: 12, borderRadius: 4, background: s.color, boxShadow: `0 0 8px ${s.color}40` }} />{s.name}
          </div>
        ))}
      </div>
    </div>
  );
}
