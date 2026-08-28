// InDepthPortfolioModal.jsx
// Full-screen in-depth component pricing comparison:
// Tab 1: Visual comparison (actuarial vs actual vs market vs UW)
// Tab 2: Gap analysis (spread from market, actuarial adequacy)
// Tab 3: Snapshot history trends
import { useState, useMemo } from 'react';
import { COMPONENT_ROWS } from './propPricingConstants';
import { Badge, Callout, Modal } from '../../../../components/ui';
import './InDepthPortfolioModal.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const rawNum   = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/,/g,'').replace(/%/g,'')); return Number.isFinite(n) ? n : null; };
// Normalize to % display, mirroring propPricingConstants.parsePct: a
// '%'-suffixed string is ALREADY a percent (a 1% Taxes row must not become
// 100.00%); the >1.5 magnitude heuristic applies only to bare numbers.
const toDisplay = v => {
  const n = rawNum(v);
  if (n == null) return null;
  if (typeof v === 'string' && v.includes('%')) return n;
  return n > 1.5 ? n : n * 100;
};
const fmt1    = v => v != null ? v.toFixed(2) + '%' : '—';
const diff    = (a, b) => { if (a == null || b == null) return null; return a - b; };
const diffFmt = v => { if (v == null) return '—'; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; };
// Color value for SVG fills (GapBar); diffClass mirrors it for text via CSS.
const diffColor = v => { if (v == null) return 'rgba(255,255,255,0.35)'; return v > 2 ? '#f87171' : v > 0 ? '#fbbf24' : v < -2 ? '#4ade80' : '#60a5fa'; };
const diffClass = v => { if (v == null) return 'idc-dim'; return v > 2 ? 'idc-red' : v > 0 ? 'idc-amber' : v < -2 ? 'idc-green' : 'idc-blue'; };
const cx = (...xs) => xs.filter(Boolean).join(' ');

// Which components are "loss" (higher = worse) vs "margin" (higher = better)
const IS_COST = new Set(['Attritional Loss Ratio','Large Loss Loading','Cat Loss Loading','Commissions','Brokerage','Taxes','Maximum Commissions (Reinsurer)']);

