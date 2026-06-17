// components/FrequencySimPanel.jsx
//
// Frequency half of the Pricing Analysis "Pareto Simulation" tab. Pairs with
// SeverityFitPanel (same scope): it takes that panel's fitted severity (family,
// threshold, losses) and runs the seeded Monte-Carlo aggregate-loss engine
// through the layer terms — ALWAYS on the Web Worker, never the main thread.
//
//   • Frequency model: Poisson(λ) default (λ prefilled from the historical
//     threshold-exceedance count / year), or Negative Binomial with a
//     dispersion field for over-dispersed counts.
//   • Simulations (default 10,000) + a settable random Seed (reproducible runs).
//   • "Include parameter (estimation) risk" toggle → the engine's resampleParams
//     flag; redraws ξ/σ/λ each trial to widen the tail for small samples.
//   • Re-runs the worker (debounced ~250ms) on any change, with a "simulating…"
//     indicator. One run per active layer; results shown as an aggregate table.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { toN } from '../formatters.js';
import { formatWithCommas } from '../../../../utils/format';
import { QUOTE_COMPONENT_SCOPES, quoteComponentDerived } from '../fqQuoteMath.js';
import { createMonteCarloRunner } from '../paretoMonteCarloClient.js';

const DEFAULT_SEED = 12345;
const DEFAULT_SIMS = 10000;

const fmtMoney = (n) => (toN(n) > 0 ? formatWithCommas(String(Math.round(toN(n)))) : '—');
const fmtProb = (p) => (Number.isFinite(p) ? `${(p * 100).toFixed(p > 0 && p < 0.01 ? 2 : 1)}%` : '—');
const fmtNum = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');

