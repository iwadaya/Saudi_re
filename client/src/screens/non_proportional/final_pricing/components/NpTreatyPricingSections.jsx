// components/NpTreatyPricingSections.jsx — Phase 4.1 extraction.
//
// Treaty-mode pricing tables: the actuarial-engine bar (and the
// no-structure notice), the Risk XL / Cat XL component tables, the
// combined Pricing table (reinsurer/lead/expiring + margins), and the
// Programme Limits & Downside table. JSX + per-row derivations moved
// verbatim from NpFinalPricing — props in, callbacks out, no logic
// changes.

import PctInput from '../../../../components/PctInput';
import { toN, fmtC } from '../formatters.js';
import NpLayerTable from './NpLayerTable.jsx';
import EqDamageRatioPanel from './EqDamageRatioPanel.jsx';

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   isQuote: boolean,
 *   isTerminal: boolean,
 *   mode: string,
 *   riskDisabled: boolean,
 *   catDisabled: boolean,
 *   npDetail: Record<string, any>,
 *   appState: Record<string, any>,
 *   structureLayers: Array<object>,
 *   runCalcEngine: () => Promise<void>,
 * }} props
 */
export default function NpTreatyPricingSections({
  pricing,
  isQuote,
  isTerminal,
  mode,
  riskDisabled,
  catDisabled,
  npDetail,
  appState,
  structureLayers,
  runCalcEngine,
  contractId,
  currency,
}) {
  const {
    layers, calcEngineRunning, calcEngineError, updateLayer,
    localStructureLayers, cedantProgLimit, contractAgg100, otherCountryAgg,
    progLimView, setProgLimView, setMarketModalOpen,
  } = pricing;
  const riskLayers = layers.filter(l => l.risk);
  const catLayers = layers.filter(l => l.cat);

  return (
    <>
              {/* ── Actuarial Engine bar ── */}
              {!isQuote && layers.length === 0 && (
                <div className="df-card df-card--notice" style={{ margin: '16px 0', padding: '20px 24px', borderRadius: 10, background: 'rgba(0,212,255,0.07)', border: '1px solid rgba(0,212,255,0.25)', display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span style={{ fontSize: 22 }}>⚠️</span>
                  <div>
                    <div style={{ fontWeight: 600, color: '#00d4ff', marginBottom: 4 }}>No structure defined yet</div>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
                      Please complete the <strong style={{ color: 'rgba(255,255,255,0.8)' }}>NP Structure</strong> screen first to define layers before pricing can be calculated.
                    </div>
                  </div>
                </div>
              )}

              {!isQuote && layers.length > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 2px', marginBottom:4 }}>
                  <button
                    className="np-btn np-btn--primary"
                    style={{ minWidth:160, fontWeight:700 }}
                    disabled={calcEngineRunning || !layers.length}
                    onClick={runCalcEngine}>
                    {calcEngineRunning ? '⟳ Calculating…' : '⚡ Run Actuarial Engine'}
                  </button>
                  <span style={{ fontSize:12, color:'rgba(226,232,240,0.55)' }}>
                    {mode === 'RISK' ? 'Pure Burn · Pareto · MBBEFD Exposure Rating'
                      : mode === 'CAT' ? 'Pure Burn · Pareto · CRESTA Exposure Rating'
                      : 'Pure Burn · Pareto · MBBEFD + CRESTA Exposure Rating'}
                  </span>
                  {calcEngineError && (
                    <span style={{ fontSize:12, color:'#f87171', marginLeft:'auto' }}>{calcEngineError}</span>
                  )}
                </div>
              )}

              {/* Risk XL Layers — pure burn & pareto use large losses; exposure uses MBBEFD risk profile */}
              {!isQuote && layers.length > 0 && !riskDisabled && <NpLayerTable section="RISK" rows={riskLayers} layers={layers} updateLayer={updateLayer} disabled={isTerminal} />}

              {/* Cat XL Layers — pure burn & pareto use cat losses; exposure uses damage ratio / CRESTA */}
              {!isQuote && layers.length > 0 && !catDisabled && <NpLayerTable section="CAT" rows={catLayers} layers={layers} updateLayer={updateLayer} disabled={isTerminal} />}

              {/* GEM deterministic EQ exposure rating — computes a ground-up EQ
                  loss from CRESTA aggregates × damage-ratio curves and applies
                  the effective damage ratio into a cat layer's exposure cell. */}
              {!isQuote && layers.length > 0 && !catDisabled && catLayers.length > 0 && (
                <EqDamageRatioPanel
                  contractId={contractId}
                  layers={layers}
                  catLayers={catLayers}
                  updateLayer={updateLayer}
                  currency={currency}
                  disabled={isTerminal}
                />
              )}

              {/* Combined Pricing + Programme Limits (standard only) */}
              {!isQuote && layers.length > 0 && (<>
              <section className="np-final-section">
                <div className="np-final-section-head" style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div className="np-final-section-title">Pricing</div>
                  <span className="np-badge">Combined</span>
                  <div style={{ flex:1 }} />
                  {/* Market intelligence trigger. Same call as the
                      pricing screen header used to host inside the
                      offer modal — now reachable without entering
                      the offer flow. */}
                  {(() => {
                    const npCountryId = appState.npTreatyDetail?.countryId || null;
                    const npCobIds = Array.isArray(appState.npTreatyDetail?.classOfBusinessIds)
                      ? appState.npTreatyDetail.classOfBusinessIds : [];
                    const npPrimaryCobId = npCobIds[0]
                      || appState.npTreatyDetail?.primaryClassOfBusinessId || null;
                    const npTargetYear = Number(npDetail?.startYear) || Number(npDetail?.uwYear) || null;
                    const marketAvailable = !!(npCountryId && npPrimaryCobId && npTargetYear);
                    return (
                      <button
                        type="button"
                        className="bbg-btn bbg-btn--outline"
                        disabled={!marketAvailable}
                        title={marketAvailable
                          ? 'Open the cached market intelligence report for this treaty'
                          : 'Country and class of business required for market intelligence.'}
                        onClick={() => marketAvailable && setMarketModalOpen(true)}
                        style={{
                          borderColor: marketAvailable ? 'rgba(103,232,249,0.45)' : 'rgba(255,255,255,0.14)',
                          color: marketAvailable ? '#67e8f9' : 'rgba(255,255,255,0.30)',
                          cursor: marketAvailable ? 'pointer' : 'not-allowed',
                        }}
                      >📊 Market Intelligence</button>
                    );
                  })()}
                </div>
                <div className="np-final-card np-final-card--flush">
                  <div className="np-final-table-wrap np-final-table-wrap--wide">
                    <table className="np-final-table np-final-table--pricing">
                      <thead><tr>
                        <th className="col-layer">Layer</th><th className="col-limit">Limit</th><th className="col-deductible">Deductible</th>
                        <th className="col-reinst">Reinstatements</th>
                        <th className="col-pct col-reinsurer">Reinsurer</th><th className="col-pct col-lead">Lead</th><th className="col-pct col-expiring">Expiring</th>
                        <th className="col-pct">Hist. Margin</th>
                        <th className="col-pct">Margin</th><th className="col-pct">Tech Ratio</th><th className="col-pct">% Diff</th>
                      </tr></thead>
                      <tbody>
                        {layers.map((l, i) => (
                          <tr key={i}>
                            <td className="col-layer"><span className={`np-layer-num-badge np-layer-num-badge--${l.layer}`}>{l.layer}</span></td><td className="col-limit">{fmtC(l.limit)}</td><td className="col-deductible">{fmtC(l.deductible)}</td>
                            <td>{(() => {
                              // Concatenate: numReinstatements @ reinstatementPct%
                              // e.g. "2@100%" means 2 reinstatements each at 100% of original premium
                              const n = String(l.noReinst ?? l.num_reinstatements ?? '').trim();
                              const pRaw = l.reinstPct ?? l.reinstatement_pct ?? '';
                              const p = String(pRaw ?? '').replace(/%/g, '').trim();
                              const nNum = parseInt(n, 10);
                              if (!n || !nNum || nNum <= 0) return '–';
                              const pNum = parseFloat(p);
                              if (!Number.isFinite(pNum)) return n;  // just show count if no %
                              return `${nNum}@${pNum.toFixed(0)}%`;
                            })()}</td>
                            <td className="col-reinsurer"><input className="np-mini-input np-mini-input--reinsurer" value={l.reinsurerPricing} onChange={e => updateLayer(i, 'reinsurerPricing', e.target.value)} /></td>
                            <td className="col-lead"><input className="np-mini-input np-mini-input--lead" value={l.leadPricing} onChange={e => updateLayer(i, 'leadPricing', e.target.value)} /></td>
                            <td className="col-expiring"><input className="np-mini-input np-mini-input--expiring" value={l.expiringPricing} onChange={e => updateLayer(i, 'expiringPricing', e.target.value)} /></td>
                            <td className="muted">{l.historicalMargin || '–'}</td>
                            <td className="muted">{l.reinsurerMargin || '–'}</td>
                            <td className="muted">{l.technicalRatio || '–'}</td>
                            <td>{(() => {
                              const rp = toN(l.reinsurerPricing);
                              const lp = toN(l.leadPricing);
                              if (!rp || !lp) return <span className="muted">–</span>;
                              const diff = ((rp / lp) - 1) * 100;
                              const sign = diff >= 0 ? '+' : '';
                              const cls = diff > 0 ? 'np-pct-diff--pos' : 'np-pct-diff--neg';
                              return <span className={cls}>{`${sign}${diff.toFixed(2)}%`}</span>;
                            })()}</td>
                          </tr>
                        ))}
                        <tr className="np-struct-total">
                          <td className="col-layer"><span className="np-layer-num-badge np-layer-num-badge--total">TOTAL</span></td>
                          <td className="col-limit"><b>{fmtC(layers.reduce((s, l) => s + toN(l.limit), 0))}</b></td>
                          <td className="col-deductible"></td>
                          <td></td>
                          {(() => {
                            const totalLim = layers.reduce((s, l) => s + toN(l.limit), 0);
                            if (!totalLim) return <><td></td><td></td><td></td><td></td><td></td><td></td><td></td></>;
                            const sp = f => layers.reduce((s, l) => s + toN(l.limit) * toN(l[f]), 0) / totalLim;
                            const wtdReins = sp('reinsurerPricing');
                            const wtdLead  = sp('leadPricing');
                            const wtdExp   = sp('expiringPricing');
                            // Hist margin weighted by premium (reinsurerPricing × limit)
                            const totalPrem = layers.reduce((s, l) => s + toN(l.limit) * toN(l.reinsurerPricing), 0);
                            const wtdHist  = totalPrem > 0
                              ? layers.reduce((s, l) => s + toN(l.limit) * toN(l.reinsurerPricing) * toN(l.historicalMargin), 0) / totalPrem
                              : 0;
                            // Tech ratio total = 1 − wtdHist − brokerage − taxes
                            const brokN  = toN(npDetail.brokeragePct);
                            const taxesN = toN(npDetail.taxesPct);
                            const wtdTech  = wtdHist !== 0 ? Math.max(0, 100 - wtdHist - brokN - taxesN) : 0;
                            const pctDiff  = wtdReins > 0 && wtdLead > 0 ? ((wtdReins / wtdLead) - 1) * 100 : null;
                            const fmt1 = v => v.toFixed(2) + '%';
                            const diffCls = pctDiff > 0 ? 'np-pct-diff--pos' : 'np-pct-diff--neg';
                            return (<>
                              <td className="col-pct col-reinsurer"><b>{wtdReins > 0 ? fmt1(wtdReins) : '–'}</b></td>
                              <td className="col-pct col-lead"><b>{wtdLead  > 0 ? fmt1(wtdLead)  : '–'}</b></td>
                              <td className="col-pct col-expiring"><b>{wtdExp   > 0 ? fmt1(wtdExp)   : '–'}</b></td>
                              <td><b>{wtdHist  !== 0 ? fmt1(wtdHist)  : '–'}</b></td>
                              <td><b>{(() => {
                                const wtdMargin = totalPrem > 0
                                  ? layers.reduce((s, l) => s + toN(l.limit) * toN(l.reinsurerPricing) * toN(l.reinsurerMargin), 0) / totalPrem
                                  : 0;
                                return wtdMargin !== 0 ? fmt1(wtdMargin) : '–';
                              })()}</b></td>
                              <td><b>{wtdTech  !== 0 ? fmt1(wtdTech)  : '–'}</b></td>
                              <td>{pctDiff !== null ? <span className={diffCls}><b>{`${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(2)}%`}</b></span> : '–'}</td>
                            </>);
                          })()}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>

              {/* ═══════ PROGRAMME LIMITS ═══════ */}
              {!isQuote && (() => {
                // Source structure layers for per-layer earned premium, reinstatements, peril
                const srcLayers = localStructureLayers.length ? localStructureLayers : structureLayers;
                // cedantProgLimit = server-computed: sum of effective limits across all
                // same-cedant same-COB NP contracts. Loaded on mount.

                // Pre-compute programme totals from the pricing layers[] which have merged
                // structure data (egnpi, rate, earnedPremium, limit, risk, cat) already applied.
                // Using layers[] avoids srcLayers index-mismatch when structure and pricing
                // have different layer counts.

                // Layer EP: earned_premium if set, else EGNPI × rate / 100
                const layerEP = (l, sl) => {
                  const ep = toN(l.earnedPremium) || toN(sl.earnedPremium) || toN(sl.earned_premium) || 0;
                  if (ep > 0) return ep;
                  const egnpi = toN(l.egnpi) || toN(sl.egnpi) || 0;
                  const rate  = toN(l.rate)  || toN(sl.rate)  || 0;
                  return (egnpi > 0 && rate > 0) ? Math.round(egnpi * rate / 100) : 0;
                };

                // Total earned premium across ALL layers (share × this = premium per row)
                const totalEP = layers.reduce((s, l, i) => {
                  const sl = srcLayers[i] || {};
                  return s + layerEP(l, sl);
                }, 0);

                // Total limit for all Risk-covering layers
                const totalRiskLimit = layers.reduce((s, l, i) => {
                  const sl  = srcLayers[i] || {};
                  const isR = sl.riskCover ?? sl.risk ?? l.riskCover ?? l.risk ?? true;
                  return s + (isR ? (toN(sl.limit) || toN(l.limit) || 0) : 0);
                }, 0);

                // Total limit for all Cat-covering layers
                const totalCatLimit = layers.reduce((s, l, i) => {
                  const sl  = srcLayers[i] || {};
                  const isC = sl.catCover ?? sl.cat ?? l.catCover ?? l.cat ?? true;
                  return s + (isC ? (toN(sl.limit) || toN(l.limit) || 0) : 0);
                }, 0);

                const rowCalc = (l, i) => {
                  const sl       = srcLayers[i] || {};
                  const sharePct = toN(l.share);   // e.g. 10.00 means 10%
                  const shareFrac= sharePct / 100;
                  // Prefer layers[] (merged) for limit, then srcLayers
                  const lim      = toN(l.limit) || toN(sl.limit) || toN(sl.layer_limit) || 0;

                  // Premium: share × total programme earned premium (all layers)
                  const prem = shareFrac > 0 && totalEP > 0 ? Math.round(totalEP * shareFrac) : 0;

                  // Per Risk Limit: share × total limit of ALL risk-covering layers
                  const perRisk = shareFrac > 0 && totalRiskLimit > 0 ? Math.round(totalRiskLimit * shareFrac) : 0;

                  // Cat Limit: share × total limit of ALL cat-covering layers
                  const catLim = shareFrac > 0 && totalCatLimit > 0 ? Math.round(totalCatLimit * shareFrac) : 0;

                  // Cedant Total Limit:
                  // Server returns totalLimit = sum of (effective_line_pct/100 × structure_limit)
                  // across ALL contracts for this cedant with overlapping COBs.
                  // Per row: share% × totalLimit (same formula as premium/perRisk/catLim)
                  const cedantTot = shareFrac > 0 && cedantProgLimit > 0
                    ? Math.round(cedantProgLimit * shareFrac) : 0;

                  // Annual Aggregate Limit: from structure if set, else limit×(1+reinstatements)×share
                  const structAAL = toN(l.annualAggLimit) || toN(sl.annualAggLimit) || toN(sl.aggregate_limit) || 0;
                  const noReinst  = toN(l.noReinst) || toN(sl.noReinst) || toN(sl.reinstatements) || toN(sl.num_reinstatements) || 0;
                  const aal = shareFrac > 0
                    ? (structAAL > 0
                        ? Math.round(structAAL * shareFrac)
                        : Math.round(lim * (1 + noReinst) * shareFrac))
                    : 0;

                  // Expected Shortfall: standard XL ES = ROL% × Limit × (1 + 0.5×noReinst) × share
                  // Approximates average loss given exhaustion (50% chance of using reinstatements)
                  const rolPct = toN(l.reinsurerPricing) || toN(l.leadPricing);
                  const es = shareFrac > 0 && rolPct > 0 && lim > 0
                    ? Math.round(lim * (rolPct / 100) * (1 + 0.5 * noReinst) * shareFrac) : 0;

                  return { prem, perRisk, catLim, cedantTot, aal, es, shareFrac };
                };

                const totals = layers.reduce((acc, l, i) => {
                  const r = rowCalc(l, i);
                  return {
                    prem:      acc.prem      + r.prem,
                    perRisk:   acc.perRisk   + r.perRisk,
                    catLim:    acc.catLim    + r.catLim,
                    cedantTot: acc.cedantTot + r.cedantTot,
                    aal:       acc.aal       + r.aal,
                  };
                }, { prem: 0, perRisk: 0, catLim: 0, cedantTot: 0, aal: 0 });

                const fmtV = v => v > 0 ? v.toLocaleString() : '–';
                const cTd  = { textAlign: 'center', fontVariantNumeric: 'tabular-nums' };
                const roInp = (val, placeholder) => (
                  <input className="np-mini-input np-mini-input--center np-mini-input--readonly"
                    style={{ width: '100%', minWidth: 90 }} readOnly
                    value={val > 0 ? val.toLocaleString() : ''} placeholder={placeholder || '–'} />
                );
                const shareInp = (val, idx) => (
                  <PctInput
                    key={`share-${idx}`}
                    className="np-mini-input np-mini-input--center"
                    style={{ width: '100%', minWidth: 60, maxWidth: 80 }}
                    value={val}
                    placeholder="0%"
                    readOnly={isTerminal}
                    onChange={v => updateLayer(idx, 'share', v)}
                  />
                );

                return (
                  <section className="np-final-section">
                    <div className="np-final-section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div className="np-final-section-title">Programme Limits</div>
                      <div className="view-tabs" role="tablist" aria-label="Programme limits view">
                        {[['limits','LIMITS'],['optimal','OPTIMAL SHARES']].map(([k,label]) => (
                          <button
                            key={k}
                            type="button"
                            className={`view-tab${progLimView === k ? ' is-active' : ''}`}
                            role="tab"
                            aria-selected={progLimView === k}
                            onClick={() => setProgLimView(k)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="np-final-card np-final-card--flush">
                      <div style={{ padding: '7px 14px', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.35)', borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
                        Programme Limits &amp; Downside
                      </div>
                      <div className="np-final-table-wrap np-final-table-wrap--wide">
                        <table className="np-final-wide-table--programme">
                          <thead><tr>
                            <th className="col-layer"    style={{ textAlign: 'center' }}>Layer</th>
                            <th style={{ textAlign: 'center', minWidth: 70, maxWidth: 80 }}>Share</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Premium</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Per Risk Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Cat Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Cedant Total Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Agg Contribution</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Total Country Agg</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Annual Aggregate Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Expected Shortfall</th>
                          </tr></thead>
                          <tbody>
                            {layers.map((l, i) => {
                              const r = rowCalc(l, i);
                              return (
                                <tr key={i}>
                                  <td className="col-layer" style={{ textAlign: 'center' }}>{l.layer || `L${i+1}`}</td>
                                  <td style={{ ...cTd, padding: '4px 6px' }}>{shareInp(l.share, i)}</td>
                                  <td style={cTd}>{roInp(r.prem)}</td>
                                  <td style={cTd}>{roInp(r.perRisk)}</td>
                                  <td style={cTd}>{roInp(r.catLim)}</td>
                                  <td style={cTd}>{roInp(r.cedantTot)}</td>
                                  <td style={cTd}>{roInp(r.shareFrac > 0 && contractAgg100 > 0 ? Math.round(contractAgg100 * r.shareFrac) : 0)}</td>
                                  <td style={cTd}>{roInp(r.shareFrac > 0 ? Math.round(otherCountryAgg + contractAgg100 * r.shareFrac) : 0)}</td>
                                  <td style={cTd}>{roInp(r.aal)}</td>
                                  <td style={cTd}>{roInp(r.es)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="np-struct-total">
                              <td style={{ textAlign: 'center' }}><b>Total</b></td>
                              <td></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.prem)}</b></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.perRisk)}</b></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.catLim)}</b></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.cedantTot)}</b></td>
                              <td></td>
                              <td></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.aal)}</b></td>
                              <td></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  </section>
                );
              })()}

              </>)}
    </>
  );
}
