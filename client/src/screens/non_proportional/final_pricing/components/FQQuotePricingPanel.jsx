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
import { FQ_STRUCTURE_COLORS, fqGeomean, fqPriceLayerOnCurve } from '../fqHelpers.js';
import { REINSTATEMENT_OPTIONS } from '../../reinstatementOptions';
import {
  expLayerEarnedPremium,
  QM_MAX_LAYERS,
  QM_MAX_STRUCTURES,
} from '../fqQuoteMath.js';
import FQCobSelectModal from './FQCobSelectModal.jsx';
import { FQNumCell, FQPctCell, FQReadCell } from './FQCells.jsx';
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
                        <button
                          className="bbg-ib bbg-ib--blue"
                          style={quoteInsightButtonStyle}
                          onClick={() => openPricingGraph('Pricing Curve', { id: 'expiring', layers: expLayers })}
                        >
                          Pricing Curve
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
                      <table className="bm-table" style={{ minWidth: 1180, tableLayout: 'fixed' }}>
                        <colgroup>{[
                          <col key="layer" style={{ width: 58 }} />,
                          <col key="limit" style={{ width: 127 }} />,
                          <col key="attachment" style={{ width: 127 }} />,
                          <col key="egnpi" style={{ width: 127 }} />,
                          <col key="rate" style={{ width: 81 }} />,
                          <col key="rol" style={{ width: 81 }} />,
                          <col key="premium" style={{ width: 104 }} />,
                          <col key="mdp" style={{ width: 81 }} />,
                          <col key="reinstatements" style={{ width: 81 }} />,
                          <col key="geomean" style={{ width: 104 }} />,
                          <col key="xGE" style={{ width: 104 }} />,
                          <col key="risk" style={{ width: 52 }} />,
                          <col key="cat" style={{ width: 52 }} />,
                        ]}</colgroup>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Limit</th>
                            <th>Attachment</th>
                            <th>EGNPI</th>
                            <th>Rate %</th>
                            <th>ROL %</th>
                            <th>Premium</th>
                            <th>MDP</th>
                            <th>Reinst.</th>
                            <th>Geomean</th>
                            <th>x=G/E</th>
                            <th>Risk</th>
                            <th>Cat</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expLayers.map((l, i) => {
                            const setField = (field, val) => editExpLayer(i, field, val);
                            const attachmentLocked = i > 0;
                            const geomean = fqGeomean(toN(l.limit), toN(l.attachment));
                            const xGE = toN(l.egnpi) > 0 ? geomean / toN(l.egnpi) : 0;
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
                                <td className="bm-calc bm-calc--hi">{toN(l.rol) > 0 ? `${toN(l.rol).toFixed(2)}%` : '—'}</td>
                                <td className="bm-calc">{l.earnedPremium ? formatWithCommas(String(Math.round(toN(l.earnedPremium)))) : '—'}</td>
                                <td><input className="bm-cell bm-cell--sm" value={l.mdp} onChange={(e) => setField('mdp', e.target.value)} placeholder="—" /></td>
                                <td><select className="bm-cell bm-cell--sm" value={l.reinstatements ?? ''} onChange={(e) => setField('reinstatements', e.target.value)}>{REINSTATEMENT_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select></td>
                                <td className="bm-calc bm-calc--dim">{geomean > 0 ? formatWithCommas(String(Math.round(geomean))) : '—'}</td>
                                <td className="bm-calc bm-calc--dim">{xGE > 0 ? xGE.toFixed(4) : '—'}</td>
                                <td style={{ textAlign: 'center' }}><input type="checkbox" className="np-check" checked={!!l.risk} onChange={() => setField('risk', !l.risk)} /></td>
                                <td style={{ textAlign: 'center' }}><input type="checkbox" className="np-check" checked={!!l.cat}  onChange={() => setField('cat', !l.cat)} /></td>
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
                                <td><FQReadCell value={wRol  > 0 ? `${wRol.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totEp > 0 ? formatWithCommas(String(Math.round(totEp))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td></td>
                                <td></td>
                                <td></td>
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
                          <table className="bm-table" style={{ minWidth: 1104, tableLayout: 'fixed' }}>
                            <colgroup>{[
                              <col key="layer" style={{ width: 58 }} />,
                              <col key="limit" style={{ width: 127 }} />,
                              <col key="attachment" style={{ width: 127 }} />,
                              <col key="egnpi" style={{ width: 127 }} />,
                              <col key="geomean" style={{ width: 104 }} />,
                              <col key="xGE" style={{ width: 104 }} />,
                              <col key="rol" style={{ width: 104 }} />,
                              <col key="premium" style={{ width: 104 }} />,
                              <col key="rate" style={{ width: 104 }} />,
                              <col key="risk" style={{ width: 52 }} />,
                              <col key="cat" style={{ width: 52 }} />,
                              <col key="delete" style={{ width: 41 }} />,
                            ]}</colgroup>
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Limit</th>
                                <th>Attachment</th>
                                {/* NOTE: bound to l.egnpi; screenshot labels this "Premium" but it stores EGNPI for x=Geomean/EGNPI. */}
                                <th>EGNPI</th>
                                <th>Geomean</th>
                                <th>x=G/E</th>
                                <th style={{ color }}>ROL % ↗</th>
                                <th style={{ color }}>Premium ↗</th>
                                <th style={{ color }}>Rate % ↗</th>
                                <th>Risk</th>
                                <th>Cat</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {str.layers.map((l, lIdx) => {
                                const geomean = fqGeomean(toN(l.limit), toN(l.attachment));
                                const xGE = toN(l.egnpi) > 0 ? geomean / toN(l.egnpi) : 0;
                                const priced = fqPriceLayerOnCurve(l, quoteCurve.fit, quoteCurve.baseEgnpi);
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
                                    {/* NOTE: bound to l.egnpi; relabeling to "Premium" is a one-word header change if product wants it. */}
                                    <td><FQNumCell value={l.egnpi}      onChange={(v) => setStrLayer(lIdx, 'egnpi', v)} /></td>
                                    <td className="bm-calc bm-calc--dim">{geomean > 0 ? formatWithCommas(String(Math.round(geomean))) : '—'}</td>
                                    <td className="bm-calc bm-calc--dim">{xGE > 0 ? xGE.toFixed(4) : '—'}</td>
                                    <td className="bm-calc" style={{ color, fontWeight: 800 }}>{priced ? `${(priced.y * 100).toFixed(2)}%` : '—'}</td>
                                    <td className="bm-calc" style={{ color }}>{priced ? formatWithCommas(String(Math.round(priced.premium))) : '—'}</td>
                                    <td className="bm-calc" style={{ color, opacity: 0.8 }}>{priced ? `${(priced.rate * 100).toFixed(4)}%` : '—'}</td>
                                    <td style={{ textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        className="np-check"
                                        aria-label={`Structure ${sIdx + 1} Layer ${lIdx + 1} Risk`}
                                        checked={!!l.risk}
                                        disabled={riskDisabled}
                                        onChange={(e) => setStrLayer(lIdx, 'risk', e.target.checked)}
                                        style={{ opacity: riskDisabled ? 0.4 : 1 }}
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
                                        style={{ opacity: catDisabled ? 0.4 : 1 }}
                                      />
                                    </td>
                                    <td><button className="bm-del" onClick={() => removeLayer(lIdx)}>✕</button></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            {(() => {
                              const totLim = str.layers.reduce((s, l) => s + toN(l.limit), 0);
                              if (totLim <= 0) return null;
                              const totEgnpi = str.layers.reduce((s, l) => s + toN(l.egnpi), 0);
                              // Curve-priced footer: limit-weighted ROL and summed premium from
                              // fqPriceLayerOnCurve over the layers (mirrors the per-row ↗ columns).
                              let rolNum = 0, rolDen = 0, totPrem = 0;
                              str.layers.forEach((l) => {
                                const p = fqPriceLayerOnCurve(l, quoteCurve.fit, quoteCurve.baseEgnpi);
                                if (!p) return;
                                const lim = toN(l.limit);
                                rolNum += p.y * lim;
                                rolDen += lim;
                                totPrem += p.premium;
                              });
                              const wRol = rolDen > 0 ? (rolNum / rolDen) * 100 : 0;
                              return (
                                <tfoot>
                                  <tr className="bm-foot" style={{ borderTopColor: `${color}25` }}>
                                    <td><FQReadCell value="TOTAL" className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={formatWithCommas(String(Math.round(totLim)))} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td></td>
                                    <td><FQReadCell value={totEgnpi > 0 ? formatWithCommas(String(Math.round(totEgnpi))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td></td>
                                    <td></td>
                                    <td><FQReadCell value={wRol > 0 ? `${wRol.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" style={{ color, fontWeight: 800 }} /></td>
                                    <td><FQReadCell value={totPrem > 0 ? formatWithCommas(String(Math.round(totPrem))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" style={{ color, fontWeight: 800 }} /></td>
                                    <td></td>
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
