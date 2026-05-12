// PerformanceAnalysisModal.jsx
// Tabs: Losses/Premiums/Results charts + Moving Average (3/5/10 yr LR & CR)
import { useState, useMemo } from 'react';
import { toN as cn } from '../../../utils/format';

const fmt = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n.toFixed(0);

const TABS = [
  { key: 'charts',  label: 'Premiums & Losses' },
  { key: 'results', label: 'Results' },
  { key: 'moving',  label: 'Moving Averages' },
];

// ── SVG Bar Chart ──────────────────────────────────────────────────────────
function BarChart({ rows, series, height = 220, showLine }) {
  const W = 680, H = height, PAD = { t: 20, r: 20, b: 36, l: 64 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const n = rows.length;
  if (!n) return null;

  const allVals = series.flatMap(s => rows.map(r => cn(r[s.key])));
  const maxV = Math.max(...allVals, 1);
  const minV = Math.min(...allVals, 0);
  const range = maxV - minV || 1;

  const barGap = 4;
  const groupW = (cW / n);
  const barW = Math.max(4, (groupW - barGap * (series.length + 1)) / series.length);

  const yScale = v => cH - ((v - minV) / range) * cH;
  const yTicks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ width: '100%', height: 'auto', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
      {/* Grid lines */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = minV + (range / yTicks) * i;
        const y = PAD.t + yScale(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="rgba(255,255,255,0.07)" strokeWidth={1} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
            <text x={PAD.l - 6} y={y + 4} textAnchor="end" fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.65)">{fmt(v)}</text>
          </g>
        );
      })}
      {/* Zero line */}
      {minV < 0 && (
        <line x1={PAD.l} y1={PAD.t + yScale(0)} x2={W - PAD.r} y2={PAD.t + yScale(0)}
          stroke="rgba(255,255,255,0.30)" strokeWidth={1} strokeDasharray="4,3" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
      )}
      {/* Bars */}
      {rows.map((row, gi) => {
        const gX = PAD.l + gi * groupW + barGap;
        return (
          <g key={gi}>
            {series.map((s, si) => {
              const v = cn(row[s.key]);
              const bX = gX + si * (barW + barGap);
              const bH = Math.abs(yScale(v) - yScale(0));
              const bY = PAD.t + (v >= 0 ? yScale(v) : yScale(0));
              return (
                <g key={si}>
                  <rect x={bX} y={bY} width={barW} height={Math.max(1, bH)}
                    fill={s.color} opacity={0.92} rx={2} shapeRendering="crispEdges">
                    <title>{s.label}: {fmt(v)}</title>
                  </rect>
                </g>
              );
            })}
            <text x={gX + (series.length * (barW + barGap)) / 2 - barGap} y={H - PAD.b + 14}
              textAnchor="middle" fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.70)">{row.year}</text>
          </g>
        );
      })}
      {/* Line overlay */}
      {showLine && (() => {
        const pts = rows.map((row, gi) => {
          const v = cn(row[showLine.key]);
          const bX = PAD.l + gi * groupW + barGap + (series.length * (barW + barGap)) / 2 - barGap;
          return `${bX},${PAD.t + yScale(v)}`;
        }).join(' ');
        return <polyline points={pts} fill="none" stroke={showLine.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
      })()}
    </svg>
  );
}

// ── SVG Line Chart ──────────────────────────────────────────────────────────
function LineChart({ rows, series, height = 220, refLine }) {
  const W = 680, H = height, PAD = { t: 20, r: 20, b: 36, l: 56 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const n = rows.length;
  if (!n) return null;

  const allVals = series.flatMap(s => rows.map(r => cn(r[s.key])).filter(v => v !== 0));
  if (refLine) allVals.push(refLine);
  const maxV = Math.max(...allVals, 1) * 1.1;
  const minV = Math.min(...allVals, 0) * 0.9;
  const range = maxV - minV || 1;

  const xPos = i => PAD.l + (i / (n - 1 || 1)) * cW;
  const yPos = v => PAD.t + cH - ((v - minV) / range) * cH;
  const yTicks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ width: '100%', height: 'auto', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = minV + (range / yTicks) * i;
        const y = yPos(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="rgba(255,255,255,0.07)" strokeWidth={1} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
            <text x={PAD.l - 6} y={y + 4} textAnchor="end" fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.65)">{v.toFixed(0)}%</text>
          </g>
        );
      })}
      {/* Reference line (e.g. 100% combined ratio) */}
      {refLine != null && (
        <line x1={PAD.l} y1={yPos(refLine)} x2={W - PAD.r} y2={yPos(refLine)}
          stroke="rgba(248,113,113,0.6)" strokeWidth={1.5} strokeDasharray="6,4" vectorEffect="non-scaling-stroke" />
      )}
      {series.map(s => {
        const validRows = rows.filter(r => cn(r[s.key]) !== 0);
        if (!validRows.length) return null;
        const pts = validRows.map((row) => {
          const origI = rows.indexOf(row);
          return `${xPos(origI)},${yPos(cn(row[s.key]))}`;
        }).join(' ');
        return (
          <g key={s.key}>
            <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            {validRows.map((row, i) => {
              const origI = rows.indexOf(row);
              return (
                <circle key={i} cx={xPos(origI)} cy={yPos(cn(row[s.key]))} r={3.5}
                  fill={s.color} stroke="rgba(6,12,24,1)" strokeWidth={1.5} vectorEffect="non-scaling-stroke">
                  <title>{s.label} {row.year || row.label}: {cn(row[s.key]).toFixed(1)}%</title>
                </circle>
              );
            })}
          </g>
        );
      })}
      {rows.map((row, i) => (
        <text key={i} x={xPos(i)} y={H - PAD.b + 14} textAnchor="middle" fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.70)">
          {row.year || row.label}
        </text>
      ))}
    </svg>
  );
}

