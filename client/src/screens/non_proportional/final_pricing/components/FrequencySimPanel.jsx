// components/FrequencySimPanel.jsx
//
// Frequency / aggregate Monte-Carlo half of the Pricing Analysis "Pareto
// Simulation" tab. Pairs with SeverityFitPanel (same scope): it takes that
// panel's fitted (or overridden) severity and runs the seeded MC aggregate-loss
// engine through the layer terms — ALWAYS on the Web Worker, never the main
// thread — and Pareto pricing is DERIVED FROM the simulation:
//
//   • Frequency: Poisson(λ) default (λ prefilled from the historical
//     threshold-exceedance count / year) or Negative Binomial + dispersion.
//   • Simulations (default 10,000) + a settable Seed (reproducible runs).
//   • "Include parameter (estimation) risk" → engine resampleParams.
//   • Risk load (underwriter-driven): θ·SD or a multiple of the TVaR excess
//     over the mean. Technical Pareto ROL% = pure premium + risk load.
//   • The technical ROL% is WRITTEN into riskPareto / catPareto so it flows
//     through the Pure-Burn/Pareto/Exposure blend → the layer's total ROL and
//     UW price update live.
//   • The full sim config (family, params, threshold, frequency, λ, dispersion,
//     risk load, sims AND seed) is persisted on the structure so a reload
//     re-simulates to identical numbers — the audit trail.

