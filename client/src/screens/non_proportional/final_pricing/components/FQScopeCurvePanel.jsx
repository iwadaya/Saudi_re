// components/FQScopeCurvePanel.jsx — shared four-curve power-law renderer
// (Structure / Country / Region / Global). Extracted from FQBenchmarkModal's
// Pricing Curve tab so the Rate Curve tab reuses the identical treatment: the
// multi-curve SVG, faded peer scatter, legend, equation/R² cards, and the
// "Curve Metrics Comparison" table. Only the x/y mapping (layerToXY/peerToXY),
// the labels (title/axisCaption/sourceLabel), and the metric reference points
// differ between tabs, so those arrive as props. fqFitPowerLaw is the only
// helper imported directly; the point mappers come in via props.
import { fqFitPowerLaw } from '../fqHelpers.js';

const thStyle = {
  padding: '8px 10px',
  fontSize: 9,
  fontWeight: 850,
  letterSpacing: '.11em',
  color: 'rgba(148,163,184,0.68)',
  textTransform: 'uppercase',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '7px 8px',
  verticalAlign: 'middle',
  fontVariantNumeric: 'tabular-nums',
};

/**
 * @param {{
 *   sourceLayers: Array<object>,
 *   peerPools: { country?: object[], region?: object[], global?: object[] },
 *   sourceLabel: string,
 *   sourceSeriesLabel?: string,  // name for the dominant source curve; defaults to sourceLabel
 *   layerToXY: (layer: object) => ({ x: number, y: number } | null),
 *   peerToXY: (peer: object) => ({ x: number, y: number } | null),
 *   title: string,
 *   axisCaption: string,
 *   refPoints: Array<{ x: number, label: string }>,
 * }} props
 */
