// components/SeverityFitPanel.jsx
//
// One scope (risk / cat) of the Pricing Analysis "Pareto Simulation" tab.
// Fits a heavy-tail severity to the scope's large/cat losses and lets the
// underwriter interrogate + override the fit:
//
//   • Threshold input (seeds from the loss-selection snapshot).
//   • Losses are developed to ultimate (incurred = paid + OS) and trended to
//     the prospective year (× inflation_factor) BEFORE fitting — the fit runs
//     on prospective-ultimate severities, never raw paid.
//   • Family selector GPD (default) / Pareto / Lognormal; fitted params are
//     EDITABLE fields seeded from the fit. Any edit re-prices the scope's
//     Pareto column for every active layer (debounced).
//   • Diagnostics (recharts): mean-excess plot (defend the threshold), log-log
//     survival (a straight tail = honest Pareto/GPD fit), Q-Q plot, and a
//     Kolmogorov–Smirnov goodness-of-fit stat.
//   • Bootstrap confidence intervals sit beside every fitted value so small-
//     sample estimation uncertainty is always visible.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ResponsiveContainer, ScatterChart, LineChart,
  Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { api } from '../../../../api';
import { toN } from '../formatters.js';
import { QUOTE_COMPONENT_SCOPES } from '../fqQuoteMath.js';
import {
  fitSeverityWithCI, severityLayerMean,
  buildMeanExcess, buildSurvivalLogLog, buildQQ, ksStatistic,
} from '../paretoMonteCarlo.js';

const FAMILIES = [{ k: 'GPD', label: 'GPD' }, { k: 'PARETO', label: 'Pareto' }, { k: 'LOGNORMAL', label: 'Lognormal' }];
const FAMILY_PARAMS = {
  GPD: [{ key: 'xi', label: 'ξ shape' }, { key: 'sigma', label: 'σ scale' }],
  PARETO: [{ key: 'alpha', label: 'α tail index' }],
  LOGNORMAL: [{ key: 'mu', label: 'μ log-mean' }, { key: 'sigma', label: 'σ log-sd' }],
};

// Develop to ultimate (incurred = paid + OS), then trend to the prospective
// year via inflation_factor; fall back to a pre-inflated incurred if present.
function prospectiveUltimate(l) {
  const paidOs = toN(l.paid) + toN(l.os);
  const base = paidOs > 0 ? paidOs : toN(l.incurred);
  const inf = toN(l.inflation_factor);
  if (inf > 0) return base * inf;
  const infl = toN(l.inflated_incurred);
  return infl > 0 ? infl : base;
}

const fmtParam = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(5))) : '—');
const fmtCompact = (v) => {
  const n = Math.abs(v);
  if (n >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};
const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
};