// ── Legend ──────────────────────────────────────────────────────────────────
function Legend({ items }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
      {items.map(it => (
        <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
          <div style={{ width: 12, height: it.line ? 2 : 10, borderRadius: it.line ? 0 : 2, background: it.color,
            ...(it.dashed ? { backgroundImage: `repeating-linear-gradient(90deg,${it.color} 0,${it.color} 5px,transparent 5px,transparent 9px)` } : {}) }} />
          {it.label}
        </div>
      ))}
    </div>
  );
}

// ── Moving Average calc ──────────────────────────────────────────────────────
function movingAvg(arr, window) {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - window + 1), i + 1);
    const valid = slice.filter(v => v != null && !isNaN(v));
    return valid.length === window ? valid.reduce((a, b) => a + b, 0) / window : null;
  });
}

// ── Main Modal ──────────────────────────────────────────────────────────────
export default function PerformanceAnalysisModal({ calcRows, onClose }) {
  const [tab, setTab] = useState('charts');
  const [maWindow, setMaWindow] = useState(5);

  // Derived series
  const rows = calcRows;

  // Loss ratios per year
  const lrData = rows.map(r => ({
    year: r.year,
    actLR: r.actPremium > 0 ? (r.actClaims / r.actPremium) * 100 : null,
    projLR: r.premium > 0 ? (r.ultClaims / r.premium) * 100 : null,
  }));

  // Combined ratios per year
  const crData = rows.map(r => {
    const actExp = cn(r.actComm) + cn(r.actBrokerage) + cn(r.actTaxes) + cn(r.actPC);
    const projExp = cn(r.comm) + cn(r.brokerage) + cn(r.taxes) + cn(r.profitComm);
    return {
      year: r.year,
      actCR: r.actPremium > 0 ? ((r.actClaims + actExp - cn(r.actLPC)) / r.actPremium) * 100 : null,
      projCR: r.premium > 0 ? ((r.ultClaims + projExp - cn(r.lpc)) / r.premium) * 100 : null,
    };
  });

  // Moving averages
  const maData = useMemo(() => {
    const actLRs = lrData.map(r => r.actLR);
    const projLRs = lrData.map(r => r.projLR);
    const actCRs = crData.map(r => r.actCR);
    const projCRs = crData.map(r => r.projCR);
    const ma3LR  = movingAvg(actLRs, 3);
    const ma5LR  = movingAvg(actLRs, 5);
    const ma10LR = movingAvg(actLRs, 10);
    const ma3CR  = movingAvg(actCRs, 3);
    const ma5CR  = movingAvg(actCRs, 5);
    const ma10CR = movingAvg(actCRs, 10);
    return rows.map((r, i) => ({
      year: r.year,
      actLR: actLRs[i], projLR: projLRs[i],
      actCR: actCRs[i], projCR: projCRs[i],
      ma3LR: ma3LR[i], ma5LR: ma5LR[i], ma10LR: ma10LR[i],
      ma3CR: ma3CR[i], ma5CR: ma5CR[i], ma10CR: ma10CR[i],
    }));
  }, [crData, lrData, rows]);

  // Chart style
  const chartCard = { padding: '14px 16px', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 14 };
  const chartTitle = { fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 };

  return (
    <div className="modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,18,0.88)', backdropFilter: 'blur(8px)',
      zIndex: 4500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width: 'calc(100vw - 20px)', maxWidth: 900, height: 'calc(100vh - 40px)',
        background: 'linear-gradient(160deg,#0c1628,#060c18)',
        border: '1px solid rgba(0,232,184,0.2)', borderRadius: 16,
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#fff' }}>📈 Performance Analysis</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>Historical vs projected losses, premiums, results and trend analysis</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', fontSize: 20, cursor: 'pointer' }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding: '10px 20px', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
                background: tab === t.key ? 'rgba(0,232,184,0.1)' : 'transparent',
                color: tab === t.key ? '#00e8b8' : 'rgba(255,255,255,0.45)',
                borderBottom: tab === t.key ? '2px solid #00e8b8' : '2px solid transparent',
                letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* ── PREMIUMS & LOSSES TAB ── */}
          {tab === 'charts' && (
            <>
              <div style={chartCard}>
                <div style={chartTitle}>Gross Written Premium — Actual vs Projected</div>
                <Legend items={[
                  { key: 'act', color: '#4ade80', label: 'Actual Premium' },
                  { key: 'proj', color: 'rgba(74,222,128,0.35)', label: 'Projected (Ultimate)' },
                ]} />
                <BarChart rows={rows} series={[
                  { key: 'actPremium', label: 'Actual Premium', color: '#4ade80' },
                  { key: 'premium', label: 'Projected Premium', color: 'rgba(74,222,128,0.35)' },
                ]} />
              </div>
              <div style={chartCard}>
                <div style={chartTitle}>Incurred Claims — Actual vs Ultimate</div>
                <Legend items={[
                  { key: 'act', color: '#f87171', label: 'Actual Claims' },
                  { key: 'ult', color: 'rgba(248,113,113,0.35)', label: 'Ultimate Claims (Projected)' },
                ]} />
                <BarChart rows={rows} series={[
                  { key: 'actClaims', label: 'Actual Claims', color: '#f87171' },
                  { key: 'ultClaims', label: 'Ultimate Claims', color: 'rgba(248,113,113,0.35)' },
                ]} />
              </div>
              <div style={chartCard}>
                <div style={chartTitle}>Loss Ratio — Actual vs Projected</div>
                <Legend items={[
                  { key: 'actLR', color: '#f87171', label: 'Actual LR', line: true },
                  { key: 'projLR', color: 'rgba(248,113,113,0.5)', label: 'Projected LR', line: true, dashed: true },
                ]} />
                <LineChart rows={lrData} series={[
                  { key: 'actLR', label: 'Actual LR', color: '#f87171' },
                  { key: 'projLR', label: 'Projected LR', color: 'rgba(248,113,113,0.5)' },
                ]} refLine={100} />
              </div>
            </>
          )}

          {/* ── RESULTS TAB ── */}
          {tab === 'results' && (
            <>
              <div style={chartCard}>
                <div style={chartTitle}>Underwriting Result — Actual vs Projected</div>
                <Legend items={[
                  { key: 'act', color: '#4ade80', label: 'Actual Result' },
                  { key: 'proj', color: '#60a5fa', label: 'Projected Result' },
                ]} />
                <BarChart rows={rows} series={[
                  { key: 'actResult', label: 'Actual Result', color: '#4ade80' },
                  { key: 'result', label: 'Projected Result', color: '#60a5fa' },
                ]} />
              </div>
              <div style={chartCard}>
                <div style={chartTitle}>Result % — Actual vs Projected</div>
                <Legend items={[
                  { key: 'actR', color: '#4ade80', label: 'Actual Result %', line: true },
                  { key: 'projR', color: '#60a5fa', label: 'Projected Result %', line: true },
                ]} />
                <LineChart rows={rows.map(r => ({
                  year: r.year,
                  actR: r.actPremium > 0 ? (r.actResult / r.actPremium) * 100 : null,
                  projR: r.premium > 0 ? (r.result / r.premium) * 100 : null,
                }))} series={[
                  { key: 'actR', label: 'Actual Result %', color: '#4ade80' },
                  { key: 'projR', label: 'Projected Result %', color: '#60a5fa' },
                ]} refLine={0} />
              </div>
              <div style={chartCard}>
                <div style={chartTitle}>Combined Ratio — Actual vs Projected</div>
                <Legend items={[
                  { key: 'actCR', color: '#fbbf24', label: 'Actual CR', line: true },
                  { key: 'projCR', color: 'rgba(251,191,36,0.5)', label: 'Projected CR', line: true, dashed: true },
                ]} />
                <LineChart rows={crData} series={[
                  { key: 'actCR', label: 'Actual CR', color: '#fbbf24' },
                  { key: 'projCR', label: 'Projected CR', color: 'rgba(251,191,36,0.5)' },
                ]} refLine={100} />
              </div>
            </>
          )}

          {/* ── MOVING AVERAGES TAB ── */}
          {tab === 'moving' && (
            <>
              {/* Window selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>Show moving average:</span>
                {[3, 5, 10].map(w => (
                  <button key={w} onClick={() => setMaWindow(w)}
                    style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: '1px solid',
                      borderColor: maWindow === w ? 'rgba(0,232,184,0.5)' : 'rgba(255,255,255,0.15)',
                      background: maWindow === w ? 'rgba(0,232,184,0.12)' : 'transparent',
                      color: maWindow === w ? '#00e8b8' : 'rgba(255,255,255,0.45)', cursor: 'pointer' }}>
                    {w}-Year
                  </button>
                ))}
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 4 }}>
                  ({maData.filter(r => r[`ma${maWindow}LR`] != null).length} data points available)
                </span>
              </div>

              <div style={chartCard}>
                <div style={chartTitle}>Loss Ratio — Annual vs {maWindow}-Year Moving Average</div>
                <Legend items={[
                  { key: 'actLR', color: 'rgba(248,113,113,0.4)', label: 'Annual Actual LR', line: true },
                  { key: `ma${maWindow}LR`, color: '#f87171', label: `${maWindow}-Year MA`, line: true },
                  { key: 'projLR', color: 'rgba(96,165,250,0.5)', label: 'Projected LR', line: true, dashed: true },
                ]} />
                <LineChart rows={maData} series={[
                  { key: 'actLR', label: 'Annual LR', color: 'rgba(248,113,113,0.4)' },
                  { key: `ma${maWindow}LR`, label: `${maWindow}Y MA LR`, color: '#f87171' },
                  { key: 'projLR', label: 'Projected LR', color: 'rgba(96,165,250,0.6)' },
                ]} refLine={100} />
                {/* All 3 MAs overlay summary */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginBottom: 6 }}>Latest moving average values:</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[3, 5, 10].map(w => {
                      const last = [...maData].reverse().find(r => r[`ma${w}LR`] != null);
                      return last ? (
                        <div key={w} style={{ padding: '6px 12px', borderRadius: 7, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>{w}-Yr MA LR</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: last[`ma${w}LR`] > 100 ? '#f87171' : last[`ma${w}LR`] > 70 ? '#fbbf24' : '#4ade80' }}>
                            {last[`ma${w}LR`].toFixed(1)}%
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>as of {last.year}</div>
                        </div>
                      ) : null;
                    })}
                  </div>
                </div>
              </div>

              <div style={chartCard}>
                <div style={chartTitle}>Combined Ratio — Annual vs {maWindow}-Year Moving Average</div>
                <Legend items={[
                  { key: 'actCR', color: 'rgba(251,191,36,0.4)', label: 'Annual Actual CR', line: true },
                  { key: `ma${maWindow}CR`, color: '#fbbf24', label: `${maWindow}-Year MA`, line: true },
                  { key: 'projCR', color: 'rgba(167,139,250,0.6)', label: 'Projected CR', line: true, dashed: true },
                ]} />
                <LineChart rows={maData} series={[
                  { key: 'actCR', label: 'Annual CR', color: 'rgba(251,191,36,0.4)' },
                  { key: `ma${maWindow}CR`, label: `${maWindow}Y MA CR`, color: '#fbbf24' },
                  { key: 'projCR', label: 'Projected CR', color: 'rgba(167,139,250,0.6)' },
                ]} refLine={100} />
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginBottom: 6 }}>Latest moving average values:</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {[3, 5, 10].map(w => {
                      const last = [...maData].reverse().find(r => r[`ma${w}CR`] != null);
                      return last ? (
                        <div key={w} style={{ padding: '6px 12px', borderRadius: 7, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 2 }}>{w}-Yr MA CR</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: last[`ma${w}CR`] > 100 ? '#f87171' : last[`ma${w}CR`] > 85 ? '#fbbf24' : '#4ade80' }}>
                            {last[`ma${w}CR`].toFixed(1)}%
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>as of {last.year}</div>
                        </div>
                      ) : null;
                    })}
                  </div>
                </div>
              </div>

              {/* Summary table of all MAs */}
              <div style={chartCard}>
                <div style={chartTitle}>Full Moving Average Table</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr>
                        {['Year','Act LR','Proj LR','3Y LR','5Y LR','10Y LR','Act CR','Proj CR','3Y CR','5Y CR','10Y CR'].map(h => (
                          <th key={h} style={{ padding: '7px 10px', fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.4)',
                            textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)', textAlign: h === 'Year' ? 'left' : 'right', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {maData.map((r, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                          <td style={{ padding: '6px 10px', fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>{r.year}</td>
                          {[r.actLR, r.projLR, r.ma3LR, r.ma5LR, r.ma10LR, r.actCR, r.projCR, r.ma3CR, r.ma5CR, r.ma10CR].map((v, j) => (
                            <td key={j} style={{ padding: '6px 10px', textAlign: 'right',
                              color: v == null ? 'rgba(255,255,255,0.2)' : v > 100 ? '#f87171' : v > 70 ? '#fbbf24' : '#4ade80',
                              fontWeight: v != null ? 600 : 400 }}>
                              {v != null ? v.toFixed(1) + '%' : '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
