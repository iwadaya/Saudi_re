// InDepthPortfolioModal.jsx
// Full-screen in-depth component pricing comparison:
// Tab 1: Visual comparison (actuarial vs actual vs market vs UW)
// Tab 2: Gap analysis (spread from market, actuarial adequacy)
// Tab 3: Snapshot history trends
import { useState, useMemo } from 'react';
import { COMPONENT_ROWS } from './propPricingConstants';

// ── helpers ──────────────────────────────────────────────────────────────────
const rawNum   = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/,/g,'').replace(/%/g,'')); return Number.isFinite(n) ? n : null; };
const toDisplay = v => { const n = rawNum(v); if (n == null) return null; return n > 1.5 ? n : n * 100; }; // normalize to % display
const fmt1    = v => v != null ? v.toFixed(2) + '%' : '—';
const diff    = (a, b) => { if (a == null || b == null) return null; return a - b; };
const diffFmt = v => { if (v == null) return '—'; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; };
const diffColor = v => { if (v == null) return 'rgba(255,255,255,0.35)'; return v > 2 ? '#f87171' : v > 0 ? '#fbbf24' : v < -2 ? '#4ade80' : '#60a5fa'; };

// Which components are "loss" (higher = worse) vs "margin" (higher = better)
const IS_COST = new Set(['Attritional Loss Ratio','Large Loss Loading','Cat Loss Loading','Commissions','Brokerage','Taxes','Maximum Commissions (Reinsurer)']);

const COLS = [
  { key: 'actuarial', label: 'Actuarial\n(Engine)',  color: '#60a5fa', short: 'Act.Eng.' },
  { key: 'actual',    label: 'Actual\nStats',        color: '#4ade80', short: 'Actual'   },
  { key: 'exposure',  label: 'Exposure\nRating',     color: '#a78bfa', short: 'Exposure' },
  { key: 'market',    label: 'Market\nAverage',      color: '#fbbf24', short: 'Market'   },
  { key: 'uw',        label: 'UW\nOverride',         color: '#00e8b8', short: 'UW'       },
];

const TABS = [
  { key: 'compare', label: 'Visual Comparison' },
  { key: 'gaps',    label: 'Gap Analysis'       },
  { key: 'radar',   label: 'Adequacy Score'     },
  { key: 'history', label: 'Snapshot Trends'    },
];