export default function FQScopeCurvePanel({
  sourceLayers = [],
  peerPools = {},
  sourceLabel,
  sourceSeriesLabel = sourceLabel,
  layerToXY,
  peerToXY,
  title,
  axisCaption,
  refPoints = [],
}) {
  const scopePts = (sc) => (peerPools[sc] || []).map(peerToXY).filter(Boolean);

  // Curve fits — source structure + 3 market scopes
  const sourcePts  = (sourceLayers || []).map(layerToXY).filter(Boolean);
  const sourceFit  = fqFitPowerLaw(sourcePts);
  const countryPts = scopePts('country');
  const regionPts  = scopePts('region');
  const globalPts  = scopePts('global');
  const countryFit = fqFitPowerLaw(countryPts);
  const regionFit  = fqFitPowerLaw(regionPts);
  const globalFit  = fqFitPowerLaw(globalPts);
  const fits = [
    { key: 'source',  label: sourceSeriesLabel, color: '#f59e0b', fit: sourceFit, n: sourcePts.length, sample: 'layers' },
    { key: 'country', label: 'Country',  color: '#00d4ff', fit: countryFit, n: countryFit.n, sample: 'treaties' },
    { key: 'region',  label: 'Region',   color: '#a78bfa', fit: regionFit,  n: regionFit.n,  sample: 'treaties' },
    { key: 'global',  label: 'Global',   color: '#4ade80', fit: globalFit,  n: globalFit.n,  sample: 'treaties' },
  ];

  // x-range: cover the union of source pts + all peer pts so curves render comparably
  const allPts = [...sourcePts, ...countryPts, ...regionPts, ...globalPts];
  const xs = allPts.map((p) => p.x);
  const ys = allPts.map((p) => p.y);
  const xMin = Math.max(1e-6, Math.min(...xs));
  const xMax = Math.max(...xs);
  const yMin = 0;
  const rawYMax = Math.max(...ys, 0.5);
  const X = (v) => 8 + ((v - xMin) / (xMax - xMin || 1)) * 84;
  const Y2 = (v) => 66 - ((v - yMin) / (yMax - yMin || 1)) * 60;

  // Sample 50 points for each curve
  const sample = (a, b) => {
    if (!isFinite(a) || !isFinite(b) || a <= 0) return [];
    const out = [];
    for (let i = 0; i <= 50; i += 1) {
      const t = i / 50;
      const x = xMin + (xMax - xMin) * t;
      const y = a * Math.pow(x, b);
      if (y > 0 && y <= rawYMax * 3) out.push({ x, y });
    }
    return out;
  };
  const sampledCurves = new Map(fits.map((f) => [f.key, sample(f.fit.a, f.fit.b)]));
  const sampledYs = Array.from(sampledCurves.values()).flat().map((p) => p.y);
  const yMax = Math.max(rawYMax, ...sampledYs) * 1.12;
  const fmtCoef = (v) => (isFinite(v) ? (Math.abs(v) >= 0.01 ? v.toFixed(4) : v.toExponential(2)) : '—');
  const fmtR2   = (v) => (v == null ? '—' : v.toFixed(3));
  const eqStr   = (a, b) => `y = ${fmtCoef(a)} · x^${b >= 0 ? b.toFixed(3) : b.toFixed(3)}`;

  const peerSeries = [
    { key: 'country', pts: countryPts, fill: '#00d4ff', opacity: 0.40 },
    { key: 'region',  pts: regionPts,  fill: '#a78bfa', opacity: 0.35 },
    { key: 'global',  pts: globalPts,  fill: '#4ade80', opacity: 0.30 },
  ];

  const metricRows = [
    { k: 'a',   label: 'a coefficient', cell: (f) => fmtCoef(f.fit.a) },
    { k: 'b',   label: 'b exponent',    cell: (f) => fmtCoef(f.fit.b) },
    { k: 'r2',  label: 'R²',            cell: (f) => fmtR2(f.fit.r2) },
    { k: 'n',   label: 'Sample size',   cell: (f) => `${f.n} ${f.sample}` },
    { k: 'cal', label: 'Calibrated',    cell: (f) => (f.fit.calibrated ? '✓' : '— (market default)') },
    ...refPoints.map((rp) => ({
      k: `rol-${rp.label}`,
      label: `ROL @ ${rp.label}`,
      cell: (f) => `${(f.fit.a * Math.pow(rp.x, f.fit.b) * 100).toFixed(2)}%`,
    })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Multi-curve SVG */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.75)' }}>{title}</span>
          <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>{axisCaption}</span>
        </div>
        <svg viewBox="0 0 100 72" style={{ width: '100%', height: 'min(52vh, 460px)', minHeight: 380, display: 'block', background: 'rgba(0,0,0,0.20)', borderRadius: 8 }} preserveAspectRatio="none">
          {[12, 24, 36, 48, 60].map((g) => (<line key={`gy${g}`} x1={6} y1={g} x2={98} y2={g} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />))}
          {[20, 40, 60, 80].map((g) => (<line key={`gx${g}`} x1={g} y1={6} x2={g} y2={66} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />))}
          {/* Faded peer scatter dots, painted country → region → global */}
          {peerSeries.flatMap((s) => s.pts.map((p, i) => (
            <circle key={`${s.key}${i}`} cx={X(p.x)} cy={Y2(p.y)} r="0.5" fill={s.fill} fillOpacity={s.opacity} />
          )))}
          {fits.map((f) => {
            const pts = sampledCurves.get(f.key) || [];
            const d = pts.length ? `M ${pts.map((p) => `${X(p.x).toFixed(2)} ${Y2(p.y).toFixed(2)}`).join(' L ')}` : '';
            return (
              <path key={f.key} d={d} stroke={f.color} strokeWidth={f.key === 'source' ? '2.4' : '1.6'} strokeDasharray={f.key === 'source' ? '0' : '4 3'} strokeLinejoin="round" strokeLinecap="round" fill="none" strokeOpacity={f.key === 'source' ? 1 : 0.85} vectorEffect="non-scaling-stroke" />
            );
          })}
          {sourcePts.map((p, i) => (
            <polygon key={`sp${i}`} points={`${X(p.x)},${Y2(p.y) - 1} ${X(p.x) + 0.9},${Y2(p.y)} ${X(p.x)},${Y2(p.y) + 1} ${X(p.x) - 0.9},${Y2(p.y)}`} fill="#fbbf24" stroke="#f59e0b" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {/* Legend */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 10 }}>
          {fits.map((f) => (
            <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 16, height: 2, background: f.color, opacity: f.key === 'source' ? 1 : 0.75, borderRadius: 1 }} />
              <b style={{ color: f.color, letterSpacing: '.04em' }}>{f.label}</b>
              <span style={{ color: 'rgba(148,163,184,0.55)' }}>· {f.n} {f.sample}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Equations + R² */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {fits.map((f) => (
          <div key={f.key} style={{ background: 'rgba(8,14,30,0.70)', border: `1px solid ${f.color}33`, borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', color: f.color, textTransform: 'uppercase', marginBottom: 4 }}>{f.label}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(226,232,240,0.92)', fontFamily: 'var(--font-mono)' }}>{eqStr(f.fit.a, f.fit.b)}</div>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.65)', marginTop: 4 }}>
              R² <b style={{ color: 'rgba(226,232,240,0.85)' }}>{fmtR2(f.fit.r2)}</b>
              {!f.fit.calibrated && <span style={{ marginLeft: 8, color: '#f87171' }}>· market default</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Metrics comparison table */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', marginBottom: 6 }}>
          Curve Metrics Comparison
        </div>
        <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead style={{ background: 'rgba(5,8,16,0.95)' }}>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left' }}>Metric</th>
                {fits.map((f) => (
                  <th key={f.key} style={{ ...thStyle, textAlign: 'right', color: f.color }}>{f.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metricRows.map((row) => (
                <tr key={row.k} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ ...tdStyle, textAlign: 'left', color: 'rgba(226,232,240,0.85)' }}>{row.label}</td>
                  {fits.map((f) => (
                    <td key={f.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)', color: f.key === 'source' ? f.color : 'rgba(226,232,240,0.85)' }}>{row.cell(f)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 6 }}>
          ROL @ rows show what each fitted curve predicts at the listed reference points. Useful for at-a-glance comparison across scopes.
        </div>
      </div>
    </div>
  );
}
