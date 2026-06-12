// components/FQQuotePricingPanel.jsx — Phase 4.1 extraction.
//
// The entire quote-mode (Final Quote) pricing surface: QuickBenchmark-
// style topbar, treaty-details card, calibration badge, expiring
// structure table, implied pricing curve, COB participation tables, the
// dynamic quote structures, and the COB select modal. JSX moved
// verbatim from NpFinalPricing's isQuote branch — props in, callbacks
// out, no logic changes. All state arrives through the `pricing`
// reducer surface (hooks/useNpPricingState.ts).

import React, { useId } from 'react';
import { formatWithCommas } from '../../../../utils/format';
import { toN } from '../formatters.js';
import { FQ_STRUCTURE_COLORS } from '../fqHelpers.js';
import {
  expLayerEarnedPremium,
  QM_MAX_LAYERS,
  QM_MAX_STRUCTURES,
  quoteLayerDerived,
} from '../fqQuoteMath.js';
import FQCobSelectModal from './FQCobSelectModal.jsx';
import { FQNumCell, FQPctCell, FQReadCell } from './FQCells.jsx';
import FQPricingCurve from './FQPricingCurve.jsx';
import FQCobParticipationTable from './FQCobParticipationTable.jsx';

const quoteInsightButtonStyle = {
  width: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  padding: '9px 14px',
  borderRadius: 10,
  lineHeight: 1,
};

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   npDetail: Record<string, any>,
 *   currency: string,
 *   riskDisabled: boolean,
 *   catDisabled: boolean,
 *   save: (options?: object) => Promise<boolean>,
 *   runQuoteCalcEngine: (structureIndex?: number|null) => Promise<void>,
 *   showToast: ((message: string) => void) | undefined,
 * }} props
 */
