function fmtPct(y) {
  return Number.isFinite(y) && y > 0 ? `${(y * 100).toFixed(2)}%` : '-';
}

export default function FQPricingCurve({ curve }) {
  const fit = curve?.fit || {};
  const expPts = curve?.expPts || [];
  const structPts = curve?.structPts || [];
  const allPts = curve?.allPts || [];
  const drawable = allPts.filter((p) => p.x > 0 && p.y > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));

  if (!drawable.length || !Number.isFinite(fit.a) || !Number.isFinite(fit.b)) {
    return (
      <div className="bm-curve-empty">
        Enter layer data to see the pricing curve
      </div>
    );
  }

  const W = 860;
  const H = 270;
  const pL = 56;
  const pR = 24;
  const pT = 22;
  const pB = 38;
  const xs = drawable.map((p) => p.x);
  const ys = drawable.map((p) => p.y);
  const xMin = Math.max(1e-6, Math.min(...xs) * 0.85);
  const xMax = Math.max(...xs) * 1.15;
  const yMin = Math.max(0, Math.min(...ys) * 0.85);
  const yMax = Math.max(...ys) * 1.15;
  const sx = (x) => pL + ((x - xMin) / (xMax - xMin || 1)) * (W - pL - pR);
  const sy = (y) => H - pB - ((y - yMin) / (yMax - yMin || 1)) * (H - pT - pB);

  const curveSamples = [];
  for (let i = 0; i <= 120; i += 1) {
    const x = xMin + (i / 120) * (xMax - xMin);
    const y = fit.a * Math.pow(x, fit.b);
    if (Number.isFinite(y) && y > 0) curveSamples.push({ x, y });
  }
  const pathD = curveSamples.length
    ? `M ${curveSamples.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' L ')}`
    : '';
  const yStep = (yMax - yMin) / 5;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="crisp-grid"
      style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}
      role="img"
      aria-label="Implied power pricing curve"
    >
      {Array.from({ length: 6 }, (_, i) => {
        const y = yMin + i * yStep;
        return (
          <g key={`gy${i}`}>
            <line
              x1={pL}
              x2={W - pR}
              y1={sy(y)}
              y2={sy(y)}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
              shapeRendering="crispEdges"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={pL - 6}
              y={sy(y) + 4}
              fontSize={10}
              fontWeight="500"
              fill="rgba(148,163,184,0.85)"
              textAnchor="end"
            >
              {fmtPct(y)}
            </text>
          </g>
        );
      })}
      {[0.25, 0.5, 0.75].map((t) => {
        const x = pL + t * (W - pL - pR);
        return (
          <line
            key={`gx${t}`}
            x1={x}
            y1={pT}
            x2={x}
            y2={H - pB}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
            shapeRendering="crispEdges"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      <line x1={pL} y1={pT} x2={pL} y2={H - pB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
      <line x1={pL} y1={H - pB} x2={W - pR} y2={H - pB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke="rgba(0,212,255,0.90)"
          strokeWidth={2.4}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <text x={W - pR} y={pT + 12} fontSize={10} fontWeight="600" fill="rgba(0,212,255,0.85)" textAnchor="end" style={{ fontFamily: 'var(--font-mono)' }}>
        ROL = {fit.a.toFixed(5)} * x^{fit.b.toFixed(3)}{fit.r2 != null ? `   R2 = ${fit.r2.toFixed(4)}` : ''}
      </text>
      <text x={pL + 10} y={H - 8} fontSize={10} fontWeight="500" fill="rgba(148,163,184,0.70)">
        x = sqrt((limit + attachment) * attachment) / EGNPI
      </text>
      <text x={10} y={pT + 5} fontSize={11} fontWeight="500" fill="rgba(148,163,184,0.70)">
        ROL
      </text>

      {expPts.map((p) => (
        <g key={`exp-${p.label}`}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={6.5} fill="rgba(167,139,250,0.82)" stroke="rgba(167,139,250,0.25)" strokeWidth={2} />
          <text x={sx(p.x) + 10} y={sy(p.y) + 4} fontSize={10} fill="rgba(167,139,250,0.92)" fontWeight={700}>{p.label}</text>
        </g>
      ))}

      {structPts.map((structure) => structure.map((p) => (
        <g key={`str-${p.label}`}>
          <circle cx={sx(p.x)} cy={sy(p.y)} r={6.5} fill={`${p.color}cc`} stroke={`${p.color}44`} strokeWidth={2} />
          <text x={sx(p.x) + 10} y={sy(p.y) + 4} fontSize={10} fill={p.color} fontWeight={700}>{p.label}</text>
        </g>
      )))}

      <circle cx={pL + 10} cy={pT + 7} r={5} fill="rgba(167,139,250,0.82)" />
      <text x={pL + 20} y={pT + 11} fontSize={10} fill="rgba(167,139,250,0.75)">Expiring</text>
      {structPts.map((structure, i) => {
        const first = structure[0];
        if (!first) return null;
        return (
          <g key={`legend-${i}`}>
            <circle cx={pL + 88 + i * 82} cy={pT + 7} r={5} fill={`${first.color}cc`} />
            <text x={pL + 98 + i * 82} y={pT + 11} fontSize={10} fill={`${first.color}bb`}>Str {i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}
