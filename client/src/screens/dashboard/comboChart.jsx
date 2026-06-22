// client/src/screens/dashboard/comboChart.jsx
// A small dependency-free SVG combo chart for the dashboard's technical-analysis
// tab: premium bars on the left axis + a UW-margin line on the right axis (dots
// coloured green/red by sign). Ported from the Strata reference's comboChartSvg
// and re-themed for the app's dark dashboard. Pure render — no state, no deps.
import { fmtMoney } from '../../utils/format';

const PROFIT = '#00ff99';
const LOSS = '#ff6b6b';
const PREMIUM = '#39b7ff';
const GRID = 'rgba(255,255,255,.10)';
const ZERO = 'rgba(255,255,255,.28)';
const AXIS_TXT = 'rgba(255,255,255,.45)';

// data: [{ label, premium, margin }]  (margin is a fraction, e.g. 0.12 = 12%)
export default function ComboChart({ data = [], premiumFmt = fmtMoney }) {
  const W = 720, H = 250, padL = 56, padR = 54, padT = 18;
  const n = data.length;
  if (!n) return <div className="muted" style={{ padding: 18 }}>No data.</div>;

  const rotate = data.some(d => String(d.label).length > 5) || n > 8;
  const padB = rotate ? 64 : 38;
  const innerH = H - padT - padB, innerW = W - padL - padR, gap = innerW / n;
  const cx = i => padL + gap * i + gap / 2;

  const maxP = Math.max(1e-6, ...data.map(d => d.premium).filter(v => v != null && isFinite(v)));
  const mVals = data.map(d => d.margin).filter(v => v != null && isFinite(v));
  const minM = Math.min(0, ...mVals);
  let maxM = Math.max(0.01, ...mVals);
  if (maxM === minM) maxM = minM + 0.01;

  const yP = v => padT + innerH * (1 - v / maxP);
  const yM = v => padT + innerH * (1 - (v - minM) / (maxM - minM));
  const pBase = padT + innerH, mBase = yM(0);
  const bw = Math.min(40, gap * 0.5);

  const bars = data.map((d, i) => {
    if (d.premium == null) return null;
    const y = Math.min(pBase, yP(d.premium)), h = Math.abs(pBase - yP(d.premium));
    return <rect key={i} x={(cx(i) - bw / 2).toFixed(1)} y={y.toFixed(1)} width={bw.toFixed(1)}
      height={Math.max(0, h).toFixed(1)} rx="3" fill={PREMIUM} opacity="0.85" />;
  });

  let linePath = '', started = false;
  data.forEach((d, i) => {
    if (d.margin == null) { started = false; return; }
    linePath += (started ? 'L' : 'M') + cx(i).toFixed(1) + ',' + yM(d.margin).toFixed(1) + ' ';
    started = true;
  });
  const dots = data.map((d, i) => d.margin == null ? null : (
    <circle key={i} cx={cx(i).toFixed(1)} cy={yM(d.margin).toFixed(1)} r="3.5"
      fill={d.margin >= 0 ? PROFIT : LOSS} stroke="#0b1020" strokeWidth="1.5" />
  ));

  const tk = 4;
  const gridLines = [], leftLabels = [], rightLabels = [];
  for (let t = 0; t <= tk; t++) {
    const val = (maxP * t) / tk, y = yP(val);
    gridLines.push(<line key={`g${t}`} x1={padL} y1={y.toFixed(1)} x2={W - padR} y2={y.toFixed(1)} stroke={GRID} />);
    leftLabels.push(<text key={`l${t}`} x={padL - 6} y={(y + 3).toFixed(1)} textAnchor="end" fontSize="9"
      fontFamily="monospace" fill={AXIS_TXT}>{premiumFmt(val)}</text>);
  }
  for (let t = 0; t <= tk; t++) {
    const val = minM + (maxM - minM) * (t / tk), y = yM(val);
    rightLabels.push(<text key={`r${t}`} x={W - padR + 6} y={(y + 3).toFixed(1)} textAnchor="start" fontSize="9"
      fontFamily="monospace" fill={AXIS_TXT}>{(val * 100).toFixed(0)}%</text>);
  }
  const xLabels = data.map((d, i) => (
    <text key={i} x={cx(i).toFixed(1)} y={(pBase + (rotate ? 12 : 16)).toFixed(1)}
      textAnchor={rotate ? 'end' : 'middle'} fontSize="9.5" fontFamily="monospace" fill={AXIS_TXT}
      transform={rotate ? `rotate(-40 ${cx(i).toFixed(1)} ${(pBase + 12).toFixed(1)})` : undefined}>
      {String(d.label)}
    </text>
  ));

  return (
    <svg className="dash-combo-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
      role="img" aria-label="Premium and UW margin by band">
      {gridLines}
      {minM < 0 && <line x1={padL} y1={mBase.toFixed(1)} x2={W - padR} y2={mBase.toFixed(1)} stroke={ZERO} strokeDasharray="3 3" />}
      {bars}
      <path d={linePath} fill="none" stroke="#ffb020" strokeWidth="2" strokeLinejoin="round" />
      {dots}
      {leftLabels}
      {rightLabels}
      {xLabels}
    </svg>
  );
}