export default function FQQuotePricingPanel({
  pricing,
  npDetail,
  currency,
  riskDisabled,
  catDisabled,
  save,
  runQuoteCalcEngine,
  showToast,
}) {
  const numExpLayersSelectId = useId();
  const {
    snap, offerStatus, calcEngineRunning, saveState, runningStructures,
    selectedCobs, cobList, showCobModal, setShowCobModal, setSelectedCobs,
    quoteCurve, expLayers, numExpLayers, applyNumExpLayers, editExpLayer,
    clientStructures, approvedStructures, setApprovedQuoteStructure,
    addQuoteStructure, addClientStructureLayer, removeClientStructureLayer,
    removeClientStructure, updateClientStructureLayer,
    openBenchmark, openPricingGraph, openPricingAnalysis,
    getCobFlags, getCobUwLimit, updateUwLimit, setCobToggle,
  } = pricing;
  // Derived per-layer values for the quote-pricing columns —
  // mirrors NpLayerTable's display logic but stays string-safe for
  // fields the user hasn't typed yet.
  const computeLayerDerived = quoteLayerDerived;

  return (
                /* ═══════ QUOTE PRICING — QuickBenchmark-style topbar ═══════
                   Mirrors /np/benchmark visually: sticky bm-topbar with
                   logo + title + status pill, then a bm-card--meta grid
                   surfacing the four treaty-detail fields. Read-only
                   here — values come from npTreatyDetail (set on the
                   Treaty Detail step). */
                <>
                  <header className="bm-topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 12 }}>
                    <div className="bm-topbar-left">
                      <div className="bm-logo">QT</div>
                      <div>
                        <div className="bm-topbar-title">QUOTE PRICING</div>
                        <div className="bm-topbar-sub">
                          Treaty Quote Workflow
                          {snap.cedant && snap.cedant !== '–' && (
                            <span className="bm-topbar-context"> · {snap.cedant}</span>
                          )}
                          {npDetail.quoteRef && (
                            <span className="bm-topbar-context"> · {npDetail.quoteRef}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="bm-topbar-right">
                      <button
                        className="bm-pill"
                        onClick={() => runQuoteCalcEngine()}
                        disabled={calcEngineRunning || !clientStructures.length}
                        style={{ borderColor: 'rgba(56,189,248,0.45)', color: '#38bdf8', background: 'rgba(56,189,248,0.08)' }}
                        title="Recalculate all quote structures: pure burn, Pareto, and exposure with the NP actuarial engine"
                      >
                        {calcEngineRunning ? 'Calculating...' : 'Run Actuarial Engine'}
                      </button>
                      {/* Explicit Save — saves expiring layers, structures,
                          COB selection + UW limits + toggles in one shot.
                          Reuses the same save() the wizard nav already
                          calls so we have one code path. */}
                      <button
                        className="bm-pill"
                        onClick={async () => { const ok = await save(); if (ok) showToast?.('Saved'); else showToast?.('Save failed'); }}
                        disabled={saveState.status === 'saving'}
                        style={{ borderColor: 'rgba(35,209,139,0.45)', color: '#23d18b', background: 'rgba(35,209,139,0.08)' }}
                        title="Save expiring layers, structures, COB selection, and underwriting limits"
                      >
                        {saveState.status === 'saving' ? '⏳ Saving…'
                          : saveState.status === 'error' ? '⚠ Retry Save'
                          : saveState.status === 'saved' ? '✓ Saved'
                          : '💾 Save'}
                      </button>
                      <span className="bm-pill" style={{ cursor: 'default' }}>
                        {(offerStatus || 'DRAFT').replace(/_/g, ' ')}
                      </span>
                    </div>
                  </header>

                  {/* Treaty Details — read-only, sourced from earlier wizard steps */}
                  <section className="bm-card bm-card--meta" style={{ marginBottom: 12 }}>
                    <div className="bm-card-header" style={{ borderBottom: 'none' }}>
                      <div className="bm-card-title">Treaty Details</div>
                    </div>
                    <div className="bm-meta-grid">
                      <div className="bm-field">
                        <span className="bm-label">Cedant</span>
                        <div className="bm-input" style={{ background: 'rgba(255,255,255,0.02)' }}>
                          {snap.cedant && snap.cedant !== '–' ? snap.cedant : '—'}
                        </div>
                      </div>
                      <div className="bm-field">
                        <span className="bm-label">Class of Business</span>
                        <button className="bm-input bm-input--btn" onClick={() => setShowCobModal(true)} type="button">
                          <span style={{ color: selectedCobs.length ? 'rgba(226,232,240,0.90)' : 'rgba(255,255,255,0.30)' }}>
                            {selectedCobs.length ? selectedCobs.map((c) => c.name).join(', ') : '— Select COB —'}
                          </span>
                          <span className="bm-input-chevron">▾</span>
                        </button>
                      </div>
                      <div className="bm-field">
                        <span className="bm-label">Currency</span>
                        <div className="bm-input" style={{ background: 'rgba(255,255,255,0.02)' }}>
                          {currency || '—'}
                        </div>
                      </div>
                      <div className="bm-field">
                        <span className="bm-label">Country</span>
                        <div className="bm-input" style={{ background: 'rgba(255,255,255,0.02)' }}>
                          {npDetail.countryName || npDetail.country || '—'}
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* ── Calibration badge (mirrors QuickBenchmark's curve calibration row). */}
                  <div className="bm-curve-badge-row" style={{ marginBottom: 12 }}>
                    <div className={`bm-curve-badge ${quoteCurve.fit.calibrated ? 'bm-curve-badge--live' : 'bm-curve-badge--market'}`}>
                      {quoteCurve.fit.calibrated ? 'Calibrated from expiring' : 'Market default (a=0.108, b=-1.074)'}
                      <span>a={quoteCurve.fit.a.toFixed(5)}</span>
                      <span>b={quoteCurve.fit.b.toFixed(4)}</span>
                      {quoteCurve.fit.r2 != null && <span>R2={quoteCurve.fit.r2.toFixed(3)}</span>}
                      {!quoteCurve.fit.calibrated && <span style={{ opacity: 0.55 }}>Add &gt;=2 expiring layers with rates to calibrate</span>}
                    </div>
                  </div>

                  {/* ── Expiring Structure (first structure) ── */}
                  <section className="bm-card" style={{ marginBottom: 12 }}>
                    <div className="bm-card-header">
                      <div>
                        <div className="bm-card-title">Expiring Structure</div>
                        <div className="bm-card-hint">Known market terms — first structure on the quote.</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <button
                          className="bbg-ib bbg-ib--blue"
                          style={quoteInsightButtonStyle}
                          onClick={() => openBenchmark('country', 'Expiring Structure', expLayers)}
                        >
                          Analysis
                        </button>
                        <label className="bm-label" style={{ margin: 0 }} htmlFor={numExpLayersSelectId}>Number of Layers</label>
                        <select
                          id={numExpLayersSelectId}
                          className="bm-input"
                          style={{ width: 90 }}
                          value={numExpLayers}
                          onChange={(e) => {
                            const n = Math.max(1, Math.min(QM_MAX_LAYERS, parseInt(e.target.value, 10) || 1));
                            applyNumExpLayers(n);
                          }}
                        >
                          {Array.from({ length: QM_MAX_LAYERS }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="bm-table-wrap">
                      <table className="bm-table" style={{ minWidth: 1600, tableLayout: 'fixed' }}>
                        <colgroup>{[
                          <col key="layer" style={{ width: 58 }} />,
                          <col key="limit" style={{ width: 127 }} />,
                          <col key="attachment" style={{ width: 127 }} />,
                          <col key="egnpi" style={{ width: 127 }} />,
                          <col key="rate" style={{ width: 81 }} />,
                          <col key="earnedPremium" style={{ width: 127 }} />,
                          <col key="rol" style={{ width: 81 }} />,
                          <col key="mdp" style={{ width: 81 }} />,
                          <col key="reinstatements" style={{ width: 81 }} />,
                          <col key="pctReinst" style={{ width: 81 }} />,
                          <col key="risk" style={{ width: 64 }} />,
                          <col key="cat" style={{ width: 64 }} />,
                          <col key="pAttach" style={{ width: 104 }} />,
                          <col key="pExhaust" style={{ width: 104 }} />,
                        ]}</colgroup>
                        <thead>
                          <tr>
                            <th>Layer</th>
                            <th>Limit</th>
                            <th>Attachment</th>
                            <th>EGNPI</th>
                            <th>Rate %</th>
                            <th>Earned Premium</th>
                            <th>ROL</th>
                            <th>MDP</th>
                            <th>Reinst</th>
                            <th>Reinst %</th>
                            <th>Risk</th>
                            <th>Cat</th>
                            <th>P(Attach)</th>
                            <th>P(Exh)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expLayers.map((l, i) => {
                            const setField = (field, val) => editExpLayer(i, field, val);
                            const attachmentLocked = i > 0;
                            return (
                              <tr key={l.id}>
                                <td style={{ textAlign: 'center' }}><span className="bm-badge bm-badge--exp">{i + 1}</span></td>
                                <td><FQNumCell value={l.limit}          onChange={(v) => setField('limit', v)} /></td>
                                <td>
                                  {attachmentLocked
                                    ? <FQNumCell value={l.attachment} onChange={() => {}} className="bm-cell" style={{ opacity: 0.6, pointerEvents: 'none' }} />
                                    : <FQNumCell value={l.attachment} onChange={(v) => setField('attachment', v)} />}
                                </td>
                                <td><FQNumCell value={l.egnpi}          onChange={(v) => setField('egnpi', v)} /></td>
                                <td><FQPctCell value={l.rate}           onChange={(v) => setField('rate', v)} /></td>
                                <td>
                                  <FQReadCell
                                    value={l.earnedPremium ? formatWithCommas(String(Math.round(toN(l.earnedPremium)))) : ''}
                                    className="bm-cell bm-cell--display bm-cell--muted"
                                  />
                                </td>
                                <td><FQPctCell value={l.rol}            onChange={(v) => setField('rol', v)} /></td>
                                <td><FQNumCell value={l.mdp}            onChange={(v) => setField('mdp', v)} className="bm-cell bm-cell--sm" /></td>
                                <td><input className="bm-cell bm-cell--sm" value={l.reinstatements} onChange={(e) => setField('reinstatements', e.target.value)} placeholder="—" /></td>
                                <td><FQPctCell value={l.pctReinst}      onChange={(v) => setField('pctReinst', v)} /></td>
                                <td style={{ textAlign: 'center' }}><input type="checkbox" className="np-check" checked={!!l.risk} onChange={() => setField('risk', !l.risk)} /></td>
                                <td style={{ textAlign: 'center' }}><input type="checkbox" className="np-check" checked={!!l.cat}  onChange={() => setField('cat', !l.cat)} /></td>
                                <td><FQPctCell value={l.pAttach}        onChange={(v) => setField('pAttach', v)} /></td>
                                <td><FQPctCell value={l.pExhaust}       onChange={(v) => setField('pExhaust', v)} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                        {(() => {
                          const totLim   = expLayers.reduce((s, l) => s + toN(l.limit), 0);
                          const totAtt   = expLayers.reduce((s, l) => s + toN(l.attachment), 0);
                          const totEgnpi = expLayers.reduce((s, l) => s + toN(l.egnpi), 0);
                          const totEp    = expLayers.reduce((s, l) => s + expLayerEarnedPremium(l), 0);
                          const wRate    = totEgnpi > 0 ? (totEp / totEgnpi) * 100 : 0;
                          const wRol     = totLim > 0 ? (totEp / totLim) * 100 : 0;
                          if (totLim <= 0 && totEgnpi <= 0) return null;
                          return (
                            <tfoot>
                              <tr className="bm-foot">
                                <td><FQReadCell value="TOTAL" className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totLim   > 0 ? formatWithCommas(String(Math.round(totLim)))   : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totAtt   > 0 ? formatWithCommas(String(Math.round(totAtt)))   : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totEgnpi > 0 ? formatWithCommas(String(Math.round(totEgnpi))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={wRate > 0 ? `${wRate.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totEp > 0 ? formatWithCommas(String(Math.round(totEp))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={wRol  > 0 ? `${wRol.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                <td colSpan={7}></td>
                              </tr>
                            </tfoot>
                          );
                        })()}
                      </table>
                    </div>
                  </section>

                  {/* ── Implied Pricing Curve ── */}
                  <section className="bm-card bm-card--curve" style={{ marginBottom: 12 }}>
                    <div className="bm-card-header">
                      <div>
                        <div className="bm-card-title">Implied Pricing Curve</div>
                        <div className="bm-card-hint">Violet = expiring · Coloured dots = new structure layers priced on curve</div>
                      </div>
                    </div>
                    <div className="bm-curve-svg-wrap">
                      <FQPricingCurve curve={quoteCurve} />
                    </div>
                  </section>

                  <FQCobParticipationTable scope="exp" tableLayers={expLayers} title="Expiring Underwriting Limits" currency={currency} selectedCobs={selectedCobs} getCobFlags={getCobFlags} getCobUwLimit={getCobUwLimit} updateUwLimit={updateUwLimit} setCobToggle={setCobToggle} />

                  {/* ── Additional structures (dynamic) ── */}
                  {clientStructures.map((str, sIdx) => {
                    const color = FQ_STRUCTURE_COLORS[sIdx % FQ_STRUCTURE_COLORS.length];
                    const setStrLayer = (lIdx, field, val) => updateClientStructureLayer(sIdx, lIdx, field, val);
                    const addLayer = () => addClientStructureLayer(sIdx);
                    const removeLayer = (lIdx) => removeClientStructureLayer(sIdx, lIdx);
                    const removeStructure = () => removeClientStructure(sIdx);
                    const isApprovedStructure = !!approvedStructures[sIdx];
                    return (
                      <React.Fragment key={str.id}>
                        <section className="bm-card" style={{ marginBottom: 12, borderColor: `${color}22` }}>
                        <div className="bm-card-header">
                          <div>
                            <div className="bm-card-title" style={{ color }}>Structure {sIdx + 1}</div>
                            <div className="bm-card-hint">Layers for pricing.</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                className="bbg-ib bbg-ib--blue"
                                onClick={() => openPricingGraph(`Structure ${sIdx + 1}`, str)}
                                style={quoteInsightButtonStyle}
                              >
                                Pricing Graph
                              </button>
                              <button
                                className="bbg-ib bbg-ib--cyan"
                                onClick={() => openPricingAnalysis(sIdx)}
                                style={quoteInsightButtonStyle}
                              >
                                Pricing Analysis
                              </button>
                              <button
                                className="bbg-ib bbg-ib--violet"
                                onClick={() => openBenchmark('country', `Structure ${sIdx + 1}`, str.layers)}
                                style={quoteInsightButtonStyle}
                              >
                                Market Analysis
                              </button>
                              <label
                                className={`bbg-ib ${isApprovedStructure ? 'bbg-ib--green' : 'bbg-ib--ghost'}`}
                                style={{ ...quoteInsightButtonStyle, gap: 7, cursor: 'pointer' }}
                                title="Include this structure in the Chief Underwriter approval submission"
                              >
                                <input
                                  type="checkbox"
                                  className="np-check"
                                  aria-label={`Send Structure ${sIdx + 1} for Approval`}
                                  checked={isApprovedStructure}
                                  onChange={(e) => setApprovedQuoteStructure(sIdx, e.target.checked)}
                                  style={{ margin: 0 }}
                                />
                                Send for Approval
                              </label>
                            </div>
                            <button
                              className="bbg-ib bbg-ib--cyan"
                              style={quoteInsightButtonStyle}
                              disabled={saveState.status === 'saving' || !!runningStructures[sIdx]}
                              title="Save the quote, then run the actuarial engine for this structure (risk + cat burn / Pareto / exposure)"
                              onClick={async () => {
                                const ok = await save();
                                if (!ok) { showToast?.('Save failed'); return; }
                                await runQuoteCalcEngine(sIdx);
                                showToast?.(`Structure ${sIdx + 1} saved & calculated`);
                              }}
                            >
                              {runningStructures[sIdx] ? 'Calculating…'
                                : saveState.status === 'saving' ? 'Saving…'
                                : '💾 Save & Calc'}
                            </button>
                            <button
                              className="bbg-ib bbg-ib--green"
                              style={quoteInsightButtonStyle}
                              onClick={addLayer}
                              disabled={str.layers.length >= QM_MAX_LAYERS}
                            >
                              + Layer
                            </button>
                            <button
                              className="bbg-ib bbg-ib--pink"
                              style={{ ...quoteInsightButtonStyle, padding: '9px 12px' }}
                              onClick={removeStructure}
                              title="Remove structure"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div className="bm-table-wrap">
                          <table className="bm-table" style={{ minWidth: 1853, tableLayout: 'fixed' }}>
                            <colgroup>{[
                              <col key="layer" style={{ width: 58 }} />,
                              <col key="limit" style={{ width: 127 }} />,
                              <col key="deductible" style={{ width: 127 }} />,
                              <col key="risk" style={{ width: 64 }} />,
                              <col key="cat" style={{ width: 64 }} />,
                              <col key="pureBurn" style={{ width: 92 }} />,
                              <col key="pareto" style={{ width: 92 }} />,
                              <col key="burnPareto" style={{ width: 104 }} />,
                              <col key="exposure" style={{ width: 104 }} />,
                              <col key="wtBurn" style={{ width: 92 }} />,
                              <col key="wtPareto" style={{ width: 92 }} />,
                              <col key="wtExp" style={{ width: 92 }} />,
                              <col key="loading" style={{ width: 92 }} />,
                              <col key="totalRol" style={{ width: 104 }} />,
                              <col key="uwPrice" style={{ width: 104 }} />,
                              <col key="pAttach" style={{ width: 104 }} />,
                              <col key="pExhaust" style={{ width: 104 }} />,
                              <col key="delete" style={{ width: 41 }} />,
                            ]}</colgroup>
                            <thead>
                              <tr>
                                <th>Layer</th>
                                <th>Limit</th>
                                <th>Deductible</th>
                                <th>Risk</th>
                                <th>Cat</th>
                                <th>Pure Burn</th>
                                <th>Pareto</th>
                                <th>Burn+Pareto</th>
                                <th>Exposure</th>
                                <th>Wt Burn %</th>
                                <th>Wt Pareto %</th>
                                <th>Wt Exp %</th>
                                <th>Loading %</th>
                                <th>Total ROL</th>
                                <th style={{ color: '#00d4ff' }}>UW Price</th>
                                <th>P(Attach)</th>
                                <th>P(Exh)</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {str.layers.map((l, lIdx) => {
                                const d = computeLayerDerived(l);
                                return (
                                  <tr key={l.id}>
                                    <td style={{ textAlign: 'center' }}>
                                      <span className="bm-badge" style={{ background: `${color}14`, borderColor: `${color}35`, color }}>{lIdx + 1}</span>
                                    </td>
                                    <td><FQNumCell value={l.limit}      onChange={(v) => setStrLayer(lIdx, 'limit', v)} /></td>
                                    <td>
                                      {lIdx > 0
                                        ? <FQNumCell value={l.attachment} onChange={() => {}} className="bm-cell" style={{ opacity: 0.6, pointerEvents: 'none' }} />
                                        : <FQNumCell value={l.attachment} onChange={(v) => setStrLayer(lIdx, 'attachment', v)} />}
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        className="np-check"
                                        aria-label={`Structure ${sIdx + 1} Layer ${lIdx + 1} Risk`}
                                        checked={!!l.risk}
                                        disabled={riskDisabled}
                                        onChange={(e) => setStrLayer(lIdx, 'risk', e.target.checked)}
                                      />
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        className="np-check"
                                        aria-label={`Structure ${sIdx + 1} Layer ${lIdx + 1} Cat`}
                                        checked={!!l.cat}
                                        disabled={catDisabled}
                                        onChange={(e) => setStrLayer(lIdx, 'cat', e.target.checked)}
                                      />
                                    </td>
                                    <td><FQPctCell value={l.pureBurn}    onChange={(v) => setStrLayer(lIdx, 'pureBurn', v)} /></td>
                                    <td><FQPctCell value={l.pareto}      onChange={(v) => setStrLayer(lIdx, 'pareto', v)} /></td>
                                    <td>
                                      <FQReadCell
                                        value={d.burnPlusPareto > 0 ? `${d.burnPlusPareto.toFixed(2)}%` : '—'}
                                        className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc"
                                      />
                                    </td>
                                    <td><FQPctCell value={l.exposure}    onChange={(v) => setStrLayer(lIdx, 'exposure', v)} /></td>
                                    <td><FQPctCell value={l.wtBurn}      onChange={(v) => setStrLayer(lIdx, 'wtBurn', v)} /></td>
                                    <td><FQPctCell value={l.wtPareto}    onChange={(v) => setStrLayer(lIdx, 'wtPareto', v)} /></td>
                                    <td>
                                      <FQReadCell
                                        value={`${d.wtExp.toFixed(0)}%`}
                                        className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc"
                                      />
                                    </td>
                                    <td><FQPctCell value={l.loading}     onChange={(v) => setStrLayer(lIdx, 'loading', v)} /></td>
                                    <td>
                                      <FQReadCell
                                        value={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—'}
                                        className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent bm-calc"
                                      />
                                    </td>
                                    <td><FQPctCell value={l.uwPrice}     onChange={(v) => setStrLayer(lIdx, 'uwPrice', v)} placeholder={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—%'} /></td>
                                    <td><FQPctCell value={l.pAttach}     onChange={(v) => setStrLayer(lIdx, 'pAttach', v)} /></td>
                                    <td><FQPctCell value={l.pExhaust}    onChange={(v) => setStrLayer(lIdx, 'pExhaust', v)} /></td>
                                    <td><button className="bm-del" onClick={() => removeLayer(lIdx)}>✕</button></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            {(() => {
                              const totLim = str.layers.reduce((s, l) => s + toN(l.limit), 0);
                              if (totLim <= 0) return null;
                              // Limit-weighted averages for the percentage columns
                              const wAvg = (key) => {
                                const num = str.layers.reduce((s, l) => s + toN(l.limit) * toN(l[key]), 0);
                                return totLim > 0 ? num / totLim : 0;
                              };
                              const wAvgDerived = (selector) => {
                                const num = str.layers.reduce((s, l) => s + toN(l.limit) * selector(computeLayerDerived(l)), 0);
                                return totLim > 0 ? num / totLim : 0;
                              };
                              const wPureBurn  = wAvg('pureBurn');
                              const wPareto    = wAvg('pareto');
                              const wExposure  = wAvg('exposure');
                              const wTotalRol  = wAvgDerived((d) => d.totalRol);
                              const wUwPrice   = wAvg('uwPrice');
                              const avg = (key, dflt) => {
                                const vals = str.layers.map((l) => toN(l[key]) || toN(dflt));
                                if (!vals.length) return 0;
                                return vals.reduce((s, v) => s + v, 0) / vals.length;
                              };
                              return (
                                <tfoot>
                                  <tr className="bm-foot" style={{ borderTopColor: `${color}25` }}>
                                    <td><FQReadCell value="TOTAL" className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={formatWithCommas(String(Math.round(totLim)))} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td></td>
                                    <td></td>
                                    <td></td>
                                    <td><FQReadCell value={wPureBurn  > 0 ? `${wPureBurn.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={wPareto    > 0 ? `${wPareto.toFixed(2)}%`    : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={(wPureBurn + wPareto) > 0 ? `${(wPureBurn + wPareto).toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={wExposure  > 0 ? `${wExposure.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${avg('wtBurn', '50').toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${avg('wtPareto', '0').toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${(100 - avg('wtBurn', '50') - avg('wtPareto', '0')).toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${avg('loading', '15').toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={wTotalRol > 0 ? `${wTotalRol.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent" /></td>
                                    <td><FQReadCell value={wUwPrice  > 0 ? `${wUwPrice.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent" /></td>
                                    <td></td>
                                    <td></td>
                                    <td></td>
                                  </tr>
                                </tfoot>
                              );
                            })()}
                          </table>
                        </div>
                        </section>
                        <FQCobParticipationTable scope={str.id} tableLayers={str.layers} title="Underwriting Limits" currency={currency} selectedCobs={selectedCobs} getCobFlags={getCobFlags} getCobUwLimit={getCobUwLimit} updateUwLimit={updateUwLimit} setCobToggle={setCobToggle} />
                      </React.Fragment>
                    );
                  })}

                  {/* ── Add Structure button ── */}
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 16px' }}>
                    <button
                      className="bm-pill"
                      onClick={addQuoteStructure}
                      disabled={clientStructures.length >= QM_MAX_STRUCTURES}
                      style={{ padding: '10px 22px', borderColor: 'rgba(35,209,139,0.35)', color: '#23d18b', background: 'rgba(35,209,139,0.06)' }}
                    >
                      + Add Structure
                    </button>
                  </div>

                  {showCobModal && (
                    <FQCobSelectModal
                      selected={selectedCobs.map((c) => c.id)}
                      cobList={cobList}
                      onSave={(ids) => {
                        const map = new Map(cobList.map((c) => [c.id, c.name]));
                        setSelectedCobs((prev) => {
                          const prevMap = new Map(prev.map((c) => [c.id, c]));
                          return ids.map((id) => prevMap.get(id) || { id, name: map.get(id) || id, uwLimit: '' });
                        });
                        setShowCobModal(false);
                      }}
                      onClose={() => setShowCobModal(false)}
                    />
                  )}
                </>
  );
}