const COLS = [
  { key: 'actuarial', label: 'Actuarial\n(Engine)',  color: '#60a5fa', cls: 'idc-blue',   short: 'Act.Eng.' },
  { key: 'actual',    label: 'Actual\nStats',        color: '#4ade80', cls: 'idc-green',  short: 'Actual'   },
  { key: 'exposure',  label: 'Exposure\nRating',     color: '#a78bfa', cls: 'idc-violet', short: 'Exposure' },
  { key: 'market',    label: 'Market\nAverage',      color: '#fbbf24', cls: 'idc-amber',  short: 'Market'   },
  { key: 'uw',        label: 'UW\nOverride',         color: '#00e8b8', cls: 'idc-teal',   short: 'UW'       },
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
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid indepth-chart">
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
              fontWeight={isHL ? 700 : 500}>
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
    <svg width={W} height={16} className="indepth-gapbar">
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

  const scoreGrade = s => s >= 80 ? 'good' : s >= 60 ? 'warn' : 'bad';

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

  return (
    <Modal
      open
      onClose={onClose}
      className="indepth-modal"
      title={(<>
        <span className="indepth-head__main">
          🔬 In-Depth Portfolio Analysis
          <span className="indepth-head__sub">
            Actuarial engine · Actual stats · Exposure rating · Market average · UW override — side by side
          </span>
        </span>
        <span className="indepth-head__score">
          <span className="indepth-head__score-label">Actuarial Adherence</span>
          <span className={`indepth-head__score-value is-${scoreGrade(scores.overall)}`}>{scores.overall}/100</span>
        </span>
      </>)}
    >
      {/* ── Tabs ── */}
      <div className="indepth-tabs">
        {TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={cx('indepth-tab', tab === t.key && 'is-active')}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="indepth-content">

        {/* ═══ TAB 1: VISUAL COMPARISON ═══ */}
        {tab === 'compare' && (<>
          {/* Legend */}
          <div className="indepth-legend">
            {COLS.map(c => (
              <div key={c.key} className="indepth-legend__item">
                <div className={cx('indepth-swatch', c.cls)} />{c.short}
              </div>
            ))}
          </div>

          <div className="indepth-card">
            <div className="indepth-card__title">Component Comparison — All Columns (click row to highlight)</div>
            <GroupedBarChart rows={rowData} highlight={highlight} />
          </div>

          {/* Numeric comparison table */}
          <div className="indepth-card">
            <div className="indepth-card__title">Numeric Comparison Table</div>
            <table className="indepth-table indepth-table--click">
              <thead>
                <tr>
                  <th className="ta-l w200">Component</th>
                  {COLS.map(c => <th key={c.key} className={cx('ta-r', c.cls)}>{c.short}</th>)}
                  <th className="ta-r">UW vs Actuarial</th>
                  <th className="ta-r">UW vs Market</th>
                  <th className="ta-r">Signal</th>
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
                  const signal = signalVal > 2 ? { t:'✓ Conservative', tone:'success' }
                    : signalVal < -2 ? { t:'⚠ Aggressive', tone:'danger' }
                    : { t:'≈ In Line', tone:'info' };
                  return (
                    <tr key={i}
                      onClick={() => setHL(highlight === r.name ? null : r.name)}
                      className={highlight === r.name ? 'is-hl' : undefined}>
                      <td className={cx('fw6', highlight === r.name ? 'idc-blue' : 'c-text')}>{r.name}</td>
                      {COLS.map(c => (
                        <td key={c.key} className={cx('ta-r', r[c.key] != null ? c.cls : 'idc-empty', c.key === 'uw' && 'fw7')}>
                          {r[c.key] != null ? fmt1(r[c.key]) : '—'}
                        </td>
                      ))}
                      <td className={cx('ta-r', 'fw6', diffClass(isCost ? -(vsAct??0) : (vsAct??0)))}>{diffFmt(vsAct)}</td>
                      <td className={cx('ta-r', 'fw6', diffClass(isCost ? -(vsMkt??0) : (vsMkt??0)))}>{diffFmt(vsMkt)}</td>
                      <td className="ta-r"><Badge tone={signal.tone}>{signal.t}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>)}

        {/* ═══ TAB 2: GAP ANALYSIS ═══ */}
        {tab === 'gaps' && (<>
          <div className="indepth-card">
            <div className="indepth-card__title">UW Override vs Actuarial, Actual Stats & Market Average</div>
            <div className="indepth-note">
              Bars show how far the UW override deviates from each benchmark. <span className="idc-green">Green = conservative</span>, <span className="idc-red">Red = aggressive</span>.
            </div>
            <table className="indepth-table">
              <thead>
                <tr>
                  <th className="ta-l w200">Component</th>
                  <th className="ta-r">UW</th>
                  <th className="ta-r">Actuarial</th>
                  <th>vs Actuarial</th>
                  <th className="ta-r">Actual Stats</th>
                  <th>vs Actual</th>
                  <th className="ta-r">Market Avg</th>
                  <th>vs Market</th>
                </tr>
              </thead>
              <tbody>
                {gapData.map((r, i) => {
                  const sign = r.isCost ? -1 : 1;
                  return (
                    <tr key={i}>
                      <td className="fw6 c-text">{r.name}</td>
                      <td className="ta-r fw7 idc-teal">{r.uw != null ? fmt1(r.uw) : '—'}</td>
                      <td className="ta-r idc-blue">{r.actuarial != null ? fmt1(r.actuarial) : '—'}</td>
                      <td>
                        <div className="indepth-gapcell">
                          <GapBar value={r.vsActuarial} maxAbs={maxGap} color={diffColor(sign*(r.vsActuarial??0))} />
                          <span className={cx('indepth-gapval', diffClass(sign*(r.vsActuarial??0)))}>{diffFmt(r.vsActuarial)}</span>
                        </div>
                      </td>
                      <td className="ta-r idc-green">{r.actual != null ? fmt1(r.actual) : '—'}</td>
                      <td>
                        <div className="indepth-gapcell">
                          <GapBar value={r.vsActual} maxAbs={maxGap} color={diffColor(sign*(r.vsActual??0))} />
                          <span className={cx('indepth-gapval', diffClass(sign*(r.vsActual??0)))}>{diffFmt(r.vsActual)}</span>
                        </div>
                      </td>
                      <td className="ta-r idc-amber">{r.market != null ? fmt1(r.market) : '—'}</td>
                      <td>
                        <div className="indepth-gapcell">
                          <GapBar value={r.vsMarket} maxAbs={maxGap} color={diffColor(sign*(r.vsMarket??0))} />
                          <span className={cx('indepth-gapval', diffClass(sign*(r.vsMarket??0)))}>{diffFmt(r.vsMarket)}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Insight cards */}
          <div className="indepth-cards">
            {gapData.filter(r => r.vsActuarial != null && Math.abs(r.vsActuarial) > 2).map((r, i) => {
              const sign = r.isCost ? -1 : 1;
              const isAggressive = sign * r.vsActuarial < -2;
              return (
                <Callout key={i} variant={isAggressive ? 'danger' : 'tip'}
                  title={isAggressive ? '⚠ Aggressive' : '✓ Conservative'}
                  className="indepth-insight">
                  <div className="indepth-insight__name">{r.name}</div>
                  <div className="indepth-insight__detail">
                    UW: {fmt1(r.uw??0)} vs Actuarial: {fmt1(r.actuarial??0)} ({diffFmt(r.vsActuarial)})
                  </div>
                </Callout>
              );
            })}
            {gapData.every(r => r.vsActuarial == null || Math.abs(r.vsActuarial) <= 2) && (
              <div className="indepth-allclear">
                ✓ All UW overrides are within 2% of actuarial pricing — no material deviations.
              </div>
            )}
          </div>
        </>)}

        {/* ═══ TAB 3: ADEQUACY SCORE ═══ */}
        {tab === 'radar' && (<>
          <div className="indepth-card">
            <div className="indepth-card__title">Actuarial Adherence by Component</div>
            <div className="indepth-note indepth-note--lg">
              Score 0–100: how closely the UW override tracks the actuarial engine. 100 = exact match. Penalty increases with deviation size.
            </div>
            <div className="indepth-scores">
              <div className="indepth-overall">
                <div className="indepth-overall__label">Overall Score</div>
                <div className={`indepth-overall__value is-${scoreGrade(scores.overall)}`}>{scores.overall}</div>
                <div className="indepth-overall__denom">/ 100</div>
                <div className={`indepth-overall__verdict is-${scoreGrade(scores.overall)}`}>
                  {scores.overall >= 80 ? 'Strong Adherence' : scores.overall >= 60 ? 'Moderate Deviation' : 'High Deviation'}
                </div>
              </div>
              <div className="indepth-scorelist">
                {scores.rows.map((r, i) => (
                  <div key={i} className={`indepth-scorecard is-${scoreGrade(r.score)}`}>
                    <div className="indepth-scorecard__name">{r.name}</div>
                    <div className="indepth-scorebar-row">
                      <div className="indepth-scorebar">
                        <div className="indepth-scorebar__fill" style={{ width: `${r.score}%` }} />
                      </div>
                      <span className="indepth-scoreval">{r.score}</span>
                    </div>
                    {r.actuarial != null && (
                      <div className="indepth-scorecard__foot">
                        <span>UW: {fmt1(r.uwVal??0)}</span>
                        <span>Act: {fmt1(r.actuarial)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* Interpretation */}
            <Callout variant="note" title="How to read this:" className="indepth-howto">
              A score below 60 on any cost component (loss ratio, commissions) means your UW override diverges significantly from the actuarial engine.
              On loss components, a lower UW than actuarial is aggressive (under-pricing risk); on margin/result components, a higher UW is more conservative.
              Deviations beyond 5% from actuarial indicate a meaningful judgement overlay — ensure these are documented with rationale.
            </Callout>
          </div>
        </>)}

        {/* ═══ TAB 4: SNAPSHOT TRENDS ═══ */}
        {tab === 'history' && (<>
          {snapTrends.length === 0 ? (
            <div className="indepth-empty">
              No snapshots saved yet. Use the 📸 Save Snapshot button on the component pricing table to track pricing iterations.
            </div>
          ) : (<>
            <div className="indepth-card">
              <div className="indepth-card__title">Pricing Evolution Across Snapshots</div>
              <table className="indepth-table">
                <thead>
                  <tr>
                    <th className="ta-l">Snapshot</th>
                    <th className="ta-r">Attritional LR</th>
                    <th className="ta-r">Commissions</th>
                    <th className="ta-r">Result</th>
                    <th className="ta-r">LR Δ</th>
                    <th className="ta-r">Result Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {snapTrends.map((r, i) => {
                    const prevLR  = i > 0 ? snapTrends[i-1].lossRatio  : null;
                    const prevRes = i > 0 ? snapTrends[i-1].result     : null;
                    const dLR  = diff(r.lossRatio, prevLR);
                    const dRes = diff(r.result, prevRes);
                    return (
                      <tr key={i}>
                        <td className="fw6 c-text">{r.label}</td>
                        <td className="ta-r idc-red">{r.lossRatio != null ? fmt1(r.lossRatio) : '—'}</td>
                        <td className="ta-r idc-blue">{r.commission != null ? fmt1(r.commission) : '—'}</td>
                        <td className={cx('ta-r', 'fw7', r.result >= 0 ? 'idc-green' : 'idc-red')}>{r.result != null ? fmt1(r.result) : '—'}</td>
                        <td className={cx('ta-r', diffClass(-(dLR??0)))}>{i===0?'Base':diffFmt(dLR)}</td>
                        <td className={cx('ta-r', diffClass(dRes??0))}>{i===0?'Base':diffFmt(dRes)}</td>
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
                <Callout variant="note" title="Trend insight:">
                  Across {snapTrends.length} snapshots, the attritional loss ratio moved {diffFmt(lrMove)} and the underwriting result moved {diffFmt(resMove)}.
                  {resMove > 0 ? ' Pricing has improved through iterations.' : resMove < 0 ? ' Pricing has tightened — review whether loss loadings are adequate.' : ' Pricing has remained stable.'}
                </Callout>
              );
            })()}
          </>)}
        </>)}

      </div>
    </Modal>
  );
}
