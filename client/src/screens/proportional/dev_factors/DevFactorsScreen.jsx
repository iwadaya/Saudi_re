import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import {
  buildMatrixFromCells, calculateAgeToAgeFactors, calculatePattern,
  calculateCdfs, fitExponentialCdfs, deriveLdfsFromCdfs,
} from '../../../logic/chainLadder';
import { calculateBF, calculateBFPremium } from '../../../logic/bornhuetterFerguson';
import { calculateMunichChainLadder } from '../../../logic/munichChainLadder';
import { formatWithCommas as fmtN } from '../../../utils/format';

const TYPE_MAP = {
  PROP_PREMIUM_DEV_FACTORS: 'PREMIUM',
  PROP_PAID_CLAIMS_DEV_FACTORS: 'CLAIMS_PAID',
  PROP_OS_CLAIMS_DEV_FACTORS: 'CLAIMS_OS',
  PROP_INCURRED_DEV_FACTORS: 'INCURRED',
};
const TRIANGLE_SOURCE = {
  PROP_PREMIUM_DEV_FACTORS: ['PREMIUM'],
  PROP_PAID_CLAIMS_DEV_FACTORS: ['CLAIMS_PAID'],
  PROP_OS_CLAIMS_DEV_FACTORS: ['CLAIMS_OS'],
  PROP_INCURRED_DEV_FACTORS: ['CLAIMS_PAID', 'CLAIMS_OS'],
};

const fmt4   = n => (n == null || !Number.isFinite(Number(n))) ? '' : Number(n).toFixed(4);
const fmtPct = n => (n == null || !Number.isFinite(Number(n))) ? '' : (Number(n) * 100).toFixed(1) + '%';