// ── SVG Grouped Bar Chart ─────────────────────────────────────────────────────
function GroupedBarChart({ rows, highlight }) {
  const W = 800, H = 260, PAD = { t: 20, r: 20, b: 60, l: 56 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const n = rows.length;
  if (!n) return null;

  const dataRows = rows.filter(r => r.name !== 'Result'); // Result is margin not cost
  const allVals = dataRows.flatMap(r => COLS.map(c => r[c.key]).filter(v => v != null));
  const maxV = Math.max(...allVals, 1);
  const groupW = cW / dataRows.length;
  const barGap = 3;
  const barW = Math.max(3, (groupW - barGap * (COLS.length + 1)) / COLS.length);
  const yScale = v => cH - (v / maxV) * cH;
  const yTicks = 5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ width: '100%', height: 'auto', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = (maxV / yTicks) * i;
        const y = PAD.t + yScale(v);
        return (
          <g key={i}>
            <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} stroke="rgba(255,255,255,0.07)" strokeWidth={1} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
            <text x={PAD.l - 5} y={y + 4} textAnchor="end" fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.65)">{v.toFixed(0)}%</text>
          </g>
        );
      })}
      {dataRows.map((row, gi) => {
        const gX = PAD.l + gi * groupW + barGap;
        const isHL = highlight === row.name;
        return (
          <g key={gi}>
            <rect x={gX - 2} y={PAD.t} width={groupW} height={cH} fill={isHL ? 'rgba(255,255,255,0.05)' : 'none'} rx={3} shapeRendering="crispEdges" />
            {COLS.map((col, ci) => {
              const v = row[col.key];
              if (v == null) return null;
              const bX = gX + ci * (barW + barGap);
              const bH = Math.max(2, (v / maxV) * cH);
              const bY = PAD.t + cH - bH;
              return (
                <g key={col.key}>
                  <rect x={bX} y={bY} width={barW} height={bH} fill={col.color} opacity={0.92} rx={1.5} shapeRendering="crispEdges">
                    <title>{col.short}: {v.toFixed(2)}%</title>
                  </rect>
                </g>
              );
            })}
            <text x={gX + (COLS.length * (barW + barGap)) / 2} y={H - PAD.b + 16}
              textAnchor="middle" fontSize={10} fill={isHL ? '#fff' : 'rgba(255,255,255,0.70)'}
              style={{ fontWeight: isHL ? 700 : 500 }}>
              {row.name.replace(' Loss Ratio', ' LR').replace(' Loading', ' Ldg').replace(' Commissions (Reinsurer)', ' Comm')}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Horizontal gap bar ────────────────────────────────────────────────────────
function GapBar({ value, maxAbs, color }) {
  const W = 160;
  const center = W / 2;
  const scale = v => Math.min(Math.abs(v) / maxAbs, 1) * (W / 2 - 4);
  const w = scale(value || 0);
  const isPos = value >= 0;
  return (
    <svg width={W} height={16} style={{ overflow: 'visible' }}>
      <line x1={center} y1={0} x2={center} y2={16} stroke="rgba(255,255,255,0.30)" strokeWidth={1} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
      {value !== 0 && value != null && (
        <rect
          x={isPos ? center : center - w}
          y={3} width={w} height={10}
          fill={color} rx={2} opacity={0.92} shapeRendering="crispEdges"
        />
      )}
    </svg>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────
export default function InDepthPortfolioModal({ getC, snapshots, onClose }) {
  const [tab, setTab]         = useState('compare');
  const [highlight, setHL]    = useState(null);

  // Build row data
  const rowData = useMemo(() => COMPONENT_ROWS.map(name => {
    const obj = { name };
    COLS.forEach(c => {
      const raw = getC(name, c.key);
      obj[c.key] = toDisplay(raw);
    });
    return obj;
  }), [getC]);

  // UW vs each column gap (UW minus col)
  const gapData = useMemo(() => {
    return rowData.filter(r => r.name !== 'Result').map(r => {
      const uwVal = r.uw ?? r.actuarial;
      return {
        name: r.name,
        isCost: IS_COST.has(r.name),
        vsActuarial: diff(uwVal, r.actuarial),
        vsActual:    diff(uwVal, r.actual),
        vsMarket:    diff(uwVal, r.market),
        actuarial:   r.actuarial, actual: r.actual, market: r.market, uw: uwVal,
      };
    });
  }, [rowData]);

  // Adequacy scores: how close is UW to actuarial on each row (0–100)
  const scores = useMemo(() => {
    const scored = rowData.filter(r => r.actuarial != null && r.name !== 'Result').map(r => {
      const uwVal = r.uw ?? r.actuarial;
      if (r.actuarial == null || r.actuarial === 0) return { name: r.name, score: 50 };
      const gap = Math.abs((uwVal - r.actuarial) / r.actuarial);
      const score = Math.max(0, Math.min(100, Math.round(100 - gap * 300)));
      return { name: r.name, score, uwVal, actuarial: r.actuarial, isCost: IS_COST.has(r.name) };
    });
    const overall = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : 0;
    return { rows: scored, overall };
  }, [rowData]);

  const scoreColor = s => s >= 80 ? '#4ade80' : s >= 60 ? '#fbbf24' : '#f87171';

  const maxGap = useMemo(() => {
    const all = gapData.flatMap(r => [Math.abs(r.vsActuarial||0), Math.abs(r.vsActual||0), Math.abs(r.vsMarket||0)]);
    return Math.max(...all, 1);
  }, [gapData]);

  // Snapshot trends
  const snapTrends = useMemo(() => {
    if (!snapshots?.length) return [];
    return snapshots.slice(-10).map(s => {
      const c = s.components || {};
      return {
        label: s.label || s.created_at?.slice(0, 10) || '?',
        result: toDisplay(c['Result']?.uw ?? c['Result']?.actuarial),
        lossRatio: toDisplay(c['Attritional Loss Ratio']?.uw ?? c['Attritional Loss Ratio']?.actuarial),
        commission: toDisplay(c['Commissions']?.uw ?? c['Commissions']?.actuarial),
      };
    });
  }, [snapshots]);

  const S = { // shared styles
    card:  { padding: '14px 16px', borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 14 },
    title: { fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 0, marginBottom: 10 },
    th:    { padding: '8px 12px', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0,
             borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap', background: 'rgba(6,12,24,0.95)', position: 'sticky', top: 0 },
    td:    { padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: 12, verticalAlign: 'middle' },
  };

  return (
    <div className="modal-backdrop" style={{ position:'fixed', inset:0, background:'rgba(2,6,18,0.9)', backdropFilter:'blur(8px)',
      zIndex:4200, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width:'calc(100vw - 20px)', maxWidth:1100, height:'calc(100vh - 24px)',
        background:'linear-gradient(160deg,#0c1628,#060e1c)',
        border:'1px solid rgba(96,165,250,0.22)', borderRadius:16,
        boxShadow:'0 32px 80px rgba(0,0,0,0.75)', display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* ── Header ── */}
        <div style={{ padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', gap:14, flexShrink:0 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:800, fontSize:15, color:'#fff' }}>🔬 In-Depth Portfolio Analysis</div>
            <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:2 }}>
              Actuarial engine · Actual stats · Exposure rating · Market average · UW override — side by side
            </div>
          </div>
          {/* Overall score */}
          <div style={{ textAlign:'center', padding:'6px 14px', borderRadius:8, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.1)' }}>
            <div style={{ fontSize:9, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:2 }}>Actuarial Adherence</div>
            <div style={{ fontSize:22, fontWeight:900, color: scoreColor(scores.overall) }}>{scores.overall}/100</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(255,255,255,0.4)', fontSize:20, cursor:'pointer', padding:'2px 8px' }}>✕</button>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.08)', flexShrink:0 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding:'10px 20px', fontSize:12, fontWeight:700, border:'none', cursor:'pointer',
                background: tab===t.key ? 'rgba(96,165,250,0.10)' : 'transparent',
                color: tab===t.key ? '#60a5fa' : 'rgba(255,255,255,0.45)',
                borderBottom: tab===t.key ? '2px solid #60a5fa' : '2px solid transparent',
                letterSpacing: 0, textTransform:'uppercase' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Content ── */}
        <div style={{ flex:1, overflow:'auto', padding:'16px 20px' }}>

          {/* ═══ TAB 1: VISUAL COMPARISON ═══ */}
          {tab === 'compare' && (<>
            {/* Legend */}
            <div style={{ display:'flex', gap:14, marginBottom:12, flexWrap:'wrap' }}>
              {COLS.map(c => (
                <div key={c.key} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'rgba(255,255,255,0.6)' }}>
                  <div style={{ width:10, height:10, borderRadius:2, background:c.color }} />{c.short}
                </div>
              ))}
            </div>

            <div style={S.card}>
              <div style={S.title}>Component Comparison — All Columns (click row to highlight)</div>
              <GroupedBarChart rows={rowData} highlight={highlight} />
            </div>

            {/* Numeric comparison table */}
            <div style={S.card}>
              <div style={S.title}>Numeric Comparison Table</div>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <th style={{...S.th, textAlign:'left', width:200}}>Component</th>
                    {COLS.map(c => <th key={c.key} style={{...S.th, textAlign:'right', color:c.color}}>{c.short}</th>)}
                    <th style={{...S.th, textAlign:'right'}}>UW vs Actuarial</th>
                    <th style={{...S.th, textAlign:'right'}}>UW vs Market</th>
                    <th style={{...S.th, textAlign:'right'}}>Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {rowData.map((r, i) => {
                    const uwVal  = r.uw ?? r.actuarial;
                    const vsAct  = diff(uwVal, r.actuarial);
                    const vsMkt  = diff(uwVal, r.market);
                    const isCost = IS_COST.has(r.name);
                    // Signal: for cost rows, UW > actuarial is aggressive (red); for Result, UW > actuarial is good (green)
                    const signalVal = isCost ? -(vsAct ?? 0) : (vsAct ?? 0);
                    const signal = signalVal > 2 ? { t:'✓ Conservative', c:'#4ade80' }
                      : signalVal < -2 ? { t:'⚠ Aggressive', c:'#f87171' }
                      : { t:'≈ In Line', c:'#60a5fa' };
                    return (
                      <tr key={i}
                        onClick={() => setHL(highlight === r.name ? null : r.name)}
                        style={{ background: highlight===r.name ? 'rgba(96,165,250,0.07)' : i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)', cursor:'pointer' }}>
                        <td style={{...S.td, fontWeight:600, color: highlight===r.name ? '#60a5fa' : 'rgba(255,255,255,0.85)'}}>{r.name}</td>
                        {COLS.map(c => (
                          <td key={c.key} style={{...S.td, textAlign:'right', color: r[c.key] != null ? c.color : 'rgba(255,255,255,0.2)', fontWeight: c.key==='uw'?700:400}}>
                            {r[c.key] != null ? fmt1(r[c.key]) : '—'}
                          </td>
                        ))}
                        <td style={{...S.td, textAlign:'right', color:diffColor(isCost ? -(vsAct??0) : (vsAct??0)), fontWeight:600}}>{diffFmt(vsAct)}</td>
                        <td style={{...S.td, textAlign:'right', color:diffColor(isCost ? -(vsMkt??0) : (vsMkt??0)), fontWeight:600}}>{diffFmt(vsMkt)}</td>
                        <td style={{...S.td, textAlign:'right'}}>
                          <span style={{ fontSize:10, fontWeight:700, color:signal.c, background:`${signal.c}18`, padding:'2px 8px', borderRadius:10 }}>{signal.t}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>)}

          {/* ═══ TAB 2: GAP ANALYSIS ═══ */}
          {tab === 'gaps' && (<>
            <div style={{ ...S.card }}>
              <div style={S.title}>UW Override vs Actuarial, Actual Stats & Market Average</div>
              <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginBottom:14 }}>
                Bars show how far the UW override deviates from each benchmark. <span style={{color:'#4ade80'}}>Green = conservative</span>, <span style={{color:'#f87171'}}>Red = aggressive</span>.
              </div>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <th style={{...S.th, textAlign:'left', width:200}}>Component</th>
                    <th style={{...S.th, textAlign:'right'}}>UW</th>
                    <th style={{...S.th, textAlign:'right'}}>Actuarial</th>
                    <th style={{...S.th}}>vs Actuarial</th>
                    <th style={{...S.th, textAlign:'right'}}>Actual Stats</th>
                    <th style={{...S.th}}>vs Actual</th>
                    <th style={{...S.th, textAlign:'right'}}>Market Avg</th>
                    <th style={{...S.th}}>vs Market</th>
                  </tr>
                </thead>
                <tbody>
                  {gapData.map((r, i) => {
                    const sign = r.isCost ? -1 : 1;
                    return (
                      <tr key={i} style={{ background: i%2===0?'transparent':'rgba(255,255,255,0.02)' }}>
                        <td style={{...S.td, fontWeight:600, color:'rgba(255,255,255,0.85)'}}>{r.name}</td>
                        <td style={{...S.td, textAlign:'right', color:'#00e8b8', fontWeight:700}}>{r.uw != null ? fmt1(r.uw) : '—'}</td>
                        <td style={{...S.td, textAlign:'right', color:'#60a5fa'}}>{r.actuarial != null ? fmt1(r.actuarial) : '—'}</td>
                        <td style={{...S.td}}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <GapBar value={r.vsActuarial} maxAbs={maxGap} color={diffColor(sign*(r.vsActuarial??0))} />
                            <span style={{ fontSize:11, fontWeight:600, color:diffColor(sign*(r.vsActuarial??0)), width:52, textAlign:'right' }}>{diffFmt(r.vsActuarial)}</span>
                          </div>
                        </td>
                        <td style={{...S.td, textAlign:'right', color:'#4ade80'}}>{r.actual != null ? fmt1(r.actual) : '—'}</td>
                        <td style={{...S.td}}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <GapBar value={r.vsActual} maxAbs={maxGap} color={diffColor(sign*(r.vsActual??0))} />
                            <span style={{ fontSize:11, fontWeight:600, color:diffColor(sign*(r.vsActual??0)), width:52, textAlign:'right' }}>{diffFmt(r.vsActual)}</span>
                          </div>
                        </td>
                        <td style={{...S.td, textAlign:'right', color:'#fbbf24'}}>{r.market != null ? fmt1(r.market) : '—'}</td>
                        <td style={{...S.td}}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <GapBar value={r.vsMarket} maxAbs={maxGap} color={diffColor(sign*(r.vsMarket??0))} />
                            <span style={{ fontSize:11, fontWeight:600, color:diffColor(sign*(r.vsMarket??0)), width:52, textAlign:'right' }}>{diffFmt(r.vsMarket)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Insight cards */}
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              {gapData.filter(r => r.vsActuarial != null && Math.abs(r.vsActuarial) > 2).map((r, i) => {
                const sign = r.isCost ? -1 : 1;
                const isAggressive = sign * r.vsActuarial < -2;
                return (
                  <div key={i} style={{ flex:'1 1 200px', padding:'10px 14px', borderRadius:9,
                    background: isAggressive ? 'rgba(248,113,113,0.08)' : 'rgba(74,222,128,0.08)',
                    border: `1px solid ${isAggressive ? 'rgba(248,113,113,0.25)' : 'rgba(74,222,128,0.25)'}` }}>
                    <div style={{ fontSize:10, fontWeight:700, color: isAggressive?'#f87171':'#4ade80', textTransform:'uppercase', marginBottom:4 }}>
                      {isAggressive ? '⚠ Aggressive' : '✓ Conservative'}
                    </div>
                    <div style={{ fontSize:12, fontWeight:700, color:'rgba(255,255,255,0.85)', marginBottom:2 }}>{r.name}</div>
                    <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)' }}>
                      UW: {fmt1(r.uw??0)} vs Actuarial: {fmt1(r.actuarial??0)} ({diffFmt(r.vsActuarial)})
                    </div>
                  </div>
                );
              })}
              {gapData.every(r => r.vsActuarial == null || Math.abs(r.vsActuarial) <= 2) && (
                <div style={{ fontSize:12, color:'#4ade80', padding:'10px 14px', background:'rgba(74,222,128,0.06)', borderRadius:9, border:'1px solid rgba(74,222,128,0.2)' }}>
                  ✓ All UW overrides are within 2% of actuarial pricing — no material deviations.
                </div>
              )}
            </div>
          </>)}

          {/* ═══ TAB 3: ADEQUACY SCORE ═══ */}
          {tab === 'radar' && (<>
            <div style={{ ...S.card }}>
              <div style={S.title}>Actuarial Adherence by Component</div>
              <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginBottom:16 }}>
                Score 0–100: how closely the UW override tracks the actuarial engine. 100 = exact match. Penalty increases with deviation size.
              </div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:12, marginBottom:16 }}>
                <div style={{ padding:'14px 20px', borderRadius:10, background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', textAlign:'center', minWidth:130 }}>
                  <div style={{ fontSize:10, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:4 }}>Overall Score</div>
                  <div style={{ fontSize:36, fontWeight:900, color:scoreColor(scores.overall) }}>{scores.overall}</div>
                  <div style={{ fontSize:10, color:'rgba(255,255,255,0.3)', marginTop:2 }}>/ 100</div>
                  <div style={{ fontSize:11, fontWeight:700, marginTop:6, color:scoreColor(scores.overall) }}>
                    {scores.overall >= 80 ? 'Strong Adherence' : scores.overall >= 60 ? 'Moderate Deviation' : 'High Deviation'}
                  </div>
                </div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:10, flex:1 }}>
                  {scores.rows.map((r, i) => (
                    <div key={i} style={{ padding:'10px 14px', borderRadius:9, flex:'1 1 150px',
                      background:'rgba(255,255,255,0.04)', border:`1px solid ${scoreColor(r.score)}30` }}>
                      <div style={{ fontSize:9, color:'rgba(255,255,255,0.4)', textTransform:'uppercase', marginBottom:4, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{r.name}</div>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <div style={{ flex:1, height:6, borderRadius:3, background:'rgba(255,255,255,0.08)' }}>
                          <div style={{ height:'100%', borderRadius:3, width:`${r.score}%`, background:scoreColor(r.score), transition:'width 0.4s' }} />
                        </div>
                        <span style={{ fontSize:13, fontWeight:800, color:scoreColor(r.score), width:32, textAlign:'right' }}>{r.score}</span>
                      </div>
                      {r.actuarial != null && (
                        <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginTop:5, display:'flex', justifyContent:'space-between' }}>
                          <span>UW: {fmt1(r.uwVal??0)}</span>
                          <span>Act: {fmt1(r.actuarial)}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              {/* Interpretation */}
              <div style={{ padding:'12px 14px', borderRadius:9, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', fontSize:11, color:'rgba(255,255,255,0.5)', lineHeight:1.7 }}>
                <b style={{color:'rgba(255,255,255,0.7)'}}>How to read this:</b> A score below 60 on any cost component (loss ratio, commissions) means your UW override diverges significantly from the actuarial engine.
                On loss components, a lower UW than actuarial is aggressive (under-pricing risk); on margin/result components, a higher UW is more conservative.
                Deviations beyond 5% from actuarial indicate a meaningful judgement overlay — ensure these are documented with rationale.
              </div>
            </div>
          </>)}

          {/* ═══ TAB 4: SNAPSHOT TRENDS ═══ */}
          {tab === 'history' && (<>
            {snapTrends.length === 0 ? (
              <div style={{ textAlign:'center', padding:40, color:'rgba(255,255,255,0.35)', fontSize:13 }}>
                No snapshots saved yet. Use the 📸 Save Snapshot button on the component pricing table to track pricing iterations.
              </div>
            ) : (<>
              <div style={S.card}>
                <div style={S.title}>Pricing Evolution Across Snapshots</div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{...S.th, textAlign:'left'}}>Snapshot</th>
                      <th style={{...S.th, textAlign:'right'}}>Attritional LR</th>
                      <th style={{...S.th, textAlign:'right'}}>Commissions</th>
                      <th style={{...S.th, textAlign:'right'}}>Result</th>
                      <th style={{...S.th, textAlign:'right'}}>LR Δ</th>
                      <th style={{...S.th, textAlign:'right'}}>Result Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapTrends.map((r, i) => {
                      const prevLR  = i > 0 ? snapTrends[i-1].lossRatio  : null;
                      const prevRes = i > 0 ? snapTrends[i-1].result     : null;
                      const dLR  = diff(r.lossRatio, prevLR);
                      const dRes = diff(r.result, prevRes);
                      return (
                        <tr key={i} style={{ background: i%2===0?'transparent':'rgba(255,255,255,0.02)' }}>
                          <td style={{...S.td, fontWeight:600, color:'rgba(255,255,255,0.85)'}}>{r.label}</td>
                          <td style={{...S.td, textAlign:'right', color:'#f87171'}}>{r.lossRatio != null ? fmt1(r.lossRatio) : '—'}</td>
                          <td style={{...S.td, textAlign:'right', color:'#60a5fa'}}>{r.commission != null ? fmt1(r.commission) : '—'}</td>
                          <td style={{...S.td, textAlign:'right', color: r.result >= 0 ? '#4ade80' : '#f87171', fontWeight:700}}>{r.result != null ? fmt1(r.result) : '—'}</td>
                          <td style={{...S.td, textAlign:'right', color:diffColor(-(dLR??0))}}>{i===0?'Base':diffFmt(dLR)}</td>
                          <td style={{...S.td, textAlign:'right', color:diffColor(dRes??0)}}>{i===0?'Base':diffFmt(dRes)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Key insight from trend */}
              {snapTrends.length >= 2 && (() => {
                const first = snapTrends[0], last = snapTrends[snapTrends.length-1];
                const lrMove = diff(last.lossRatio, first.lossRatio);
                const resMove = diff(last.result, first.result);
                return (
                  <div style={{ padding:'12px 16px', borderRadius:9, background:'rgba(96,165,250,0.07)', border:'1px solid rgba(96,165,250,0.2)', fontSize:12, color:'rgba(255,255,255,0.7)', lineHeight:1.7 }}>
                    <b style={{color:'#60a5fa'}}>Trend insight:</b> Across {snapTrends.length} snapshots, the attritional loss ratio moved {diffFmt(lrMove)} and the underwriting result moved {diffFmt(resMove)}.
                    {resMove > 0 ? ' Pricing has improved through iterations.' : resMove < 0 ? ' Pricing has tightened — review whether loss loadings are adequate.' : ' Pricing has remained stable.'}
                  </div>
                );
              })()}
            </>)}
          </>)}

        </div>
      </div>
    </div>
  );
}