import { useState, useEffect, useRef, useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { toN } from '../formatters.js';
import { formatWithCommas } from '../../../../utils/format';
import { QUOTE_COMPONENT_SCOPES, paretoTechnicalRol } from '../fqQuoteMath.js';
import { createMonteCarloRunner } from '../paretoMonteCarloClient.js';

const DEFAULT_SEED = 12345;
const DEFAULT_SIMS = 10000;
const TVAR_RP = 100;   // TVaR-load return period (1-in-100)

const fmtMoney = (n) => (toN(n) > 0 ? formatWithCommas(String(Math.round(toN(n)))) : '—');
const fmtProb = (p) => (Number.isFinite(p) ? `${(p * 100).toFixed(p > 0 && p < 0.01 ? 2 : 1)}%` : '—');
const fmtNum = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const fmtCompact = (v) => {
  const n = Math.abs(v);
  if (n >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};

export default function FrequencySimPanel({ scopeKey, structure, sIdx, sevFit, savedConfig, updateClientStructure, updateClientStructureLayer }) {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  const accent = scope.color;

  const [freqType, setFreqType] = useState(savedConfig?.freqType || 'POISSON');
  const [dispersion, setDispersion] = useState(savedConfig?.dispersion != null ? String(savedConfig.dispersion) : '0.5');
  const [lambda, setLambda] = useState(savedConfig?.lambda != null ? String(savedConfig.lambda) : '');
  const [sims, setSims] = useState(savedConfig?.nSims != null ? String(savedConfig.nSims) : String(DEFAULT_SIMS));
  const [seed, setSeed] = useState(savedConfig?.seed != null ? String(savedConfig.seed) : String(DEFAULT_SEED));
  const [resampleParams, setResampleParams] = useState(!!savedConfig?.resampleParams);
  const [loadMethod, setLoadMethod] = useState(savedConfig?.loadMethod || 'SD');
  const [loadFactor, setLoadFactor] = useState(savedConfig?.loadFactor != null ? String(savedConfig.loadFactor) : '0.15');
  const [results, setResults] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState('');
  const lambdaTouched = useRef(savedConfig?.lambda != null);   // keep a hydrated λ

  // λ default = historical threshold-exceedance frequency (count / years).
  const defaultLambda = useMemo(() => {
    const n = toN(sevFit?.n);
    const yrs = toN(sevFit?.years);
    return yrs > 0 ? n / yrs : 0;
  }, [sevFit]);
  useEffect(() => {
    if (!lambdaTouched.current) setLambda(defaultLambda > 0 ? String(Number(defaultLambda.toFixed(3))) : '');
  }, [defaultLambda]);

  // Lazily-spawned worker handle; torn down on unmount.
  const runnerRef = useRef(null);
  useEffect(() => {
    runnerRef.current = createMonteCarloRunner();
    return () => { runnerRef.current?.terminate(); runnerRef.current = null; };
  }, []);

  // Active layers for this scope, plus a STABLE key of the sim-relevant terms
  // only — so writing the priced Pareto ROL back (which mutates the structure)
  // never re-triggers the simulation.
  const simLayers = useMemo(() => (
    (structure?.layers || [])
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l[scopeKey] && toN(l.limit) > 0)
  ), [structure, scopeKey]);
  const layersKey = useMemo(() => JSON.stringify(
    simLayers.map(({ l, i }) => [i, toN(l.attachment), toN(l.limit), String(l.reinstatements ?? ''), toN(l.pctReinst)]),
  ), [simLayers]);
  const simLayersRef = useRef(simLayers);
  simLayersRef.current = simLayers;

  // Ready to simulate when we have a threshold and either losses to fit or
  // stored params to sample from (so a reloaded quote re-prices without the
  // raw losses being re-fetched).
  const hasLosses = Array.isArray(sevFit?.severities) && sevFit.severities.length > 0;
  const hasParams = !!sevFit?.params && Object.values(sevFit.params).some((v) => toN(v) !== 0);
  const ready = !!sevFit && toN(sevFit.threshold) > 0 && (hasLosses || hasParams);

  const sevKey = sevFit
    ? `${sevFit.family}|${sevFit.threshold}|${JSON.stringify(sevFit.params || {})}|${sevFit.years}|${sevFit.severities?.length || 0}`
    : '';

  const buildParams = (layer) => ({
    seed: toN(seed) || DEFAULT_SEED,
    nSims: toN(sims) || DEFAULT_SIMS,
    bootstrap: resampleParams ? 300 : 0,            // bootstrap only needed for estimation risk
    losses: sevFit.severities || [],
    threshold: sevFit.threshold,
    severity: { family: sevFit.family, params: sevFit.params },   // honour fitted+overridden params
    frequency: { type: freqType, lambda: toN(lambda), dispersion: toN(dispersion), years: toN(sevFit.years) },
    layer: {
      attachment: toN(layer.attachment),
      limit: toN(layer.limit),
      reinstatements: layer.reinstatements,
      reinstPct: toN(layer.pctReinst) > 0 ? toN(layer.pctReinst) / 100 : 1,
      // Reinstatement premium accrues on the scope's earned premium (limit × ROL).
      premium: toN(layer.limit) * toN(layer[scope.fields.uwPrice]) / 100,
    },
    resampleParams,
  });

  // ── Debounced worker run (never on the main thread) ──
  useEffect(() => {
    if (!ready || !(toN(lambda) > 0) || !simLayersRef.current.length) { setResults(null); setSimulating(false); return undefined; }
    let cancelled = false;
    const id = setTimeout(() => {
      setSimulating(true);
      setError('');
      const jobs = simLayersRef.current.map(({ l, i }) => runnerRef.current.run(buildParams(l)).then((r) => ({ i, layer: l, r })));
      Promise.all(jobs)
        .then((rows) => { if (!cancelled) { setResults(rows); setSimulating(false); } })
        .catch((e) => { if (!cancelled) { setError(e?.message || 'Simulation failed'); setSimulating(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, layersKey, sevKey, freqType, lambda, dispersion, sims, seed, resampleParams]);

  // ── Price + persist: write the technical Pareto ROL into the blend and save
  //    the sim config. Runs when results OR the risk load change (load tweaks
  //    re-price without re-simulating). Never re-triggers the run effect. ──
  const cfgRef = useRef(null);
  cfgRef.current = { family: sevFit?.family, params: sevFit?.params, threshold: sevFit?.threshold, freqType, lambda, dispersion, nSims: sims, seed, resampleParams };
  // The write setters are deliberately read through a ref, NOT listed in the
  // effect deps. The real updateClientStructureLayer changes identity whenever
  // clientStructures change (it closes over quoteCurve) — and this effect
  // mutates a structure (writing the priced Pareto ROL). Listing it would make
  // every write re-fire the effect → infinite render loop (React #185).
  const writeRef = useRef(null);
  writeRef.current = { writeLayer: updateClientStructureLayer, writeStruct: updateClientStructure };
  useEffect(() => {
    if (!results || !results.length) return;
    const load = { method: loadMethod, factor: toN(loadFactor), tvarRp: TVAR_RP };
    const { writeLayer, writeStruct } = writeRef.current;
    results.forEach(({ i, layer, r }) => {
      const { loadedRol } = paretoTechnicalRol(r.aggregate, toN(layer.limit), load);
      writeLayer(sIdx, i, scope.fields.pareto, loadedRol > 0 ? String(Number(loadedRol.toFixed(4))) : '');
    });
    if (typeof writeStruct === 'function') {
      const c = cfgRef.current;
      writeStruct(sIdx, `${scopeKey}ParetoSim`, {
        family: c.family, params: c.params, threshold: c.threshold,
        freqType: c.freqType, lambda: toN(c.lambda), dispersion: toN(c.dispersion),
        loadMethod, loadFactor: toN(loadFactor), nSims: toN(c.nSims), seed: toN(c.seed), resampleParams: c.resampleParams,
      });
    }
    // Setters intentionally omitted (read via writeRef) — see comment above.
  }, [results, loadMethod, loadFactor, sIdx, scopeKey, scope.fields.pareto]);

  // Histogram + ECDF data for the first active layer's aggregate distribution.
  const distData = useMemo(() => {
    const agg = results?.[0]?.r?.aggregate;
    if (!agg?.histogram?.bins?.length) return [];
    const total = agg.histogram.bins.reduce((s, b) => s + b.count, 0) || 1;
    let cum = 0;
    return agg.histogram.bins.map((b) => { cum += b.count; return { x: (b.x0 + b.x1) / 2, count: b.count, ecdf: cum / total }; });
  }, [results]);

  const load = { method: loadMethod, factor: toN(loadFactor), tvarRp: TVAR_RP };
  const tailAt = (tail, rp) => (Array.isArray(tail) ? tail.find((t) => t.rp === rp) : null) || { var: NaN, tvar: NaN };

  // ── Styling ──
  const card = { background: 'rgba(8,14,30,0.72)', border: `1px solid ${accent}35`, borderRadius: 12 };
  const fieldS = (w) => ({ width: w, boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 6, color: '#e2e8f0', fontSize: 12, fontWeight: 700, padding: '6px 9px', fontFamily: 'inherit' });
  const th = { padding: '7px 8px', textAlign: 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.08em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap', background: '#050810' };
  const td = { padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.045)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

  return (
    <section data-testid={`fq-frequency-panel-${scopeKey}`} style={card}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: accent }}>{scope.label} Frequency &amp; Aggregate Simulation</div>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
            Pareto pricing is derived from this Monte-Carlo — runs on a worker, off the UI thread.
          </div>
        </div>
        {simulating && (
          <div data-testid={`fq-frequency-simulating-${scopeKey}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: '#7dd3fc' }}>
            <span aria-hidden="true">⟳</span> simulating…
          </div>
        )}
      </div>

      {!ready ? (
        <div data-testid={`fq-frequency-pending-${scopeKey}`} style={{ padding: '18px 14px', fontSize: 12, color: 'rgba(148,163,184,0.78)' }}>
          Fit a severity above to enable the aggregate simulation.
        </div>
      ) : (
        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* ── Controls ── */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Ctl label="Frequency model">
              <select data-testid={`fq-frequency-model-${scopeKey}`} aria-label={`${scope.label} frequency model`} value={freqType} onChange={(e) => setFreqType(e.target.value)} style={{ ...fieldS(150), cursor: 'pointer' }}>
                <option value="POISSON">Poisson</option>
                <option value="NEGBIN">Negative Binomial</option>
              </select>
            </Ctl>
            <Ctl label="λ (claims / yr)">
              <input type="text" inputMode="decimal" data-testid={`fq-frequency-lambda-${scopeKey}`} aria-label={`${scope.label} frequency lambda`}
                value={lambda} onChange={(e) => { lambdaTouched.current = true; setLambda(e.target.value.replace(/[^0-9.]/g, '')); }}
                style={{ ...fieldS(92), textAlign: 'right', border: `1px solid ${accent}55` }} />
            </Ctl>
            {freqType === 'NEGBIN' && (
              <Ctl label="Dispersion">
                <input type="text" inputMode="decimal" data-testid={`fq-frequency-dispersion-${scopeKey}`} aria-label={`${scope.label} frequency dispersion`}
                  value={dispersion} onChange={(e) => setDispersion(e.target.value.replace(/[^0-9.]/g, ''))} style={{ ...fieldS(86), textAlign: 'right' }} />
              </Ctl>
            )}
            <Ctl label="Risk load">
              <select data-testid={`fq-frequency-loadmethod-${scopeKey}`} aria-label={`${scope.label} risk load method`} value={loadMethod} onChange={(e) => setLoadMethod(e.target.value)} style={{ ...fieldS(120), cursor: 'pointer' }}>
                <option value="SD">θ · SD</option>
                <option value="TVAR">TVaR×mult</option>
              </select>
            </Ctl>
            <Ctl label={loadMethod === 'TVAR' ? 'Multiple' : 'θ'}>
              <input type="text" inputMode="decimal" data-testid={`fq-frequency-loadfactor-${scopeKey}`} aria-label={`${scope.label} risk load factor`}
                value={loadFactor} onChange={(e) => setLoadFactor(e.target.value.replace(/[^0-9.]/g, ''))} style={{ ...fieldS(72), textAlign: 'right' }} />
            </Ctl>
            <Ctl label="Simulations">
              <input type="text" inputMode="numeric" data-testid={`fq-frequency-sims-${scopeKey}`} aria-label={`${scope.label} simulations`}
                value={sims} onChange={(e) => setSims(e.target.value.replace(/[^0-9]/g, ''))} style={{ ...fieldS(92), textAlign: 'right' }} />
            </Ctl>
            <Ctl label="Seed">
              <input type="text" inputMode="numeric" data-testid={`fq-frequency-seed-${scopeKey}`} aria-label={`${scope.label} random seed`}
                value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))} style={{ ...fieldS(84), textAlign: 'right' }} />
            </Ctl>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.9)', paddingBottom: 6 }}>
              <input type="checkbox" className="np-check" data-testid={`fq-frequency-estrisk-${scopeKey}`} checked={resampleParams} onChange={(e) => setResampleParams(e.target.checked)} style={{ margin: 0 }} />
              Include parameter (estimation) risk
            </label>
          </div>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.6)', lineHeight: 1.5, marginTop: -6 }}>
            Estimation risk redraws ξ/σ and λ from their bootstrap/sampling distributions each trial — it widens the tail
            to reflect small-sample uncertainty in the fit. Severity: {sevFit?.family || '—'}.
          </div>

          {error && <div style={{ fontSize: 11, color: '#f87171' }}>{error}</div>}

          {/* ── Per-layer aggregate results ── */}
          {results && results.length > 0 ? (
            <>
              <div style={{ overflowX: 'auto', width: '100%' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180, fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: 'center' }}>Layer</th>
                      <th style={th}>Limit</th>
                      <th style={th}>Attach</th>
                      <th style={th}>E[Ceded]</th>
                      <th style={th}>SD</th>
                      <th style={th}>CoV</th>
                      {[10, 50, 100, 200].map((rp) => (<th key={`v${rp}`} style={th}>VaR 1:{rp}</th>))}
                      {[10, 50, 100, 200].map((rp) => (<th key={`t${rp}`} style={th}>TVaR 1:{rp}</th>))}
                      <th style={th}>P(Att)</th>
                      <th style={th}>P(Exh)</th>
                      <th style={th}>E[Reinst]</th>
                      <th style={th}>E[Reinst Prem]</th>
                      <th style={{ ...th, color: accent }}>Pareto ROL</th>
                      <th style={th}>Analytic LEV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(({ i, layer, r }) => {
                      const a = r.aggregate;
                      const tech = paretoTechnicalRol(a, toN(layer.limit), load);
                      const recon = r.reconciliation || {};
                      const diverged = recon.analyticExpectedLoss > 0 && recon.withinTolerance === false;
                      return (
                        <tr key={`mc-${layer.id ?? i}`} data-testid={`fq-frequency-row-${scopeKey}-${i}`} style={{ background: i % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                          <td style={{ ...td, textAlign: 'center' }}><span className="bm-badge" style={{ background: `${accent}14`, borderColor: `${accent}35`, color: accent }}>{i + 1}</span></td>
                          <td style={td}>{fmtMoney(layer.limit)}</td>
                          <td style={td}>{fmtMoney(layer.attachment)}</td>
                          <td style={{ ...td, fontWeight: 800, color: 'rgba(226,232,240,0.95)' }}>{fmtMoney(a.mean)}</td>
                          <td style={td}>{fmtMoney(a.sd)}</td>
                          <td style={td}>{fmtNum(a.cov)}</td>
                          {[10, 50, 100, 200].map((rp) => (<td key={`v${rp}`} style={td}>{fmtMoney(tailAt(a.tail, rp).var)}</td>))}
                          {[10, 50, 100, 200].map((rp) => (<td key={`t${rp}`} style={td}>{fmtMoney(tailAt(a.tail, rp).tvar)}</td>))}
                          <td style={td}>{fmtProb(a.pAttach)}</td>
                          <td style={td}>{fmtProb(a.pExhaust)}</td>
                          <td style={td}>{fmtNum(a.eReinstUsed)}</td>
                          <td style={td}>{fmtMoney(a.eReinstPremium)}</td>
                          <td style={{ ...td, color: accent, fontWeight: 800 }}>{`${tech.loadedRol.toFixed(2)}%`}</td>
                          <td style={{ ...td, color: diverged ? '#fbbf24' : 'rgba(148,163,184,0.85)' }} title={diverged ? `z=${fmtNum(recon.zScore)} — beyond MC error` : 'reconciles within MC error'}>
                            {fmtMoney(recon.analyticExpectedLoss)} {recon.analyticExpectedLoss > 0 ? (diverged ? '⚠' : '✓') : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 9, color: 'rgba(148,163,184,0.55)' }}>
                {toN(sims).toLocaleString()} trials · seed {toN(seed)} · {freqType === 'NEGBIN' ? `Neg-Binomial (dispersion ${toN(dispersion)})` : 'Poisson'} · λ {fmtNum(toN(lambda), 3)} ·
                load {loadMethod === 'TVAR' ? `${toN(loadFactor)}×(TVaR₁₀₀−mean)` : `${toN(loadFactor)}·SD`}
                {resampleParams ? ' · +estimation risk' : ''}
              </div>

              {/* ── Aggregate-loss distribution (first active layer) ── */}
              {distData.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.78)', marginBottom: 4 }}>
                    Aggregate loss distribution — Layer {(results[0].i) + 1} (histogram + ECDF)
                  </div>
                  <ResponsiveContainer width="100%" height={210}>
                    <ComposedChart data={distData} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke="rgba(255,255,255,0.07)" />
                      <XAxis type="number" dataKey="x" tick={{ fontSize: 9, fill: 'rgba(148,163,184,0.7)' }} tickFormatter={fmtCompact} stroke="rgba(255,255,255,0.07)" />
                      <YAxis yAxisId="count" tick={{ fontSize: 9, fill: 'rgba(148,163,184,0.7)' }} stroke="rgba(255,255,255,0.07)" width={40} />
                      <YAxis yAxisId="ecdf" orientation="right" domain={[0, 1]} tick={{ fontSize: 9, fill: 'rgba(148,163,184,0.7)' }} tickFormatter={(v) => `${Math.round(v * 100)}%`} stroke="rgba(255,255,255,0.07)" width={40} />
                      <Tooltip contentStyle={{ background: '#0b1526', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, fontSize: 11 }} formatter={(v, n) => (n === 'ecdf' ? `${(Number(v) * 100).toFixed(1)}%` : Math.round(Number(v)))} labelFormatter={(v) => `loss ≈ ${fmtCompact(Number(v))}`} />
                      <Bar yAxisId="count" dataKey="count" fill={`${accent}66`} isAnimationActive={false} />
                      <Line yAxisId="ecdf" type="monotone" dataKey="ecdf" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          ) : (
            !simulating && (
              <div data-testid={`fq-frequency-no-results-${scopeKey}`} style={{ fontSize: 11, color: 'rgba(148,163,184,0.7)' }}>
                {simLayers.length === 0 ? 'No active layers in this scope to simulate.' : 'Enter a positive λ to run the simulation.'}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}

// Small labelled-control wrapper (column).
function Ctl({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.7)' }}>{label}</span>
      {children}
    </div>
  );
}