function sameNumberArray(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function serializeChosenSource(source) {
  return source === 'LINK_RATIO' ? 'SELECTED' : source;
}

/* ═══════════════ Factor Table ═══════════════ */
function FactorTable({ pattern, cdfs, editable, onChange, sectionClass }) {
  const N = pattern?.length || 0;
  if (!N) return <div className="muted" style={{ padding: 12 }}>No factors calculated yet.</div>;
  const headers = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);
  return (
    <div className={`df-card ${sectionClass || ''}`}>
      <div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Factor</th>
            {headers.map(h => <th key={h} className="df-h">{h}</th>)}
          </tr></thead>
          <tbody>
            <tr>
              <td className="df-r df-r--sticky">Link Ratio (LDF)</td>
              {(pattern || []).map((v, i) => (
                <td key={i} className="df-c">{editable
                  ? <input className="df-input" value={fmt4(v)} onChange={e => onChange?.('ldf', i, e.target.value)} />
                  : <div className="df-val">{fmt4(v)}</div>}</td>
              ))}
            </tr>
            <tr>
              <td className="df-r df-r--sticky">Cumulative (CDF)</td>
              {(cdfs || []).slice(0, N).map((v, i) => (
                <td key={i} className="df-c">{editable
                  ? <input className="df-input" value={fmt4(v)} onChange={e => onChange?.('cdf', i, e.target.value)} />
                  : <div className="df-val">{fmt4(v)}</div>}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════ BF Projections Table ═══════════════ */
function BFProjectionsTable({ bfResults }) {
  if (!bfResults?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Bornhuetter-Ferguson Projections</div>
        <div className="df-section-sub">Ultimate = Actual + (A Priori × % Unreported)</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th><th className="df-h">Latest</th><th className="df-h">CDF</th>
            <th className="df-h">Premium</th><th className="df-h">IELR</th><th className="df-h">A Priori Ult.</th>
            <th className="df-h">% Unreported</th><th className="df-h">BF IBNR</th><th className="df-h">BF Ultimate</th><th className="df-h">Loss Ratio</th>
          </tr></thead>
          <tbody>{bfResults.map(r => (
            <tr key={r.year}>
              <td className="df-r df-r--sticky">{r.year}</td>
              <td className="df-c"><div className="df-val">{fmtN(r.latest)}</div></td>
              <td className="df-c"><div className="df-val">{fmt4(r.cdf)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.premium)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.ielr)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.aPrioriUltimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.percentUnreported)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.expectedIbnr)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(r.ultimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.lossRatio)}</div></td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>
    </div>
  );
}

/* ═══════════════ BF Premium Projections Table ═══════════════ */
function BFPremiumProjectionsTable({ bfResults, epiPerYear, onEpiChange }) {
  if (!bfResults?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Bornhuetter-Ferguson Projections (Premium)</div>
        <div className="df-section-sub">Ultimate Premium = Current + (EPI × % Achieved × % Unachieved)</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th>
            <th className="df-h">Current Premium</th>
            <th className="df-h">CDF</th>
            <th className="df-h">EPI</th>
            <th className="df-h">% Achieved</th>
            <th className="df-h">A Priori Ult.</th>
            <th className="df-h">% Unachieved</th>
            <th className="df-h">BF Unearned Premium</th>
            <th className="df-h">BF Ultimate Premium</th>
            <th className="df-h">Achieved Ratio</th>
          </tr></thead>
          <tbody>{bfResults.map((r, i) => (
            <tr key={r.year}>
              <td className="df-r df-r--sticky">{r.year}</td>
              <td className="df-c"><div className="df-val">{fmtN(r.latest)}</div></td>
              <td className="df-c"><div className="df-val">{fmt4(r.cdf)}</div></td>
              <td className="df-c">
                <input
                  className="df-input"
                  type="text"
                  value={epiPerYear?.[i] ?? ''}
                  onChange={(e) => onEpiChange?.(i, e.target.value)}
                  placeholder="0"
                />
              </td>
              <td className="df-c"><div className="df-val">{fmtPct(r.percentAchieved)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.aPrioriUltimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.percentUnachieved)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.bfUnearned)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(r.ultimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.achievedRatio)}</div></td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>
    </div>
  );
}

/* ═══════════════ Munich Chain Ladder Projections Table ═══════════════ */
function MclProjectionsTable({ mcl }) {
  if (!mcl?.projections?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Munich Chain Ladder Projections</div>
        <div className="df-section-sub">
          Cell-by-cell link ratios adjusted by current P/I (λ_P = {mcl.lambdaP == null ? '—' : mcl.lambdaP.toFixed(4)},
          λ_I = {mcl.lambdaI == null ? '—' : mcl.lambdaI.toFixed(4)})
        </div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th>
            <th className="df-h">Latest Paid</th>
            <th className="df-h">Latest Incurred</th>
            <th className="df-h">MCL Ult. Paid</th>
            <th className="df-h">MCL Ult. Incurred</th>
            <th className="df-h">IBNR (Paid)</th>
            <th className="df-h">IBNR (Incurred)</th>
            <th className="df-h">Gap (I − P)</th>
          </tr></thead>
          <tbody>{mcl.projections.map(p => (
            <tr key={p.year}>
              <td className="df-r df-r--sticky">{p.year}</td>
              <td className="df-c"><div className="df-val">{fmtN(p.latestPaid)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.latestIncurred)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(p.ultimatePaid)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(p.ultimateIncurred)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.ibnrPaid)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.ibnrIncurred)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.ultimateIncurred - p.ultimatePaid)}</div></td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>
      {mcl.warnings?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#fbbf24' }}>
          {mcl.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
    </div>
  );
}

/* ═══════════════ Link Ratio View with outlier exclusion ═══════════════ */
function LinkRatioView({ matrix, years, numDevYears, excluded, setExcluded, onPatternChange }) {
  // Rules-of-hooks: every hook must run on every render. The old
  // layout had `if (!matrix) return …` before the useEffect below,
  // which made the hook order conditional — lint error. Compute the
  // filtered pattern unconditionally (empty arrays when matrix is
  // missing), run the hook, then branch at render time.
  const factors = useMemo(() => matrix ? calculateAgeToAgeFactors(matrix) : null, [matrix]);
  const N = numDevYears - 1;
  const devHeaders = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);
  const inTriangle = useCallback((r, c) => r + c < N, [N]);

  const toggle = (r, c) => {
    const key = `${r}:${c}`;
    setExcluded(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  };

  const { filteredPattern, filteredCdfs } = useMemo(() => {
    const pattern = [];
    if (matrix && factors) {
      for (let c = 0; c < N; c++) {
        let sumPrev = 0, sumCur = 0;
        for (let r = 0; r < matrix.length; r++) {
          if (!inTriangle(r, c)) continue;
          if (excluded.has(`${r}:${c}`)) continue;
          if (factors[r]?.[c] != null) { sumPrev += matrix[r][c]; sumCur += matrix[r][c + 1]; }
        }
        pattern.push(sumPrev !== 0 ? sumCur / sumPrev : 1.0);
      }
    }
    const cdfs = new Array(pattern.length + 1).fill(1.0);
    for (let i = pattern.length - 1; i >= 0; i--) cdfs[i] = pattern[i] * cdfs[i + 1];
    return { filteredPattern: pattern, filteredCdfs: cdfs.slice(0, pattern.length) };
  }, [excluded, factors, inTriangle, matrix, N]);

  // Notify parent of filtered pattern — hook now runs unconditionally
  useEffect(() => { onPatternChange?.(filteredPattern, filteredCdfs); }, [filteredCdfs, filteredPattern, onPatternChange]);

  if (!matrix) return <div className="muted" style={{ padding: 12 }}>No triangle data. Enter data in triangle screens first.</div>;

  return (
    <div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>Click any link ratio to exclude/include it from weighted average. Excluded cells shown in red strikethrough.</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tri-table">
          <thead><tr><th className="tri-hdr" style={{ minWidth: 52 }}>Year</th>{devHeaders.map(h => <th key={h} className="tri-hdr">{h}</th>)}</tr></thead>
          <tbody>
            {years.map((yr, r) => (
              <tr key={yr}>
                <td className="tri-yr">{yr}</td>
                {Array.from({ length: N }, (_, c) => {
                  const f = inTriangle(r, c) ? factors[r]?.[c] : null;
                  const isExcl = excluded.has(`${r}:${c}`);
                  return (
                    <td key={c} className={f == null ? 'tri-off' : 'tri-cell'} onClick={() => f != null && toggle(r, c)} style={{ cursor: f != null ? 'pointer' : 'default' }}>
                      {f != null && <div className="tri-inp" style={{ textDecoration: isExcl ? 'line-through' : 'none', opacity: isExcl ? 0.35 : 1, color: isExcl ? '#f87171' : 'rgba(226,232,240,0.88)' }}>{fmt4(f)}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid rgba(var(--accent-rgb),0.3)' }}>
              <td className="tri-yr" style={{ color: 'var(--accent)' }}>Weighted</td>
              {filteredPattern.map((v, c) => <td key={c} className="tri-cell"><div className="tri-inp" style={{ fontWeight: 700, color: 'var(--accent)' }}>{fmt4(v)}</div></td>)}
            </tr>
            <tr>
              <td className="tri-yr" style={{ color: 'rgba(255,255,255,0.5)' }}>CDF</td>
              {filteredCdfs.map((v, c) => <td key={c} className="tri-cell"><div className="tri-inp" style={{ color: 'rgba(255,255,255,0.6)' }}>{fmt4(v)}</div></td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════ Comparison Graph (SVG) ═══════════════ */
function ComparisonGraph({ pattern, paramCdfs, benchmarks }) {
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

/* ═══════════════════════════════════════════
   MAIN DevFactorsScreen
   ═══════════════════════════════════════════ */
export default function DevFactorsScreen({ routeKey, title, headerPill }) {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const devType = TYPE_MAP[routeKey] || 'PREMIUM';
  const triSources = useMemo(() => TRIANGLE_SOURCE[routeKey] || ['PREMIUM'], [routeKey]);
  const isIncurred = triSources.length > 1;
  const isPremium = devType === 'PREMIUM';

  const meta = appState.triangleMeta || {};
  const startYear = meta.startYear || 2015;
  const inceptionYear = meta.inceptionYear || meta.renewalYear || new Date().getFullYear();
  const numDevYears = Math.max(1, Math.min(60, inceptionYear - startYear));
  const years = useMemo(() => Array.from({ length: numDevYears }, (_, i) => startYear + i), [numDevYears, startYear]);
  // Quote-mode opts thread through every triangle/dev-factor API call
  // so the wizard can edit a quote's factors without hitting the
  // contract path (which would FK-fail under migration 057).
  const apiOpts = useMemo(
    () => (appState.quoteMode ? { quote: true } : undefined),
    [appState.quoteMode],
  );

  const [view, setView] = useState('DEV_FACTORS'); // DEV_FACTORS | LINK_RATIOS | GRAPH
  const [triCells, setTriCells] = useState({});
  const [projMethod, setProjMethod] = useState('CHAIN');
  const [avgMethod, setAvgMethod] = useState('weighted');
  const [chosenBase, setChosenBase] = useState('ACTUAL');
  const [chosenLdfs, setChosenLdfs] = useState([]);
  const [chosenCdfs, setChosenCdfs] = useState([]);
  const [ielr, setIelr] = useState('0.65');
  const [premiums, setPremiums] = useState([]);
  // Premium-flavoured BF inputs — used when devType === 'PREMIUM'.
  // EPI is the client's start-of-year premium estimate, % Achieved is the
  // ratio of actual to estimated premium (default 100 %).
  const [epiPerYear, setEpiPerYear] = useState([]);
  const [percentAchieved, setPercentAchieved] = useState('1.00');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [excluded, setExcluded] = useState(new Set());
  const [benchmarks, setBenchmarks] = useState(null);
  const [useMunich, setUseMunich] = useState(false);
  const [showMunichHelp, setShowMunichHelp] = useState(false);
  // Both paid + OS triangles are required for Munich Chain Ladder, so on
  // screens that already source both (Incurred Dev Factors) the toggle
  // does meaningful work. On Premium / Paid-only / OS-only screens we
  // still surface the checkbox so the underwriter can see it exists,
  // but mark it disabled and point them at the right screen.
  const munichAvailable = isIncurred;

  /* Clear position-keyed exclusions when the year range changes.
   * Excluded ratios are stored as "row:col" strings, so when startYear or
   * numDevYears shifts the same key reinterprets to a totally different
   * cell — the table keeps a strikethrough on a cell the user never
   * clicked. Drop them whenever the year window moves. The first render
   * is skipped so loaded saved exclusions survive their initial hydration. */
  const yearWindowKeyRef = useRef(null);
  useEffect(() => {
    const key = `${startYear}:${numDevYears}`;
    if (yearWindowKeyRef.current === null) { yearWindowKeyRef.current = key; return; }
    if (yearWindowKeyRef.current !== key) {
      yearWindowKeyRef.current = key;
      setExcluded(new Set());
    }
  }, [startYear, numDevYears]);

  /* Load triangle cells */
  useEffect(() => {
    if (!contractId) { setLoading(false); return; }
    setLoading(true);
    Promise.all(triSources.map(t =>
      api.getTriangle(contractId, t, apiOpts).then(d => [t, d?.cells || (Array.isArray(d) ? d : [])]).catch(() => [t, []])
    )).then(results => { const map = {}; results.forEach(([t, cells]) => { map[t] = cells; }); setTriCells(map); }).finally(() => setLoading(false));
  }, [contractId, apiOpts, triSources]);

  /* Load premium data for BF */
  useEffect(() => {
    if (!contractId) return;
    api.getTriangle(contractId, 'PREMIUM', apiOpts).then(d => {
      const cells = d?.cells || (Array.isArray(d) ? d : []);
      const prems = years.map(yr => { const latest = cells.filter(c => c.origin_year === yr).sort((a, b) => b.dev_months - a.dev_months)[0]; return latest ? Number(latest.cum_value) || 0 : 0; });
      setPremiums(prems);
    }).catch(() => {});
  }, [contractId, startYear, numDevYears, apiOpts, years]);

  /* Load benchmarks */
  useEffect(() => {
    const countryId = appState.propTreatyDetail?.countryId;
    if (!countryId) return;
    api.getBenchmarks(countryId, devType).then(setBenchmarks).catch(() => {});
  }, [appState.propTreatyDetail?.countryId, devType]);

  /* Build matrix + calculations */
  const calcs = useMemo(() => {
    let matrix;
    if (isIncurred) {
      const p = buildMatrixFromCells(triCells['CLAIMS_PAID'] || [], startYear, numDevYears);
      const o = buildMatrixFromCells(triCells['CLAIMS_OS'] || [], startYear, numDevYears);
      if (!p || !o) return null;
      matrix = p.matrix.map((row, r) => row.map((v, c) => { const pv = v ?? 0, ov = o.matrix[r]?.[c] ?? 0; return (v == null && o.matrix[r]?.[c] == null) ? null : pv + ov; }));
    } else {
      const d = buildMatrixFromCells(triCells[triSources[0]] || [], startYear, numDevYears);
      if (!d) return null;
      matrix = d.matrix;
    }
    const factors = calculateAgeToAgeFactors(matrix);
    const { pattern, warnings: patternWarnings } = calculatePattern(matrix, factors, avgMethod);
    const cdfs = calculateCdfs(pattern, 1.0);
    const paramCdfs = fitExponentialCdfs(cdfs);
    const paramLdfs = deriveLdfsFromCdfs(paramCdfs);
    const clProjections = years.map((yr, r) => {
      let latestVal = 0, latestCol = -1;
      for (let c = matrix[r].length - 1; c >= 0; c--) if (matrix[r][c] != null) { latestVal = matrix[r][c]; latestCol = c; break; }
      const cdf = latestCol >= 0 ? (cdfs[latestCol] || 1.0) : 1.0;
      return { year: yr, latest: latestVal, cdf, ultimate: latestVal * cdf, ibnr: latestVal * cdf - latestVal };
    });
    return { matrix, factors, pattern, patternWarnings, cdfs, paramLdfs, paramCdfs, clProjections };
  }, [isIncurred, avgMethod, years, triCells, startYear, numDevYears, triSources]);

  const bfResults = useMemo(() => {
    if (!calcs?.clProjections || projMethod !== 'BF' || isPremium) return null;
    return calculateBF(calcs.clProjections, premiums, Number(ielr) || 0);
  }, [calcs, projMethod, premiums, ielr, isPremium]);

  /* Munich Chain Ladder — needs both paid and incurred matrices.
     We rebuild paid + (paid + OS) here rather than reusing `calcs.matrix`
     because for the Incurred screen `matrix` is already paid+OS, and MCL
     wants the paid leg separately. */
  const mclResult = useMemo(() => {
    if (!useMunich || projMethod !== 'CHAIN' || !munichAvailable) return null;
    const paidObj = buildMatrixFromCells(triCells['CLAIMS_PAID'] || [], startYear, numDevYears);
    const osObj   = buildMatrixFromCells(triCells['CLAIMS_OS']   || [], startYear, numDevYears);
    if (!paidObj || !osObj) return null;
    const incurred = paidObj.matrix.map((row, r) =>
      row.map((v, c) => {
        const p = v, o = osObj.matrix[r]?.[c];
        return (p == null && o == null) ? null : (p ?? 0) + (o ?? 0);
      }),
    );
    return calculateMunichChainLadder({ paid: paidObj.matrix, incurred, years });
  }, [useMunich, projMethod, munichAvailable, triCells, startYear, numDevYears, years]);

  // Comma-tolerant numeric parse for the EPI input cells.
  const parseNum = (v) => {
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/[\s,]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // Keep epiPerYear in sync with the year window. When the window
  // shifts, pad/trim so input cells line up with displayed years.
  useEffect(() => {
    if (!isPremium) return;
    setEpiPerYear((prev) => {
      if (prev.length === years.length) return prev;
      const next = years.map((_, i) => prev[i] ?? '');
      return next;
    });
  }, [isPremium, years, years.length]);

  // Auto-suggest % achieved from observed premium vs EPI across past
  // years that have both an EPI and a current premium > 0. The user
  // can still override via the input — we only seed when the field is
  // still at the 1.00 default.
  const suggestedPercentAchieved = useMemo(() => {
    if (!isPremium) return null;
    const ratios = [];
    for (let i = 0; i < years.length; i++) {
      const epi = parseNum(epiPerYear[i]);
      const cur = premiums[i] || 0;
      if (epi > 0 && cur > 0) ratios.push(cur / epi);
    }
    if (!ratios.length) return null;
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }, [isPremium, years.length, epiPerYear, premiums]);

  const clProjections = calcs?.clProjections;
  const bfPremiumResults = useMemo(() => {
    if (!clProjections || projMethod !== 'BF' || !isPremium) return null;
    const epis = years.map((_, i) => parseNum(epiPerYear[i]));
    const pa = Number(percentAchieved);
    return calculateBFPremium(clProjections, epis, Number.isFinite(pa) ? pa : 1);
  }, [clProjections, projMethod, isPremium, years, percentAchieved, epiPerYear]);

  /* Init chosen — only seed from computed factors when chosenLdfs is
     genuinely empty. The prior `length !== src.ldfs.length` test fired on
     a length mismatch too, which silently overwrote saved underwriter
     overrides whenever the year window had shifted between sessions
     (saved with N=8 → reopened with N=10). Explicit base toggles still
     re-seed via switchBase below, so we only need to populate on the
     initial empty render. */
  useEffect(() => {
    if (!calcs) return;
    if (chosenLdfs.length > 0) return;
    const src = chosenBase === 'PARAM' ? { ldfs: calcs.paramLdfs, cdfs: calcs.paramCdfs } : { ldfs: calcs.pattern, cdfs: calcs.cdfs };
    if (!src.ldfs?.length) return;
    setChosenLdfs(src.ldfs.map(v => v));
    setChosenCdfs((src.cdfs || []).slice(0, src.ldfs.length).map(v => v));
  }, [calcs, chosenBase, chosenLdfs.length]);

  /* Load saved factors */
  useEffect(() => {
    if (!contractId) return;
    api.getDevFactors(contractId, devType, apiOpts).then(data => {
      const factors = data?.factors || (Array.isArray(data) ? data : []);
      if (factors.length > 0) { setChosenLdfs(factors.map(f => f.chosen_ldf ?? f.selected_ldf ?? null)); setChosenCdfs(factors.map(f => f.chosen_cdf ?? f.selected_cdf ?? null)); if (factors[0]?.chosen_source) setChosenBase(factors[0].chosen_source); }
    }).catch(() => {});
    /* Also load pricing pattern to restore excluded ratios + settings */
    api.getPricingPattern(contractId, devType).then(data => {
      if (!data) return;
      const sf = data.selected_factors || {};
      if (Array.isArray(sf.excluded_ratios) && sf.excluded_ratios.length > 0) {
        // Position-keyed ("r:c") exclusions are only valid for the year
        // window they were saved under. If the user has since shifted the
        // start year or the number of dev years, those keys would silently
        // strike through different cells. Drop them in that case.
        const currentKey = `${startYear}:${numDevYears}`;
        if (!sf.excluded_for_year_window || sf.excluded_for_year_window === currentKey) {
          setExcluded(new Set(sf.excluded_ratios));
        }
      }
      if (sf.proj_method) setProjMethod(sf.proj_method);
      if (sf.chosen_base) setChosenBase(sf.chosen_base);
      if (typeof sf.use_munich === 'boolean') setUseMunich(sf.use_munich);
      if (data.selection_method) setAvgMethod(data.selection_method.toLowerCase());
      if (data.bf_ielr != null && Number(data.bf_ielr) > 0) setIelr(String(data.bf_ielr));
      if (sf.bf_percent_achieved != null) setPercentAchieved(String(sf.bf_percent_achieved));
      if (Array.isArray(sf.bf_epi_per_year) && sf.bf_epi_per_year.length > 0) {
        setEpiPerYear(sf.bf_epi_per_year.map(v => v == null ? '' : String(v)));
      }
    }).catch(() => {});
  }, [contractId, devType, apiOpts, startYear, numDevYears]);

  const handleChosenChange = (type, idx, val) => {
    const n = val === '' ? null : Number(val);
    if (type === 'ldf') setChosenLdfs(prev => { const a = [...prev]; a[idx] = Number.isFinite(n) ? n : prev[idx]; return a; });
    else setChosenCdfs(prev => { const a = [...prev]; a[idx] = Number.isFinite(n) ? n : prev[idx]; return a; });
    setDirty(true);
  };

  const switchBase = (base) => {
    if (base === 'LINK_RATIO') return; // Link ratio base is set only from the Link Ratios tab
    setChosenBase(base);
    if (!calcs) return;
    const src = base === 'PARAM' ? { ldfs: calcs.paramLdfs, cdfs: calcs.paramCdfs } : { ldfs: calcs.pattern, cdfs: calcs.cdfs };
    setChosenLdfs((src.ldfs || []).map(v => v)); setChosenCdfs((src.cdfs || []).slice(0, src.ldfs?.length || 0).map(v => v)); setDirty(true);
  };

  const handleLinkRatioExcludedChange = useCallback((value) => {
    setExcluded(value);
    setDirty(true);
  }, []);

  const applyLinkRatioPattern = useCallback((filteredLdfs, filteredCdfs) => {
    setChosenLdfs(prev => sameNumberArray(prev, filteredLdfs) ? prev : filteredLdfs.map(v => v));
    setChosenCdfs(prev => sameNumberArray(prev, filteredCdfs) ? prev : filteredCdfs.map(v => v));
    setChosenBase(prev => prev === 'LINK_RATIO' ? prev : 'LINK_RATIO');
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!contractId) return false;
    /* Skip the server round-trip when the user hasn't actually edited
       anything on this screen — otherwise every Back/Next click rewrites
       contract_dev_factor + contract_pricing_patterns and stamps an audit
       row, even when the on-screen factors are unchanged from the saved
       values. Mirrors the same dirty-gate TriangleScreen and useScreenSave
       use. */
    if (!dirty) return true;
    const N = chosenLdfs.length;
    const factors = Array.from({ length: N }, (_, i) => ({
      dev_month: (i + 1) * 12, actual_ldf: calcs?.pattern?.[i] ?? null, actual_cdf: calcs?.cdfs?.[i] ?? null,
      parametrized_ldf: calcs?.paramLdfs?.[i] ?? null, parametrized_cdf: calcs?.paramCdfs?.[i] ?? null,
      chosen_source: serializeChosenSource(chosenBase), chosen_ldf: chosenLdfs[i] ?? null, chosen_cdf: chosenCdfs[i] ?? null,
      selected_ldf: chosenLdfs[i] ?? null, selected_cdf: chosenCdfs[i] ?? null,
    }));
    await api.saveDevFactors(contractId, devType, { factors, method: avgMethod, tail_factor: 1.0 }, apiOpts);
    // Pricing-pattern is contract-only on the server. In quote mode we
    // skip it rather than 404 — the dev factors themselves still save.
    if (!appState.quoteMode) {
      await api.savePricingPattern(contractId, devType, {
        selection_method: avgMethod.toUpperCase(), tail_factor: 1.0, bf_ielr: Number(ielr) || 0,
        selected_factors: {
          chosen_ldfs: chosenLdfs, chosen_cdfs: chosenCdfs, chosen_base: chosenBase,
          proj_method: projMethod, excluded_ratios: [...excluded],
          use_munich: !!useMunich,
          // Year window the position-keyed exclusions are valid for.
          excluded_for_year_window: `${startYear}:${numDevYears}`,
          ...(isPremium ? {
            bf_percent_achieved: Number(percentAchieved) || 1,
            bf_epi_per_year: years.map((_, i) => parseNum(epiPerYear[i])),
          } : {}),
        },
      });
    }
    setDirty(false);
    return true;
  }, [contractId, dirty, chosenLdfs, devType, avgMethod, apiOpts, appState.quoteMode, calcs?.pattern, calcs?.cdfs, calcs?.paramLdfs, calcs?.paramCdfs, chosenBase, chosenCdfs, ielr, projMethod, excluded, useMunich, startYear, numDevYears, isPremium, percentAchieved, years, epiPerYear]);

  const hasData = calcs && calcs.pattern?.length > 0;

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={save} onBeforeBack={save}>
      {({ showToast }) => (
        <div className="DEV_FACTORS_PAGE">
          {/* Meta bar */}
          <div className="df-toprow">
            <div className="df-controls">
              <div className="df-mini"><div className="df-mini-label">Start Year</div><div className="df-mini-value">{startYear}</div></div>
              <div className="df-mini"><div className="df-mini-label">Inception Year</div><div className="df-mini-value">{inceptionYear}</div></div>
              <div className="df-mini"><div className="df-mini-label">Dev Years</div><div className="df-mini-value">{numDevYears}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="df-method">
                <div className="df-method-label">Projection</div>
                <div className="toggle-group df-method-toggle">
                  <span className={`toggle-option${projMethod === 'CHAIN' ? ' active' : ''}`} onClick={() => { setProjMethod('CHAIN'); setDirty(true); }}>Chain Ladder</span>
                  <span className={`toggle-option${projMethod === 'BF' ? ' active' : ''}`} onClick={() => { setProjMethod('BF'); setDirty(true); }}>Bornhuetter-Ferguson</span>
                </div>
              </div>
            </div>
          </div>

          {/* Munich Chain Ladder toggle — only meaningful while Chain Ladder
              is the active projection method. */}
          {projMethod === 'CHAIN' && (
            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                margin: '8px 0 12px', padding: '10px 14px', borderRadius: 12,
                background: 'rgba(56,189,248,0.06)',
                border: '1px solid rgba(56,189,248,0.20)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label
                  title={munichAvailable
                    ? 'Run the Munich Chain Ladder using paid + incurred (paid + OS) triangles.'
                    : 'Munich Chain Ladder needs both Paid and OS Claims triangles. Open the Incurred Development Factors screen to use it.'}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    cursor: munichAvailable ? 'pointer' : 'not-allowed',
                    opacity: munichAvailable ? 1 : 0.55,
                    fontSize: 13, color: '#bae6fd', fontWeight: 600,
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={!munichAvailable}
                    checked={!!useMunich && munichAvailable}
                    onChange={(e) => { setUseMunich(e.target.checked); setDirty(true); }}
                  />
                  Use Munich Chain Ladder
                </label>
                <button
                  type="button"
                  onClick={() => setShowMunichHelp(s => !s)}
                  style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 6,
                    cursor: 'pointer', border: '1px solid rgba(56,189,248,0.35)',
                    background: 'rgba(56,189,248,0.08)', color: '#bae6fd',
                  }}
                >
                  {showMunichHelp ? 'Hide info' : 'When to use this?'}
                </button>
                {!munichAvailable && (
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                    Available on the Incurred Development Factors screen.
                  </span>
                )}
              </div>
              {showMunichHelp && (
                <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(226,232,240,0.85)' }}>
                  <b style={{ color: '#bae6fd' }}>What it does.</b>{' '}
                  Munich Chain Ladder (Quarg & Mack, 2004) extends the standard chain ladder by
                  using the correlation between paid/incurred (P/I) ratios and the link ratios.
                  Each step's link ratio is adjusted upward when paid is currently below the
                  P/I average for the column, and downward when paid is above — and symmetrically
                  for incurred. The two correlation slopes λ_P and λ_I are estimated once from
                  Pearson residuals on the historical triangle.
                  <br /><br />
                  <b style={{ color: '#bae6fd' }}>When to use it.</b>{' '}
                  Reach for MCL when:
                  <ul style={{ margin: '4px 0 4px 18px' }}>
                    <li>The paid-only and incurred-only chain-ladder ultimates persistently disagree.</li>
                    <li>You have enough history (≥ 3 origin years × ≥ 3 dev periods) for residuals to be meaningful.</li>
                    <li>The book has a stable case-reserving philosophy — MCL assumes the P/I relationship is informative.</li>
                  </ul>
                  <b style={{ color: '#bae6fd' }}>When to avoid it.</b>{' '}
                  Skip MCL on very thin triangles, on lines where case reserves swing wildly
                  (the residual correlation becomes noise rather than signal), or when paid and
                  incurred ultimates already agree — vanilla CL is simpler and as accurate.
                  {mclResult && (
                    <>
                      <br /><br />
                      <b style={{ color: '#bae6fd' }}>This triangle:</b>{' '}
                      λ_P = {mclResult.lambdaP == null ? '—' : mclResult.lambdaP.toFixed(4)},
                      {' '}λ_I = {mclResult.lambdaI == null ? '—' : mclResult.lambdaI.toFixed(4)}.
                      {mclResult.warnings?.length > 0 && (
                        <span style={{ color: '#fbbf24' }}> {mclResult.warnings.join(' ')}</span>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* BF IELR (loss BF) */}
          {projMethod === 'BF' && !isPremium && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '12px 0', padding: '10px 16px', borderRadius: 14, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)' }}>
              <label style={{ fontSize: 12, color: 'rgba(253,186,116,0.9)', fontWeight: 600 }}>Initial Expected Loss Ratio (IELR)</label>
              <input className="fi" type="number" min="0" max="2" step="0.01" value={ielr} onChange={e => { setIelr(e.target.value); setDirty(true); }} style={{ width: 100, textAlign: 'center', borderColor: 'rgba(249,115,22,0.4)' }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{(Number(ielr) * 100 || 0).toFixed(0)}%</span>
            </div>
          )}

          {/* BF % Achieved Premium (premium BF) */}
          {projMethod === 'BF' && isPremium && (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '12px 0', padding: '10px 16px', borderRadius: 14, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.20)', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'rgba(199,210,254,0.9)', fontWeight: 600 }}>% Achieved Premium</label>
              <input
                className="fi"
                type="number"
                min="0"
                max="3"
                step="0.01"
                value={percentAchieved}
                onChange={(e) => { setPercentAchieved(e.target.value); setDirty(true); }}
                style={{ width: 100, textAlign: 'center', borderColor: 'rgba(99,102,241,0.4)' }}
              />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
                {(Number(percentAchieved) * 100 || 0).toFixed(0)}%
              </span>
              {suggestedPercentAchieved != null && (
                <button
                  type="button"
                  onClick={() => { setPercentAchieved(suggestedPercentAchieved.toFixed(4)); setDirty(true); }}
                  style={{
                    marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6,
                    cursor: 'pointer', border: '1px solid rgba(99,102,241,0.4)',
                    background: 'rgba(99,102,241,0.10)', color: '#c7d2fe',
                  }}
                  title="Average of (current premium ÷ EPI) across years where both are positive"
                >
                  Use observed avg ({(suggestedPercentAchieved * 100).toFixed(1)}%)
                </button>
              )}
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', flexBasis: '100%' }}>
                Average over past years; default 100 %. &gt;100 % means past premium overachieved budget, &lt;100 % means underachieved.
              </span>
            </div>
          )}

          {/* ── VIEW TOGGLE ── */}
          <div style={{ marginBottom: 14, marginTop: 8 }}>
            <div className="toggle-group" style={{ display: 'inline-flex' }}>
              {[['DEV_FACTORS', '📊 Development Factors'], ['LINK_RATIOS', '🔗 Link Ratios'], ['GRAPH', '📈 Comparison Graph']].map(([key, label]) => (
                <span key={key} className={`toggle-option${view === key ? ' active' : ''}`} onClick={() => setView(key)} style={{ fontSize: 12, padding: '8px 16px' }}>{label}</span>
              ))}
            </div>
          </div>

          {loading ? <div className="muted" style={{ padding: 16 }}>Loading triangle data…</div> : !hasData ? (
            <div className="df-card df-card--notice" style={{ marginTop: 14 }}>
              <div className="df-note">No triangle data found. Enter data in the triangle screens first, then return here.</div>
            </div>
          ) : (<>

            {/* Thin-column LDF warnings — surfaced from calculatePattern.
                A column whose LDF derives from fewer than 3 origin years
                is one or two observations dressed up as a portfolio
                average. Show the underwriter before they pick a base. */}
            {Array.isArray(calcs?.patternWarnings) && calcs.patternWarnings.length > 0 && (
              <div
                role="alert"
                style={{
                  marginTop: 14,
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: 'rgba(251,146,60,0.08)',
                  border: '1px solid rgba(251,146,60,0.30)',
                  color: '#fbbf24',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  ⚠ Thin LDF columns ({calcs.patternWarnings.length})
                </div>
                {calcs.patternWarnings.map((w) => (
                  <div key={w.column} style={{ opacity: 0.9 }}>
                    {w.devPeriod} — {w.contributingRows} origin year{w.contributingRows === 1 ? '' : 's'} (recommended ≥ 3)
                  </div>
                ))}
              </div>
            )}

            {/* ═══ DEV FACTORS VIEW ═══ */}
            {view === 'DEV_FACTORS' && (<>
              {/* Average method */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Average</span>
                <div className="toggle-group">
                  {['weighted', 'simple', 'last3', 'last5'].map(m => (
                    <span key={m} className={`toggle-option${avgMethod === m ? ' active' : ''}`} onClick={() => { setAvgMethod(m); setDirty(true); }}>
                      {m === 'weighted' ? 'Weighted' : m === 'simple' ? 'Simple' : m === 'last3' ? 'Last 3' : 'Last 5'}
                    </span>
                  ))}
                </div>
              </div>

              {/* Actual */}
              <div className="df-section">
                <div className="df-section-head"><div className="df-section-title">Actual Development Factors</div><div className="df-section-sub">Derived from triangle data ({avgMethod})</div></div>
                <FactorTable pattern={calcs.pattern} cdfs={calcs.cdfs} />
              </div>

              {/* Parametrized */}
              <div className="df-section df-section--parametrized">
                <div className="df-section-head"><div className="df-section-title">Parametrized Development Factors</div><div className="df-section-sub">Exponential fit to cumulative development</div></div>
                <FactorTable pattern={calcs.paramLdfs} cdfs={calcs.paramCdfs} sectionClass="df-card--param" />
              </div>

              {/* Munich Chain Ladder projections (Chain Ladder mode + checkbox on) */}
              {projMethod === 'CHAIN' && useMunich && mclResult && (
                <MclProjectionsTable mcl={mclResult} />
              )}

              {/* BF */}
              {projMethod === 'BF' && !isPremium && bfResults && <BFProjectionsTable bfResults={bfResults} />}
              {projMethod === 'BF' && isPremium && bfPremiumResults && (
                <BFPremiumProjectionsTable
                  bfResults={bfPremiumResults}
                  epiPerYear={epiPerYear}
                  onEpiChange={(i, v) => {
                    setEpiPerYear((prev) => { const a = [...prev]; a[i] = v; return a; });
                    setDirty(true);
                  }}
                />
              )}

              {/* Underwriter Chosen */}
              <div className="df-section df-section--underwriter">
                <div className="df-section-head"><div className="df-section-title">Underwriter Chosen Factors</div></div>
                <div className="df-chosen-controls">
                  <div className="df-chosen-left">
                    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Chosen factors base</div>
                    <div className="toggle-group df-chosen-toggle">
                      <span className={`toggle-option${chosenBase === 'ACTUAL' ? ' active' : ''}`} onClick={() => switchBase('ACTUAL')}>ACTUAL</span>
                      <span className={`toggle-option${chosenBase === 'PARAM' ? ' active' : ''}`} onClick={() => switchBase('PARAM')}>PARAMETRIZED</span>
                      <span className={`toggle-option${chosenBase === 'LINK_RATIO' ? ' active' : ''}`} onClick={() => {/* read-only — set from Link Ratios tab */}} style={chosenBase === 'LINK_RATIO' ? {} : { opacity: 0.35 }}>LINK RATIOS</span>
                    </div>
                  </div>
                  <div className="df-chosen-right">
                    <button className="orange-gloss-btn" onClick={async () => {
                      try { await save(); showToast?.('Dev factors saved'); }
                      catch (e) { showToast?.(`Save failed: ${e?.message || 'server error'}`); }
                    }}>💾 Save Factors</button>
                  </div>
                </div>
                <FactorTable pattern={chosenLdfs} cdfs={chosenCdfs} editable onChange={handleChosenChange} sectionClass="df-card--chosen" />
              </div>
            </>)}

            {/* ═══ LINK RATIOS VIEW ═══ */}
            {view === 'LINK_RATIOS' && (<>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 8, padding: '8px 14px', borderRadius: 10, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.15)' }}>
                Excluding link ratios here will <b style={{ color: '#fb923c' }}>override</b> the Underwriter Chosen Factors with the recalculated weighted averages.
              </div>
              <LinkRatioView
                matrix={calcs.matrix}
                years={years}
                numDevYears={numDevYears}
                excluded={excluded}
                setExcluded={handleLinkRatioExcludedChange}
                onPatternChange={applyLinkRatioPattern}
              />
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="orange-gloss-btn" onClick={async () => {
                  try { await save(); showToast?.('Link ratio factors saved'); }
                  catch (e) { showToast?.(`Save failed: ${e?.message || 'server error'}`); }
                }}>💾 Save Link Ratio Factors</button>
                {excluded.size > 0 && <span style={{ fontSize: 11, color: 'rgba(248,113,113,0.8)' }}>{excluded.size} ratio(s) excluded</span>}
                {dirty && <span className="muted">Unsaved changes</span>}
              </div>
            </>)}

            {/* ═══ GRAPH VIEW ═══ */}
            {view === 'GRAPH' && (
              <ComparisonGraph pattern={calcs.pattern} paramCdfs={calcs.paramCdfs} benchmarks={benchmarks} />
            )}

          </>)}
        </div>
      )}
    </WizardLayout>
  );
}