export default function FrequencySimPanel({ scopeKey, structure, sevFit }) {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  const accent = scope.color;

  const [freqType, setFreqType] = useState('POISSON');
  const [dispersion, setDispersion] = useState('0.5');
  const [lambda, setLambda] = useState('');
  const [sims, setSims] = useState(String(DEFAULT_SIMS));
  const [seed, setSeed] = useState(String(DEFAULT_SEED));
  const [resampleParams, setResampleParams] = useState(false);
  const [results, setResults] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState('');
  const lambdaTouched = useRef(false);

  // λ default = historical threshold-exceedance frequency (count ≥ threshold /
  // observation years). Trend-adjusted already (the severities are trended);
  // the underwriter can override for prospective exposure.
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

  const activeLayers = useMemo(() => (
    (structure?.layers || [])
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l[scopeKey] && toN(l.limit) > 0)
  ), [structure, scopeKey]);

  const buildParams = useCallback((layer) => {
    const rp = toN(layer.pctReinst);
    const scopeRol = quoteComponentDerived(layer, scopeKey).totalRol;
    const premium = toN(layer.limit) * scopeRol / 100;     // scope earned premium (for reinstatement premium)
    return {
      seed: toN(seed) || DEFAULT_SEED,
      nSims: toN(sims) || DEFAULT_SIMS,
      bootstrap: resampleParams ? 300 : 0,                  // bootstrap only needed for estimation risk
      losses: sevFit.severities,
      threshold: sevFit.threshold,
      severity: { family: sevFit.family },
      frequency: { type: freqType, lambda: toN(lambda), dispersion: toN(dispersion), years: toN(sevFit.years) },
      layer: {
        attachment: toN(layer.attachment),
        limit: toN(layer.limit),
        reinstatements: layer.reinstatements,
        reinstPct: rp > 0 ? rp / 100 : 1,
        premium,
      },
      resampleParams,
    };
  }, [seed, sims, resampleParams, sevFit, freqType, lambda, dispersion, scopeKey]);

  // ── Debounced worker run on any input / fit change (never on main thread) ──
  const ready = !!sevFit && Array.isArray(sevFit.severities) && sevFit.severities.length > 0 && toN(sevFit.threshold) > 0;
  useEffect(() => {
    if (!ready || !activeLayers.length || !(toN(lambda) > 0)) { setResults(null); setSimulating(false); return undefined; }
    let cancelled = false;
    const id = setTimeout(() => {
      setSimulating(true);
      setError('');
      Promise.all(activeLayers.map(({ l, i }) => runnerRef.current.run(buildParams(l)).then((r) => ({ i, layer: l, r }))))
        .then((rows) => { if (!cancelled) { setResults(rows); setSimulating(false); } })
        .catch((e) => { if (!cancelled) { setError(e?.message || 'Simulation failed'); setSimulating(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [ready, activeLayers, lambda, buildParams]);

  // ── Styling ──
  const card = { background: 'rgba(8,14,30,0.72)', border: `1px solid ${accent}35`, borderRadius: 12 };
  const label = { fontSize: 9, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.7)' };
  const field = (w) => ({ width: w, boxSizing: 'border-box', background: 'rgba(5,8,16,0.6)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 6, color: '#e2e8f0', fontSize: 12, fontWeight: 700, padding: '6px 9px', fontFamily: 'inherit' });
  const th = { padding: '7px 9px', textAlign: 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.09em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap', background: '#050810' };
  const td = { padding: '6px 9px', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.045)', fontVariantNumeric: 'tabular-nums' };

  return (
    <section data-testid={`fq-frequency-panel-${scopeKey}`} style={card}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: accent }}>{scope.label} Frequency &amp; Aggregate Simulation</div>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
            Monte-Carlo aggregate loss through the layer terms — runs on a worker, off the UI thread.
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
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>Frequency model</span>
              <select
                data-testid={`fq-frequency-model-${scopeKey}`} aria-label={`${scope.label} frequency model`}
                value={freqType} onChange={(e) => setFreqType(e.target.value)} style={{ ...field(150), cursor: 'pointer' }}
              >
                <option value="POISSON">Poisson</option>
                <option value="NEGBIN">Negative Binomial</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>λ (claims / yr)</span>
              <input
                type="text" inputMode="decimal" data-testid={`fq-frequency-lambda-${scopeKey}`}
                aria-label={`${scope.label} frequency lambda`}
                value={lambda} onChange={(e) => { lambdaTouched.current = true; setLambda(e.target.value.replace(/[^0-9.]/g, '')); }}
                style={{ ...field(96), textAlign: 'right', border: `1px solid ${accent}55` }}
              />
            </div>
            {freqType === 'NEGBIN' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={label}>Dispersion</span>
                <input
                  type="text" inputMode="decimal" data-testid={`fq-frequency-dispersion-${scopeKey}`}
                  aria-label={`${scope.label} frequency dispersion`}
                  value={dispersion} onChange={(e) => setDispersion(e.target.value.replace(/[^0-9.]/g, ''))}
                  style={{ ...field(90), textAlign: 'right' }}
                />
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>Simulations</span>
              <input
                type="text" inputMode="numeric" data-testid={`fq-frequency-sims-${scopeKey}`}
                aria-label={`${scope.label} simulations`}
                value={sims} onChange={(e) => setSims(e.target.value.replace(/[^0-9]/g, ''))}
                style={{ ...field(96), textAlign: 'right' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>Seed</span>
              <input
                type="text" inputMode="numeric" data-testid={`fq-frequency-seed-${scopeKey}`}
                aria-label={`${scope.label} random seed`}
                value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
                style={{ ...field(90), textAlign: 'right' }}
              />
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.9)', paddingBottom: 6 }}>
              <input
                type="checkbox" className="np-check" data-testid={`fq-frequency-estrisk-${scopeKey}`}
                checked={resampleParams} onChange={(e) => setResampleParams(e.target.checked)} style={{ margin: 0 }}
              />
              Include parameter (estimation) risk
            </label>
          </div>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.6)', lineHeight: 1.5, marginTop: -6 }}>
            Estimation risk redraws ξ/σ and λ from their bootstrap/sampling distributions each trial — it widens the tail
            to reflect small-sample uncertainty in the fit. {sevFit?.family ? `Severity: ${sevFit.family}.` : ''}
          </div>

          {error && <div style={{ fontSize: 11, color: '#f87171' }}>{error}</div>}

          {/* ── Per-layer aggregate results ── */}
          {results && results.length > 0 ? (
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900, fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'center' }}>Layer</th>
                    <th style={th}>Limit</th>
                    <th style={th}>Attach</th>
                    <th style={th}>Pure Premium</th>
                    <th style={th}>CoV</th>
                    <th style={th}>VaR 1:100</th>
                    <th style={th}>TVaR 1:100</th>
                    <th style={th}>VaR 1:200</th>
                    <th style={th}>P(Attach)</th>
                    <th style={th}>P(Exhaust)</th>
                    <th style={th}>E[Reinst Prem]</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map(({ i, layer, r }) => {
                    const a = r.aggregate;
                    return (
                      <tr key={`mc-${layer.id ?? i}`} data-testid={`fq-frequency-row-${scopeKey}-${i}`} style={{ background: i % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <span className="bm-badge" style={{ background: `${accent}14`, borderColor: `${accent}35`, color: accent }}>{i + 1}</span>
                        </td>
                        <td style={td}>{fmtMoney(layer.limit)}</td>
                        <td style={td}>{fmtMoney(layer.attachment)}</td>
                        <td style={{ ...td, color: accent, fontWeight: 800 }}>{fmtMoney(a.mean)}</td>
                        <td style={td}>{fmtNum(a.cov)}</td>
                        <td style={td}>{fmtMoney(a.percentiles.p99)}</td>
                        <td style={td}>{fmtMoney(a.tail[3].tvar)}</td>
                        <td style={td}>{fmtMoney(a.percentiles.p995)}</td>
                        <td style={td}>{fmtProb(a.pAttach)}</td>
                        <td style={td}>{fmtProb(a.pExhaust)}</td>
                        <td style={td}>{fmtMoney(a.eReinstPremium)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div style={{ fontSize: 9, color: 'rgba(148,163,184,0.55)', marginTop: 6 }}>
                {toN(sims).toLocaleString()} trials · seed {toN(seed)} · {freqType === 'NEGBIN' ? `Neg-Binomial (dispersion ${toN(dispersion)})` : 'Poisson'} · λ {fmtNum(toN(lambda), 3)}
                {results.every((row) => row.r.reconciliation?.withinTolerance) ? ' · ✓ reconciles to analytic' : ''}
              </div>
            </div>
          ) : (
            !simulating && (
              <div data-testid={`fq-frequency-no-results-${scopeKey}`} style={{ fontSize: 11, color: 'rgba(148,163,184,0.7)' }}>
                {activeLayers.length === 0 ? 'No active layers in this scope to simulate.' : 'Enter a positive λ to run the simulation.'}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}
