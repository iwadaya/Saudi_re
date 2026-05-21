import { useState, useEffect } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { loadProjectedRows } from '../../../logic/projectWithSavedFactors';

const ROUTE_KEY = 'PROP_PROJECTED_SUMMARY';

function fmt0(n) { return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fPct(n) { return n == null ? '—' : `${(n * 100).toFixed(1)}%`; }
function lrCls(v) { return Number.isFinite(v) && v > 1.0 ? 'ps-cell--hot' : ''; }

export default function PropProjectedSummary() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [topMetric, setTopMetric] = useState('PREMIUM');
  const [error, setError] = useState(null);
  const [source, setSource] = useState('');
  const [showAnalyses, setShowAnalyses] = useState(false);

  useEffect(() => {
    if (!contractId) return;
    setLoading(true); setError(null);
    (async () => {
      try {
        /* ── Use saved dev factors via shared utility ── */
        const qm = appState.quoteMode ? { quote: true } : undefined;
        const { rows: standardRows, source: src } = await loadProjectedRows(contractId, qm);
        setSource(src || '');

        if (standardRows && standardRows.length > 0) {
          setResults(standardRows.map(r => ({
            year: r.year,
            premium: r.actPrem, projectedPremium: r.ultPrem,
            actualLosses: r.actLoss, projectedLosses: r.ultLoss,
            ultPaid: r.ultPaid ?? null,
            ultIncurred: r.ultIncurred ?? r.ultLoss,
            projectedLR: r.ultPrem > 0 ? r.ultLoss / r.ultPrem : 0,
            actualLR: r.actPrem > 0 ? r.actLoss / r.actPrem : 0,
          })));
        } else {
          setResults([]);
        }
      } catch (e) {
        console.error('Projected Summary Load Failed', e);
        setError(e.message || 'Failed to load data');
      }
      setLoading(false);
    })();
  }, [appState.quoteMode, contractId]);

  const save = async () => {
    if (!contractId || !results.length) return true;
    try {
      const payload = [];
      results.forEach(r => {
        payload.push({ uw_year: r.year, record_type: 'ACTUAL', ultimate_premium: r.premium, ultimate_loss: r.actualLosses, loss_ratio: r.actualLR });
        payload.push({ uw_year: r.year, record_type: 'PROJECTED', ultimate_premium: r.projectedPremium, ultimate_loss: r.projectedLosses, loss_ratio: r.projectedLR });
      });
      await api.savePricingYearly(contractId, payload);
      return true;
    } catch (e) { console.error('Save failed:', e); return false; }
  };

  const sum = k => results.reduce((a, x) => a + (x[k] || 0), 0);
  const tPrem = sum('premium'), tUP = sum('projectedPremium'), tAL = sum('actualLosses'), tUL = sum('projectedLosses');
  const tUPaid = sum('ultPaid'), tUInc = sum('ultIncurred');
  const reservingDelta = tUPaid - tUInc;
  const reservingStatus = !Number.isFinite(reservingDelta) || (tUPaid === 0 && tUInc === 0)
    ? 'NONE'
    : reservingDelta > 0 ? 'UNDER' : reservingDelta < 0 ? 'OVER' : 'BALANCED';

  /* ── Bar Chart ── */
  const BarChart = ({ title, subtitle, showToggle }) => {
    const years = results.map(r => r.year);
    const isLoss = topMetric === 'LOSSES';
    const actSeries = results.map(r => isLoss ? r.actualLosses : r.premium);
    const projSeries = results.map(r => isLoss ? r.projectedLosses : r.projectedPremium);
    const max = Math.max(...actSeries, ...projSeries, 1);
    const h = v => Math.max(2, Math.round((v / max) * 100));
    return (
      <div className="ps-card glass">
        <div className="ps-card-head">
          <div className="ps-card-head-left"><div className="ps-card-title">{title}</div><div className="ps-card-sub">{subtitle}</div></div>
          {showToggle && <div className="ps-card-head-right"><div className="ps-metric-toggle"><div className="toggle-group">
            <div className={`toggle-option ${topMetric === 'PREMIUM' ? 'active' : ''}`} onClick={() => setTopMetric('PREMIUM')}>Premium</div>
            <div className={`toggle-option ${topMetric === 'LOSSES' ? 'active' : ''}`} onClick={() => setTopMetric('LOSSES')}>Losses</div>
          </div></div></div>}
        </div>
        <div className="ps-legend">
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--proj" /><span>Projected</span></div>
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--act" /><span>Actual</span></div>
        </div>
        <div className="ps-chart-shell"><div className="ps-chart-surface"><div className="ps-bars">
          {years.map((y, i) => <div key={y} className="ps-bars-col" title={String(y)}><div className="ps-bars-pair">
            <div className="ps-bar ps-bar--proj" style={{ height: `${h(projSeries[i])}%` }} />
            <div className="ps-bar ps-bar--act" style={{ height: `${h(actSeries[i])}%` }} />
          </div></div>)}
        </div></div><div className="ps-x-axis">{years.map(y => <div key={y} className="ps-x-tick">{y}</div>)}</div></div>
      </div>
    );
  };

  /* ── LR Chart ── */
  const LRChart = () => {
    const years = results.map(r => r.year);
    const act = results.map(r => r.actualLR * 100), proj = results.map(r => r.projectedLR * 100);
    const max = Math.max(...act, ...proj, 1);
    const h = v => Math.max(2, Math.round((v / max) * 100));
    return (
      <div className="ps-card glass">
        <div className="ps-card-head"><div className="ps-card-head-left"><div className="ps-card-title">Projected vs Actual Loss Ratio</div><div className="ps-card-sub">Ultimate vs Incurred LR</div></div></div>
        <div className="ps-legend">
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--proj" /><span>Projected</span></div>
          <div className="ps-legend-item"><span className="ps-legend-dot ps-legend-dot--act" /><span>Actual</span></div>
        </div>
        <div className="ps-chart-shell"><div className="ps-chart-surface"><div className="ps-bars">
          {years.map((y, i) => <div key={y} className="ps-bars-col" title={String(y)}><div className="ps-bars-pair">
            <div className="ps-bar ps-bar--proj" style={{ height: `${h(proj[i])}%` }} />
            <div className="ps-bar ps-bar--act" style={{ height: `${h(act[i])}%` }} />
          </div></div>)}
        </div></div><div className="ps-x-axis">{years.map(y => <div key={y} className="ps-x-tick">{y}</div>)}</div></div>
      </div>
    );
  };

  /* Source label */
  const sourceLabel = source === 'saved-factors' ? 'Using saved underwriter dev factors'
    : source === 'triangle-recalc' ? 'Recalculated from triangle (no saved factors)'
    : source === 'straight-long' ? 'Long Tail portfolio dev factors'
    : source === 'straight-short' ? 'Short Tail portfolio dev factors'
    : '';

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Projected Summary" headerPill="PROPORTIONAL TREATY: PROJECTED SUMMARY" onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="PROJECTED_SUMMARY_PAGE">
          {loading ? (
            <div className="df-card df-card--notice"><div className="df-note">Loading triangle data and running projections...</div></div>
          ) : error ? (
            <div className="df-card df-card--notice"><div className="df-note" style={{ color: '#f87171' }}>Error: {error}</div></div>
          ) : results.length === 0 ? (
            <div className="df-card df-card--notice"><div className="df-note">No data available. Enter data in triangles or the Experience (No Triangulation) screen first.</div></div>
          ) : (
            <div className="ps-page">
              <h2 className="ps-h2">Ultimate – Projected vs Actual
                {sourceLabel && <span style={{ fontSize: 12, fontWeight: 400, marginLeft: 12, color: source === 'saved-factors' ? 'var(--accent)' : 'rgba(255,255,255,.45)' }}>
                  ({sourceLabel})
                </span>}
              </h2>
              <div style={{
                margin: '4px 0 16px',
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(56,189,248,0.06)',
                border: '1px solid rgba(56,189,248,0.22)',
                fontSize: 12,
                color: 'rgba(226,232,240,0.78)',
                lineHeight: 1.5,
              }}>
                <b style={{ color: '#38bdf8', letterSpacing: '.04em' }}>UNCAPPED ULTIMATES.</b>{' '}
                Premium and loss values shown here are the raw triangle / dev-factor
                projections. Treaty caps, sliding commission, profit commission (with
                LCF) and loss-participation credits are <b>not</b> applied — those
                live on the Quick Summary screen, which produces a different loss
                ratio because claims are capped before the LR is computed.
              </div>
              <div className="ps-grid">
                {/* Left: Charts */}
                <div className="ps-col ps-stack">
                  <BarChart title={`Projected vs Actual – ${topMetric === 'LOSSES' ? 'Losses' : 'Premium'}`} subtitle="Comparison" showToggle />
                  <LRChart />
                </div>

                {/* Right: Tables */}
                <div className="ps-col">
                  <div className="ps-card glass">
                    <div className="ps-card-head"><div className="ps-card-title">Summary Statistics</div></div>

                    {/* Projected Ultimate table */}
                    <div className="ps-block">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div className="ps-block-title" style={{ marginBottom: 0 }}>Projected Ultimate</div>
                        <button
                          onClick={() => setShowAnalyses(s => !s)}
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            padding: '6px 12px',
                            borderRadius: 8,
                            cursor: 'pointer',
                            border: '1px solid rgba(99,102,241,0.45)',
                            background: showAnalyses ? 'rgba(99,102,241,0.20)' : 'rgba(99,102,241,0.08)',
                            color: '#c7d2fe',
                          }}
                        >
                          {showAnalyses ? '▾ Analyses' : '▸ Analyses'}
                        </button>
                      </div>
                      {showAnalyses && (() => {
                        const classify = (paid, inc) => {
                          if (!Number.isFinite(paid) || !Number.isFinite(inc) || (paid === 0 && inc === 0)) return 'NONE';
                          const d = paid - inc;
                          return d > 0 ? 'UNDER' : d < 0 ? 'OVER' : 'BALANCED';
                        };
                        const toneFor = (status) => status === 'UNDER'
                          ? { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.35)', text: '#fca5a5', label: 'Under Reserving', detail: 'Paid ultimate exceeds incurred ultimate — case reserves may be too low.' }
                          : status === 'OVER'
                            ? { bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.35)', text: '#86efac', label: 'Over Reserving', detail: 'Incurred ultimate exceeds paid ultimate — case reserves may be conservative.' }
                            : status === 'BALANCED'
                              ? { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.35)', text: '#cbd5e1', label: 'Balanced', detail: 'Paid and incurred ultimates align.' }
                              : { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.35)', text: '#94a3b8', label: 'No Data', detail: 'Paid and incurred projections are unavailable.' };
                        const combinedTone = toneFor(reservingStatus);
                        return (
                          <div style={{ marginBottom: 10 }}>
                            {/* ── Per-year comparison ── */}
                            <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(15,23,42,0.45)', border: '1px solid rgba(99,102,241,0.25)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: '#c7d2fe', letterSpacing: '0.04em' }}>RESERVING ANALYSIS — PER YEAR</div>
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>Paid Ultimate vs Incurred Ultimate</div>
                              </div>
                              <div className="ps-table-wrap">
                                <table className="ps-table">
                                  <thead><tr><th>UW Year</th><th>Paid Ult</th><th>Incurred Ult</th><th>Δ</th><th>Status</th></tr></thead>
                                  <tbody>
                                    {results.map(r => {
                                      const status = classify(r.ultPaid, r.ultIncurred);
                                      const t = toneFor(status);
                                      const delta = (r.ultPaid || 0) - (r.ultIncurred || 0);
                                      return (
                                        <tr key={r.year}>
                                          <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                          <td className="ps-dash"><div className="ps-cell">{fmt0(r.ultPaid)}</div></td>
                                          <td className="ps-dash"><div className="ps-cell">{fmt0(r.ultIncurred)}</div></td>
                                          <td className="ps-dash"><div className="ps-cell" style={{ color: t.text }}>{fmt0(delta)}</div></td>
                                          <td className="ps-dash">
                                            <div className="ps-cell" style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: t.text, background: t.bg, border: `1px solid ${t.border}` }}>
                                              {t.label.toUpperCase()}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr className="ps-total">
                                      <td className="ps-year"><div className="ps-cell">Combined</div></td>
                                      <td className="ps-dash"><div className="ps-cell">{fmt0(tUPaid)}</div></td>
                                      <td className="ps-dash"><div className="ps-cell">{fmt0(tUInc)}</div></td>
                                      <td className="ps-dash"><div className="ps-cell" style={{ color: combinedTone.text }}>{fmt0(reservingDelta)}</div></td>
                                      <td className="ps-dash">
                                        <div className="ps-cell" style={{ display: 'inline-flex', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', color: combinedTone.text, background: combinedTone.bg, border: `1px solid ${combinedTone.border}` }}>
                                          {combinedTone.label.toUpperCase()}
                                        </div>
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            {/* ── Combined verdict ── */}
                            <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 10, background: combinedTone.bg, border: `1px solid ${combinedTone.border}` }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: combinedTone.text, letterSpacing: '0.04em' }}>COMBINED — {combinedTone.label.toUpperCase()}</div>
                                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>Δ {fmt0(reservingDelta)}</div>
                              </div>
                              <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{combinedTone.detail}</div>
                            </div>
                          </div>
                        );
                      })()}
                      <div className="ps-table-wrap">
                        <table className="ps-table">
                          <thead><tr><th>UW Year</th><th>Premium</th><th>Ult. Losses</th><th>Ult. LR %</th></tr></thead>
                          <tbody>
                            {results.map(r => (
                              <tr key={r.year}>
                                <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.projectedPremium)}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.projectedLosses)}</div></td>
                                <td className={`ps-dash ${lrCls(r.projectedLR)}`}><div className="ps-cell">{fPct(r.projectedLR)}</div></td>
                              </tr>
                            ))}
                            <tr className="ps-total">
                              <td className="ps-year"><div className="ps-cell">Total</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tUP)}</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tUL)}</div></td>
                              <td className={`ps-dash ${lrCls(tUP > 0 ? tUL / tUP : 0)}`}><div className="ps-cell">{fPct(tUP > 0 ? tUL / tUP : 0)}</div></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Actual Incurred table */}
                    <div className="ps-block">
                      <div className="ps-block-title">Actual Incurred</div>
                      <div className="ps-table-wrap">
                        <table className="ps-table">
                          <thead><tr><th>UW Year</th><th>Premium</th><th>Incurred</th><th>Inc. LR %</th></tr></thead>
                          <tbody>
                            {results.map(r => (
                              <tr key={r.year}>
                                <td className="ps-year"><div className="ps-cell">{r.year}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.premium)}</div></td>
                                <td className="ps-dash"><div className="ps-cell">{fmt0(r.actualLosses)}</div></td>
                                <td className={`ps-dash ${lrCls(r.actualLR)}`}><div className="ps-cell">{fPct(r.actualLR)}</div></td>
                              </tr>
                            ))}
                            <tr className="ps-total">
                              <td className="ps-year"><div className="ps-cell">Total</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tPrem)}</div></td>
                              <td className="ps-dash"><div className="ps-cell">{fmt0(tAL)}</div></td>
                              <td className={`ps-dash ${lrCls(tPrem > 0 ? tAL / tPrem : 0)}`}><div className="ps-cell">{fPct(tPrem > 0 ? tAL / tPrem : 0)}</div></td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