export default function SeverityFitPanel({ scopeKey, structure, sIdx, contractId, isQuote, updateClientStructureLayer, onFitChange }) {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  const accent = scope.color;
  const lossType = scopeKey === 'risk' ? 'large' : 'cat';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [severities, setSeverities] = useState([]);
  const [years, setYears] = useState(0);
  const [threshold, setThreshold] = useState('');
  const [family, setFamily] = useState('GPD');
  const [params, setParams] = useState(null);          // editable string map, seeded from the fit
  const touchedRef = useRef(false);                    // re-price only after a user edit
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // ── Fetch + prepare losses for this scope ──
  useEffect(() => {
    if (!contractId) { setLoading(false); return undefined; }
    let cancelled = false;
    const opts = isQuote ? { quote: true } : undefined;
    setLoading(true);
    setError('');
    const lossReq = scopeKey === 'risk' ? api.getLargeLosses(contractId, opts) : api.getCatLosses(contractId, opts);
    Promise.all([
      lossReq.catch(() => ({ losses: [] })),
      api.getLossSelectionLatest(contractId, lossType, opts).catch(() => ({ snapshot: null })),
    ]).then(([bundle, sel]) => {
      if (cancelled || !mountedRef.current) return;
      const rows = (bundle?.losses || []).filter((l) => l?.is_selected !== false);
      const sev = rows.map(prospectiveUltimate).filter((x) => x > 0).sort((a, b) => a - b);
      const snap = sel?.snapshot || {};
      const obsYears = toN(snap.observation_years) || new Set(rows.map((l) => l.uw_year).filter((y) => y != null)).size || 0;
      const defThr = toN(snap.threshold) || toN(snap.pareto_xm) || percentile(sev, 0.25);
      setSeverities(sev);
      setYears(obsYears);
      touchedRef.current = false;                        // a fresh dataset is not a user edit
      setThreshold(defThr > 0 ? String(Math.round(defThr)) : '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [contractId, scopeKey, lossType, isQuote]);

  // ── Fit (bootstrap CI) whenever losses / threshold / family change ──
  const fit = useMemo(() => {
    if (!severities.length || !(toN(threshold) > 0)) return null;
    return fitSeverityWithCI(family, severities, threshold, { bootstrap: 400, seed: 12345 });
  }, [severities, threshold, family]);

  // Reseed the editable params from each fresh fit (drops prior manual edits).
  useEffect(() => {
    if (!fit) { setParams(null); return; }
    const seeded = {};
    for (const { key } of FAMILY_PARAMS[family]) seeded[key] = fmtParam(fit.params[key]);
    setParams(seeded);
  }, [fit, family]);

  // Numeric view of the editable params for the math/plots.
  const pNum = useMemo(() => {
    if (!params) return null;
    const out = { xm: toN(threshold) };
    for (const { key } of FAMILY_PARAMS[family]) out[key] = toN(params[key]);
    return out;
  }, [params, family, threshold]);

  // ── Live re-price: write the scope's Pareto ROL for every active layer ──
  const reprice = useCallback((p) => {
    const thr = toN(threshold);
    if (!p || !(thr > 0)) return;
    const n = severities.filter((x) => x >= thr).length;
    const lambda = years > 0 ? n / years : 0;
    (structure?.layers || []).forEach((layer, lIdx) => {
      if (!layer[scopeKey]) return;
      const limit = toN(layer.limit);
      if (limit <= 0) return;
      const expLoss = lambda * severityLayerMean(family, p, thr, toN(layer.attachment), limit);
      const rol = (expLoss / limit) * 100;
      updateClientStructureLayer(sIdx, lIdx, scope.fields.pareto, rol > 0 ? String(Number(rol.toFixed(4))) : '');
    });
  }, [threshold, severities, years, structure, scopeKey, family, sIdx, updateClientStructureLayer, scope.fields.pareto]);

  useEffect(() => {
    if (!touchedRef.current || !pNum) return undefined;
    const id = setTimeout(() => reprice(pNum), 400);   // debounce keystrokes
    return () => clearTimeout(id);
  }, [pNum, reprice]);

  // ── Diagnostics (recompute as the fit / overrides change) ──
  const diag = useMemo(() => {
    if (!pNum || !severities.length) return null;
    const thr = toN(threshold);
    return {
      meanExcess: buildMeanExcess(severities),
      survival: buildSurvivalLogLog(severities, family, pNum, thr),
      qq: buildQQ(severities, family, pNum, thr),
      ks: ksStatistic(severities, family, pNum, thr),
    };
  }, [pNum, severities, threshold, family]);

  // Publish the fit inputs upward so the FrequencySimPanel can run the
  // Monte-Carlo off the same losses / threshold / family the user sees here.
  useEffect(() => {
    if (typeof onFitChange !== 'function') return;
    onFitChange({ scopeKey, family, threshold: toN(threshold), severities, years, n: fit?.n ?? 0 });
  }, [onFitChange, scopeKey, family, threshold, severities, years, fit]);

  const onThreshold = (v) => { touchedRef.current = true; setThreshold(v.replace(/[^0-9.]/g, '')); };
  const onFamily = (k) => { touchedRef.current = true; setFamily(k); };
  const onParam = (key, v) => { touchedRef.current = true; setParams((prev) => ({ ...prev, [key]: v.replace(/[^0-9.eE+-]/g, '') })); };

  // ── Styling helpers ──
  const card = { background: 'rgba(8,14,30,0.72)', border: `1px solid ${accent}35`, borderRadius: 12 };
  const label = { fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.7)' };
  const chartTitle = { fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.78)', marginBottom: 4 };
  const axisTick = { fontSize: 9, fill: 'rgba(148,163,184,0.7)' };
  const grid = 'rgba(255,255,255,0.07)';
  const tooltipStyle = { background: '#0b1526', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, fontSize: 11 };

  return (
    <section data-testid={`fq-severity-panel-${scopeKey}`} style={card}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: accent }}>{scope.label} Severity Fit</div>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
            Prospective-ultimate severities (developed + trended), fit above the threshold.
          </div>
        </div>
        {!loading && (
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.7)', fontWeight: 700 }}>
            {severities.length} loss{severities.length === 1 ? '' : 'es'} · {years || '—'} yr{years === 1 ? '' : 's'}
          </div>
        )}
      </div>

      {loading && (
        <div data-testid={`fq-severity-loading-${scopeKey}`} style={{ padding: '20px 14px', fontSize: 11, color: 'rgba(148,163,184,0.75)' }}>Loading losses…</div>
      )}
      {!loading && error && (
        <div style={{ padding: '16px 14px', fontSize: 11, color: '#f87171' }}>{error}</div>
      )}
      {!loading && !error && severities.length === 0 && (
        <div data-testid={`fq-severity-empty-${scopeKey}`} style={{ padding: '18px 14px', fontSize: 12, color: 'rgba(148,163,184,0.78)' }}>
          No {scopeKey === 'risk' ? 'large' : 'cat'} losses saved for this contract — add them on the earlier NP loss steps to fit a severity curve.
        </div>
      )}

      {!loading && !error && severities.length > 0 && (
        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ── Controls: threshold · family · editable params + CI ── */}
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>Threshold</span>
              <input
                type="text" inputMode="decimal" data-testid={`fq-severity-threshold-${scopeKey}`}
                aria-label={`${scope.label} severity threshold`}
                value={threshold} onChange={(e) => onThreshold(e.target.value)}
                style={{ width: 130, boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: `1px solid ${accent}55`, borderRadius: 6, color: '#e2e8f0', fontSize: 12, fontWeight: 700, padding: '6px 9px', textAlign: 'right', fontFamily: 'inherit' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>Family</span>
              <select
                data-testid={`fq-severity-family-${scopeKey}`} aria-label={`${scope.label} severity family`}
                value={family} onChange={(e) => onFamily(e.target.value)}
                style={{ width: 130, boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 6, color: '#e2e8f0', fontSize: 12, fontWeight: 700, padding: '6px 9px', fontFamily: 'inherit', cursor: 'pointer' }}
              >
                {FAMILIES.map((fam) => <option key={fam.k} value={fam.k}>{fam.label}</option>)}
              </select>
            </div>
            {FAMILY_PARAMS[family].map(({ key, label: plabel }) => {
              const ci = fit?.ci?.[key];
              return (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={label}>{plabel}</span>
                  <input
                    type="text" inputMode="decimal" data-testid={`fq-severity-param-${scopeKey}-${key}`}
                    aria-label={`${scope.label} severity ${plabel}`}
                    value={params?.[key] ?? ''} onChange={(e) => onParam(key, e.target.value)}
                    style={{ width: 100, boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: `1px solid ${accent}55`, borderRadius: 6, color: '#e2e8f0', fontSize: 12, fontWeight: 700, padding: '6px 9px', textAlign: 'right', fontFamily: 'inherit' }}
                  />
                  <span data-testid={`fq-severity-ci-${scopeKey}-${key}`} style={{ fontSize: 9, color: 'rgba(148,163,184,0.65)' }}>
                    95% CI {ci ? `[${fmtParam(ci[0])}, ${fmtParam(ci[1])}]` : '—'}
                  </span>
                </div>
              );
            })}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>K–S GoF</span>
              <span data-testid={`fq-severity-ks-${scopeKey}`} style={{ fontSize: 13, fontWeight: 850, color: accent, padding: '4px 0' }}>
                {diag && Number.isFinite(diag.ks.d) ? diag.ks.d.toFixed(3) : '—'}
              </span>
            </div>
          </div>

          {fit?.warnings?.length > 0 && (
            <div style={{ fontSize: 10, color: 'rgba(251,191,36,0.95)', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.28)', borderRadius: 6, padding: '6px 10px' }}>
              {fit.warnings.join(' · ')}
            </div>
          )}

          {/* ── Diagnostic plots ── */}
          {diag && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
              {/* Mean-excess — defend the threshold (linear above a good one). */}
              <div>
                <div style={chartTitle}>Mean-Excess (threshold check)</div>
                <ResponsiveContainer width="100%" height={190}>
                  <LineChart data={diag.meanExcess} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={grid} />
                    <XAxis type="number" dataKey="u" tick={axisTick} tickFormatter={fmtCompact} stroke={grid} />
                    <YAxis type="number" tick={axisTick} tickFormatter={fmtCompact} stroke={grid} width={44} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtCompact(Number(v))} labelFormatter={(v) => `u = ${fmtCompact(Number(v))}`} />
                    {toN(threshold) > 0 && <ReferenceLine x={toN(threshold)} stroke={accent} strokeDasharray="4 3" />}
                    <Line type="monotone" dataKey="e" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Log-log survival — a straight tail = honest Pareto/GPD fit. */}
              <div>
                <div style={chartTitle}>Survival (log-log)</div>
                <ResponsiveContainer width="100%" height={190}>
                  <ScatterChart margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={grid} />
                    <XAxis type="number" dataKey="x" scale="log" domain={['auto', 'auto']} allowDataOverflow tick={axisTick} tickFormatter={fmtCompact} stroke={grid} />
                    <YAxis type="number" dataKey="s" scale="log" domain={['auto', 'auto']} allowDataOverflow tick={axisTick} tickFormatter={(v) => Number(v).toExponential(0)} stroke={grid} width={48} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => (name === 's' ? Number(v).toExponential(2) : fmtCompact(Number(v)))} />
                    {/* Empirical tail points + the fitted survival drawn as a connecting line. */}
                    <Scatter name="empirical" data={diag.survival.empirical} fill={accent} fillOpacity={0.7} isAnimationActive={false} />
                    <Scatter name="fitted" data={diag.survival.fitted} fill="#f59e0b" line={{ stroke: '#f59e0b', strokeWidth: 2 }} shape={(p) => <circle cx={p.cx} cy={p.cy} r={1} fill="#f59e0b" />} isAnimationActive={false} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>

              {/* Q-Q — points hug y = x on a good fit. */}
              <div>
                <div style={chartTitle}>Q-Q (fitted vs empirical)</div>
                <ResponsiveContainer width="100%" height={190}>
                  <ScatterChart margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke={grid} />
                    <XAxis type="number" dataKey="theoretical" name="theoretical" tick={axisTick} tickFormatter={fmtCompact} stroke={grid} />
                    <YAxis type="number" dataKey="empirical" name="empirical" tick={axisTick} tickFormatter={fmtCompact} stroke={grid} width={44} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtCompact(Number(v))} />
                    {diag.qq.length > 0 && (
                      <ReferenceLine
                        segment={[
                          { x: diag.qq[0].theoretical, y: diag.qq[0].theoretical },
                          { x: diag.qq[diag.qq.length - 1].empirical, y: diag.qq[diag.qq.length - 1].empirical },
                        ]}
                        stroke="rgba(148,163,184,0.6)" strokeDasharray="4 3"
                      />
                    )}
                    <Scatter data={diag.qq} fill={accent} fillOpacity={0.75} isAnimationActive={false} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
