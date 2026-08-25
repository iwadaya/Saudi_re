// components/NpOfferModal.jsx — Phase 4.1 extraction.
//
// The full offer workflow modal: stepper, treaty summary strip, AI line
// suggestion + treaty classification, per-layer written/signed lines,
// the role-gated workflow cards (submit / CU decision / signed-line /
// terminal states), and the approval trail. JSX + derivations moved
// verbatim from NpFinalPricing's showOfferModal IIFE — props in,
// callbacks out, no logic changes (including the modal-local toN
// shadow).

import { useState } from 'react';
import { api } from '../../../../api';
import PctInput from '../../../../components/PctInput';
import RetroImpactModal from '../../../../components/retro/RetroImpactModal';
import { fmtC, capPct2 } from '../formatters.js';
import { structureCombinedTotals, layerCombinedPricing } from '../fqQuoteMath.js';

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   open: boolean,
 *   isCU: boolean,
 *   actorName: string,
 *   isTerminal: boolean,
 *   isQuote: boolean,
 *   quoteMode: boolean,
 *   contractId: string,
 *   currency: string,
 *   npDetail: Record<string, any>,
 *   showToast: ((message: string) => void) | undefined,
 *   doSubmitForApproval: () => Promise<void>,
 *   doMarkApproved: () => Promise<void>,
 *   doMarkSigned: () => Promise<void>,
 *   doMarkNTU: () => Promise<void>,
 *   doReturnToUW: () => Promise<void>,
 *   doDecline: () => Promise<void>,
 * }} props
 */
export default function NpOfferModal({
  pricing,
  open,
  isCU,
  actorName,
  isTerminal,
  isQuote,
  quoteMode,
  contractId,
  currency,
  npDetail,
  showToast,
  doSubmitForApproval,
  doMarkApproved,
  doMarkSigned,
  doMarkNTU,
  doReturnToUW,
  doDecline,
}) {
  const {
    layers, offerStatus, snap, techRatioAvg, approvedStructures,
    clientStructures, selectedCobs, getCobFlags,
    layerWrittenLines, signedLinePcts, setLayerWrittenLines, setSignedLinePcts,
    offerApprover, setOfferApprover, eligibleApprovers,
    offerComment, setOfferComment, returnReason, setReturnReason,
    approvalTrail, setShowOfferModal, setOfferStatus,
  } = pricing;
  const [showRetro, setShowRetro] = useState(false);
  if (!open) return null;

                const toN = v => { const x = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };
                const money = n => n > 0 ? `${currency} ${Math.round(n).toLocaleString()}` : '—';
                // A RETURNED / RECALLED offer is reworkable draft state — the
                // status loader normalizes these, but stay defensive here so a
                // raw server status can never render the terminal step with no
                // resubmit path.
                const isDraftLike = offerStatus === 'DRAFT' || offerStatus === 'RETURNED' || offerStatus === 'RECALLED';
                const stepIndex = isDraftLike ? 0 : offerStatus === 'AWAITING_APPROVAL' ? 1 : offerStatus === 'AWAITING_SIGNED_LINE' ? 2 : 3;
                const steps = [
                  { k: 'Draft' }, { k: 'Awaiting Approval' },
                  { k: 'Awaiting Signed Line' },
                  { k: offerStatus === 'NTU' ? 'NTU' : 'Signed / Complete' },
                ];

                // Per-layer computations
                const layerData = layers.map((l, i) => {
                  const limit   = toN(l.limit);
                  const attach  = toN(l.deductible ?? l.attachment);
                  const egnpi   = toN(l.egnpi);
                  const rolPct  = toN(l.uwPrice) || toN(l.totalPrice);
                  const ep100   = rolPct > 0 && limit > 0 ? limit * rolPct / 100 : toN(l.earnedPremium) || toN(l.ep);
                  const wlRaw   = String(layerWrittenLines[i] || '').replace(/%/g, '').trim();
                  const wlNum   = parseFloat(wlRaw); // e.g. 2.5 means 2.5%
                  const wlFrac  = Number.isFinite(wlNum) ? wlNum / 100 : 0;
                  const linePrem = wlFrac > 0 ? Math.round(ep100 * wlFrac)   : 0;
                  const lineLimit = wlFrac > 0 ? Math.round(limit  * wlFrac)  : 0;
                  const isRisk  = l.riskCover || l.risk;
                  const isCat   = l.catCover  || l.cat;
                  const peril   = isRisk && isCat ? 'BOTH' : isRisk ? 'RISK' : isCat ? 'CAT' : '—';
                  const perilColor = isRisk && isCat ? '#a78bfa' : isRisk ? '#38bdf8' : isCat ? '#00d4ff' : 'rgba(255,255,255,0.3)';
                  // Signed line
                  const slRaw   = String(signedLinePcts[i] || '').replace(/%/g, '').trim();
                  const slNum   = parseFloat(slRaw);
                  const slFrac  = Number.isFinite(slNum) ? slNum / 100 : 0;
                  const sLinePrem  = slFrac > 0 ? Math.round(ep100  * slFrac) : 0;
                  const sLineLimit = slFrac > 0 ? Math.round(limit * slFrac)  : 0;
                  const sOver   = slFrac > 0 && wlFrac > 0 && slFrac > wlFrac;
                  return { layer: l.layer || `L${i+1}`, limit, attach, egnpi, ep100, rolPct, wlRaw, wlNum, wlFrac, linePrem, lineLimit, peril, perilColor, slRaw, slNum, slFrac, sLinePrem, sLineLimit, sOver, isRisk, isCat };
                });

                // ── Retro Impact inputs (treaty offer only) ──
                // Premium at 100% = Σ layer premium; expected loss ratio vs
                // premium = technical ROL ÷ UW ROL (the tech ratio is struck
                // against limit, the UW price funds it). Written line context
                // = limit-weighted average of the entered lines.
                const retroTotEp    = layerData.reduce((s, r) => s + r.ep100, 0);
                const retroTotLim   = layerData.reduce((s, r) => s + r.limit, 0);
                const retroRolRows  = layerData.filter(r => r.rolPct > 0);
                const retroAvgRol   = retroRolRows.length ? retroRolRows.reduce((s, r) => s + r.rolPct, 0) / retroRolRows.length : 0;
                const retroElr      = retroAvgRol > 0 && techRatioAvg > 0 ? Math.min(1.5, techRatioAvg / retroAvgRol) : 0.6;
                const retroSubject  = { grossPremium100: retroTotEp, grossLimit100: retroTotLim, expectedLossRatio: retroElr, expenseRatio: 0, authorityMaxLimit: 0 };
                const retroWlRows   = layerData.filter(r => r.wlFrac > 0 && r.limit > 0);
                const retroCurrent  = retroWlRows.length
                  ? retroWlRows.reduce((s, r) => s + r.wlNum * r.limit, 0) / retroWlRows.reduce((s, r) => s + r.limit, 0)
                  : 0;

                const hasApprovedQuoteStructure = isQuote && approvedStructures.some(Boolean);
                const hasAnyWritten  = isQuote
                  ? hasApprovedQuoteStructure
                  : layerData.some(r => r.wlFrac > 0);
                const hasAnySigned   = layerData.some(r => r.slFrac > 0);
                const anyOverSigned  = layerData.some(r => r.sOver);
                const totalLinePrem  = layerData.reduce((s, r) => s + r.linePrem, 0);

                return (
                  <div className="bbg-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setShowOfferModal(false); }}>
                    <div className="bbg-modal bbg-modal--fullscreen off-modal">

                      {/* ── HEADER ── */}
                      <div className="bbg-modal-head" style={{ flexShrink: 0 }}>
                        <span className="bbg-modal-title">
                          {isCU && offerStatus === 'AWAITING_APPROVAL' ? '🔐 Chief Underwriter Review' : isQuote ? 'Submit Quotes for Approval' : 'Offer Treaty'}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                            Viewing as <b style={{ color: 'rgba(255,255,255,0.65)' }}>{actorName}</b>
                          </span>
                          <span className={`bbg-status bbg-status--${(offerStatus || 'draft').toLowerCase()}`}>
                            {(offerStatus || 'DRAFT').replace(/_/g, ' ')}
                          </span>
                          <button className="bbg-modal-x" onClick={() => setShowOfferModal(false)}>✕</button>
                        </div>
                      </div>

                      <div className="bbg-modal-body" style={{ overflowY: 'auto', flex: '1 1 0', minHeight: 0, padding: '20px 24px' }}>

                        {/* ── STEPPER ── */}
                        <div className="off-steps" style={{ marginBottom: 20 }}>
                          {steps.map((s, i) => {
                            const isDone = i < stepIndex, isActive = i === stepIndex;
                            return (
                              <div key={i} className={`off-step${isDone ? ' done-line' : ''}`}>
                                <div className={`off-step-dot ${isDone ? 'done' : isActive ? 'active' : ''}`}>{isDone ? '✓' : i + 1}</div>
                                <div className={`off-step-label ${isActive ? 'active' : ''}`}>{s.k}</div>
                              </div>
                            );
                          })}
                        </div>

                        {/* ── TREATY SUMMARY STRIP ── */}
                        <div style={{
                          display: 'flex', alignItems: 'stretch', gap: 0,
                          background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
                          borderRadius: 10, overflow: 'hidden', marginBottom: 20,
                        }}>
                          {[
                            { k: 'Cedant',      v: snap.cedant     },
                            { k: 'Treaty Type', v: snap.treatyType  },
                            { k: 'COB',         v: snap.cob        },
                            { k: 'XL Type',     v: snap.xlType     },
                            { k: 'Layers',      v: layers.length   },
                            { k: 'EGNPI',       v: money(toN(npDetail.estGnpi)) },
                          ].map((item, idx, arr) => (
                            <div key={item.k} style={{
                              flex: 1, padding: '10px 16px',
                              borderRight: idx < arr.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                            }}>
                              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.32)', marginBottom: 4 }}>{item.k}</div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.v || '—'}</div>
                            </div>
                          ))}
                        </div>


                        {/* ── QUOTE SUBMISSION SUMMARY (quote mode) ── */}
                        {isQuote && (
                          <div className="off-card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
                            <div className="off-card-title" style={{ padding: '12px 14px', color: '#23d18b' }}>Quotes for Submission</div>
                            <div style={{ overflowX: 'auto' }}>
                              {(() => {
                                const sTh = { padding: '8px 12px', fontSize: 9, fontWeight: 700, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.08)', textAlign: 'right' };
                                const sTd = { padding: '8px 12px', textAlign: 'right', fontSize: 12, color: 'rgba(255,255,255,0.8)', borderBottom: '1px solid rgba(255,255,255,0.05)', fontVariantNumeric: 'tabular-nums' };
                                const pct = (n) => (Number.isFinite(n) && n > 0 ? `${n.toFixed(2)}%` : '—');
                                const fmtMoney = (n) => (n > 0 ? fmtC(Math.round(n)) : '—');
                                const queued = (clientStructures || []).map((s, i) => ({ s, i })).filter(({ i }) => approvedStructures[i]);
                                return (
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                    <thead>
                                      <tr>
                                        <th style={{ ...sTh, textAlign: 'center' }}>Layer</th>
                                        <th style={sTh}>Limit</th>
                                        <th style={sTh}>Deductible</th>
                                        <th style={{ ...sTh, textAlign: 'center' }}>Reinstatements</th>
                                        <th style={sTh}>UW ROL</th>
                                        <th style={{ ...sTh, textAlign: 'left' }}>COBs Covered</th>
                                      </tr>
                                    </thead>
                                    {queued.length === 0 ? (
                                      <tbody>
                                        <tr><td colSpan={6} style={{ ...sTd, textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: 20 }}>No structures queued — use “Send for Approval” on a structure first.</td></tr>
                                      </tbody>
                                    ) : queued.map(({ s, i }) => {
                                      const scope = String(s.id);
                                      const t = structureCombinedTotals(s);
                                      const indicative = s.quoteType === 'INDICATIVE';
                                      const lineVal = toN(indicative ? s.followLinePct : s.leadLinePct);
                                      const sLayers = Array.isArray(s.layers) ? s.layers : [];
                                      // COB × layer coverage, sliced per layer (the class names whose flag is set on that layer).
                                      const cobCoverage = (selectedCobs || []).map((c) => ({ name: c.name, flags: getCobFlags(scope, c.id, sLayers) }));
                                      const layerRows = sLayers.map((l, lIdx) => ({ lIdx, c: layerCombinedPricing(l) })).filter((r) => r.c);
                                      return (
                                        <tbody key={s.id || i}>
                                          {/* Group header — structure-level attributes (one value "across" the structure) + totals. */}
                                          <tr data-testid={`np-submit-group-${i}`}>
                                            <td colSpan={6} style={{ padding: 0, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', padding: '10px 12px', background: 'rgba(35,209,139,0.06)' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                                  <span style={{ fontSize: 13, fontWeight: 800, color: '#e2e8f0' }}>{s.label || `Structure ${i + 1}`}</span>
                                                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', padding: '2px 8px', borderRadius: 6, color: indicative ? '#fbbf24' : '#23d18b', background: indicative ? 'rgba(251,191,36,0.12)' : 'rgba(35,209,139,0.12)', border: `1px solid ${indicative ? 'rgba(251,191,36,0.35)' : 'rgba(35,209,139,0.35)'}` }}>{indicative ? 'Indicative' : 'Lead'}</span>
                                                  <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.75)' }}>{lineVal > 0 ? `${capPct2(lineVal)}% ${indicative ? 'follow' : 'lead'} line` : 'No line set'}</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
                                                  {[
                                                    { k: 'Total Limit', v: fmtMoney(t.totalLimit), col: 'rgba(255,255,255,0.85)' },
                                                    { k: 'Total Premium', v: fmtMoney(t.totalPremium), col: 'rgba(255,255,255,0.85)' },
                                                    { k: 'Wtd UW ROL', v: pct(t.wtdRol), col: '#00d4ff' },
                                                  ].map((stat) => (
                                                    <div key={stat.k} style={{ textAlign: 'right' }}>
                                                      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)' }}>{stat.k}</div>
                                                      <div style={{ fontSize: 13, fontWeight: 800, color: stat.col, fontVariantNumeric: 'tabular-nums' }}>{stat.v}</div>
                                                    </div>
                                                  ))}
                                                </div>
                                              </div>
                                            </td>
                                          </tr>
                                          {/* Per-layer rows — risk + cat fused via layerCombinedPricing; COBs sliced per layer. */}
                                          {layerRows.length === 0 ? (
                                            <tr><td colSpan={6} style={{ ...sTd, textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>No active layers in this structure.</td></tr>
                                          ) : layerRows.map(({ lIdx, c }) => {
                                            const cobs = cobCoverage.filter((f) => f.flags[lIdx]).map((f) => f.name);
                                            return (
                                              <tr key={`${s.id || i}-${lIdx}`} data-testid={`np-submit-layer-${i}-${lIdx}`}>
                                                <td style={{ ...sTd, textAlign: 'center' }}>
                                                  <span style={{ display: 'inline-block', minWidth: 22, padding: '2px 7px', borderRadius: 6, fontSize: 11, fontWeight: 800, color: '#23d18b', background: 'rgba(35,209,139,0.10)', border: '1px solid rgba(35,209,139,0.30)' }}>{lIdx + 1}</span>
                                                </td>
                                                <td style={sTd}>{fmtMoney(c.limit)}</td>
                                                <td style={sTd}>{fmtMoney(toN(c.deductible))}</td>
                                                <td style={{ ...sTd, textAlign: 'center' }}>{c.reinst}</td>
                                                <td style={{ ...sTd, color: '#00d4ff', fontWeight: 700 }}>{`${c.uwRol.toFixed(2)}%`}</td>
                                                <td style={{ ...sTd, textAlign: 'left', whiteSpace: 'normal', color: 'rgba(255,255,255,0.65)' }}>{cobs.length ? cobs.join(', ') : '—'}</td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      );
                                    })}
                                  </table>
                                );
                              })()}
                            </div>
                          </div>
                        )}

                        {/* ── AI + CLASSIFIER (treaty offer only; quotes show the summary above) ── */}
                        {!isQuote && (
                        <div style={{ marginBottom: 20 }}>
                        {(() => {
                          const egnpiBlock = toN(npDetail.estGnpi);
                          const totLimB    = layerData.reduce((s,r) => s+r.limit, 0);
                          const rolLayersB = layerData.filter(r => r.rolPct > 0);
                          const avgRolB    = rolLayersB.length ? rolLayersB.reduce((s,r) => s+r.rolPct,0)/rolLayersB.length : 0;
                          const techRB     = techRatioAvg / 100;
                          const mActB      = avgRolB > 0 && techRB > 0 ? Math.max(0,(avgRolB/100)-techRB) : 0;
                          const balRatioB  = egnpiBlock > 0 ? totLimB/egnpiBlock : 0;
                          const premScoreB = Math.min(100,Math.round((Math.min(balRatioB,80)/80)*50+(totLimB>0?Math.min(totLimB/5_000_000_000,1)*50:0)));
                          const margScoreB = Math.min(100,Math.round((Math.max(0,Math.min(mActB,0.5))/0.5)*60+(Math.max(0,0.7-techRB)/0.7)*40));
                          const heatLabel  = premScoreB>65&&margScoreB>65?'Premium & Margin Driver':premScoreB>65?'Premium Driver':margScoreB>65?'Margin Driver':'Balanced';
                          const heatColor  = premScoreB>65&&margScoreB>65?'#a78bfa':premScoreB>65?'#38bdf8':margScoreB>65?'#4ade80':'#94a3b8';
                          const mQB = Math.max(0,Math.min(1,mActB/0.3));
                          const bQB = Math.max(0,Math.min(1,balRatioB/60));
                          const aiLinePctB = Math.max(1,Math.min(20,Math.round((mQB*0.6+bQB*0.4)*20*10)/10||10));
                          const aiReasonB  = mActB>=0.15?`Strong margin (${(mActB*100).toFixed(1)}%) — full line supportable.`:mActB>=0.08?`Acceptable margin (${(mActB*100).toFixed(1)}%) — moderate line.`:techRB>0?`Thin margin (${(mActB*100).toFixed(1)}%) — conservative line advised.`:'Run pricing engine to generate suggestion.';
                          return (
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, flexShrink:0 }}>
                              <div className="off-ai">
                                <div className="off-ai-head">
                                  <div className="off-ai-label">✦ AI Suggested Line Size</div>
                                  {!isTerminal&&<button className="off-ai-apply" type="button" onClick={()=>{const n={};layers.forEach((_,i)=>n[i]=String(aiLinePctB));setLayerWrittenLines(n);}}>Apply to all →</button>}
                                </div>
                                <div className="off-ai-number">
                                  <div className="off-ai-pct">{aiLinePctB.toFixed(1)}</div>
                                  <div className="off-ai-unit">%</div>
                                </div>
                                <div className="off-ai-reason" style={{margin:'6px 0',fontSize:11}}>{aiReasonB}</div>
                                <div className="off-ai-econ">
                                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Avg ROL</span><span className="off-ai-econ-v">{avgRolB>0?avgRolB.toFixed(2)+'%':'—'}</span></div>
                                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Tech Ratio</span><span className="off-ai-econ-v">{techRatioAvg>0?techRatioAvg.toFixed(2)+'%':'—'}</span></div>
                                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Margin</span><span className="off-ai-econ-v" style={{color:mActB>=0.08?'#4ade80':mActB>0?'#00d4ff':'#f87171'}}>{mActB>0?(mActB*100).toFixed(1)+'%':'—'}</span></div>
                                </div>
                                <button className="rim-launch rim-launch--block" type="button" onClick={()=>setShowRetro(true)}>
                                  ⛨ Retro Impact on Line Size
                                </button>
                              </div>
                              <div className="off-hm-wrap">
                                <div className="off-hm-title">Treaty Classification</div>
                                <div className="off-hm-matrix">
                                  <div className="off-hm-axlabel"></div>
                                  <div className="off-hm-axlabel">LOW MARGIN</div>
                                  <div className="off-hm-axlabel">HIGH MARGIN</div>
                                  <div className="off-hm-axlabel vert">HIGH PREM</div>
                                  <div className={`off-hm-cell off-hm-c-blue ${premScoreB>65&&margScoreB<=65?'off-hm-active':''}`}><span className="off-hm-cell-name">Premium<br/>Driver</span><span className="off-hm-cell-sub">Bulk volume,<br/>thin margin</span></div>
                                  <div className={`off-hm-cell off-hm-c-purple ${premScoreB>65&&margScoreB>65?'off-hm-active':''}`}><span className="off-hm-cell-name">Premium &amp;<br/>Margin Driver</span><span className="off-hm-cell-sub">Best of both</span></div>
                                  <div className="off-hm-axlabel vert">LOW PREM</div>
                                  <div className={`off-hm-cell off-hm-c-slate ${premScoreB<=65&&margScoreB<=65?'off-hm-active':''}`}><span className="off-hm-cell-name">Balanced</span><span className="off-hm-cell-sub">Average<br/>profile</span></div>
                                  <div className={`off-hm-cell off-hm-c-green ${premScoreB<=65&&margScoreB>65?'off-hm-active':''}`}><span className="off-hm-cell-name">Margin<br/>Driver</span><span className="off-hm-cell-sub">High quality,<br/>lower volume</span></div>
                                </div>
                                <div className="off-hm-scores">
                                  <div className="off-hm-score-item">Premium Score <b style={{color:'#38bdf8'}}>{premScoreB}/100</b></div>
                                  <div className="off-hm-score-item">Margin Score <b style={{color:'#4ade80'}}>{margScoreB}/100</b></div>
                                  <div className="off-hm-score-item">Classification <b style={{color:heatColor}}>{heatLabel}</b></div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                        </div>
                        )}

                        {/* ── PER-LAYER TABLE (treaty offer only) ── */}
                        {!isQuote && (
                        <div style={{ marginBottom: 20 }}>
                        {(() => {
                          const egnpiTotal = toN(npDetail.estGnpi);
                          const totLim     = layerData.reduce((s,r) => s + r.limit, 0);
                          const rolLayers  = layerData.filter(r => r.rolPct > 0);
                          const avgRol     = rolLayers.length ? rolLayers.reduce((s,r) => s+r.rolPct,0)/rolLayers.length : 0;
                          const techR      = techRatioAvg / 100;
                          const mAct       = avgRol > 0 && techR > 0 ? Math.max(0,(avgRol/100)-techR) : 0;
                          const balRatio   = egnpiTotal > 0 ? totLim/egnpiTotal : 0;
                          const mQ = Math.max(0,Math.min(1,mAct/0.3));
                          const bQ = Math.max(0,Math.min(1,balRatio/60));
                          const aiLinePct  = Math.max(1,Math.min(20,Math.round((mQ*0.6+bQ*0.4)*20*10)/10 || 10));
                          const isApproved = offerStatus === 'AWAITING_SIGNED_LINE';
                          const th = { padding:'7px 10px', fontSize:9, fontWeight:700, letterSpacing:'.10em',
                            textTransform:'uppercase', color:'rgba(255,255,255,0.35)', whiteSpace:'nowrap',
                            borderBottom:'1px solid rgba(255,255,255,0.08)', textAlign:'right' };
                          const thC = {...th, textAlign:'center'};
                          return (
                            <div className="off-card" style={{ padding:0, overflow:'hidden' }}>
                              <div style={{ overflowX:'auto' }}>
                                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                                  <thead>
                                    <tr>
                                      <th style={{...thC}}>Layer</th>
                                      <th style={{...th,color:'#00d4ff',textAlign:'center',minWidth:88}}>Written %</th>
                                      <th style={{...th}}>Limit</th>
                                      <th style={{...th}}>Premium</th>
                                      <th style={{...th,color:'#00d4ff'}}>ROL %</th>
                                      <th style={{...th,color:'#a78bfa'}}>Tech Ratio</th>
                                      <th style={{...th,color:'rgba(0,232,184,0.8)',textAlign:'center'}}>
                                        <div>✦ AI Line</div>
                                        {!isTerminal&&<button onClick={()=>{const n={};layerData.forEach((_,i)=>n[i]=String(aiLinePct));setLayerWrittenLines(n);}} style={{fontSize:8,padding:'1px 6px',borderRadius:8,border:'1px solid rgba(0,232,184,0.3)',background:'rgba(0,232,184,0.07)',color:'rgba(0,232,184,0.7)',cursor:'pointer',fontWeight:700,marginTop:2}}>apply all</button>}
                                      </th>
                                      <th style={{...th,color: isApproved?'#60a5fa':'rgba(255,255,255,0.2)',textAlign:'center',minWidth:90}}>
                                        Signed %{!isApproved&&<span style={{fontSize:8,display:'block',color:'rgba(255,255,255,0.2)',fontWeight:400,letterSpacing:0}}>unlocks on approval</span>}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {layerData.map((r,i) => {
                                      const techPct = parseFloat(String(layers[i]?.technicalRatio||layers[i]?.techRatio||'').replace(/%/g,'')) || 0;
                                      const wlVal   = String(layerWrittenLines[i]||'').replace(/%/g,'').trim();
                                      const slVal   = String(signedLinePcts[i]||'').replace(/%/g,'').trim();
                                      const inpBase = { width:'100%', boxSizing:'border-box', borderRadius:6,
                                        border:'1px solid rgba(255,255,255,0.14)', background:'rgba(255,255,255,0.05)',
                                        color:'#fff', padding:'5px 8px', fontSize:12, fontWeight:700,
                                        fontFamily:'inherit', textAlign:'center', outline:'none' };
                                      return (
                                        <tr key={i} style={{ borderBottom:'1px solid rgba(255,255,255,0.05)', background: i%2?'rgba(255,255,255,0.01)':'transparent' }}>
                                          <td style={{ padding:'8px 10px', textAlign:'center', fontWeight:800, color:'#00d4ff' }}>{r.layer}</td>
                                          <td style={{ padding:'4px 6px', textAlign:'center' }}>
                                            <PctInput
                                              className=""
                                              style={{...inpBase, border:`1px solid ${wlVal?'rgba(0,212,255,0.4)':'rgba(255,255,255,0.10)'}`, width:72, opacity:isTerminal?0.5:1}}
                                              value={wlVal} readOnly={isTerminal} placeholder="0%"
                                              onChange={v=>setLayerWrittenLines(p=>({...p,[i]:v}))}
                                              onBlur={()=>{const n=parseFloat(String(layerWrittenLines[i]||'').replace(/%/g,'').trim());const v=Number.isFinite(n)?Math.min(100,Math.max(0,n)):'';setLayerWrittenLines(p=>({...p,[i]:v===''?'':String(v)}));}}
                                            />
                                          </td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'rgba(255,255,255,0.7)', fontVariantNumeric:'tabular-nums' }}>{r.limit>0?fmtC(r.limit):'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'rgba(255,255,255,0.7)', fontVariantNumeric:'tabular-nums' }}>{r.ep100>0?fmtC(Math.round(r.ep100)):'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'#00d4ff', fontWeight:700 }}>{r.rolPct>0?r.rolPct.toFixed(2)+'%':'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color: techPct>0?(techPct<=r.rolPct?'#4ade80':'#f87171'):'rgba(255,255,255,0.4)', fontWeight:700 }}>{techPct>0?techPct.toFixed(2)+'%':'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'rgba(0,232,184,0.85)', fontWeight:800 }}>
                                            {!isTerminal && (
                                              <button onClick={()=>setLayerWrittenLines(p=>({...p,[i]:String(aiLinePct)}))}
                                                style={{ fontSize:10, padding:'2px 8px', borderRadius:10, border:'1px solid rgba(0,232,184,0.35)', background:'rgba(0,232,184,0.08)', color:'rgba(0,232,184,0.85)', cursor:'pointer', fontWeight:700, whiteSpace:'nowrap' }}>
                                                {aiLinePct.toFixed(1)}% →
                                              </button>
                                            )}
                                            {isTerminal && <span>{aiLinePct.toFixed(1)}%</span>}
                                          </td>
                                          <td style={{ padding:'4px 6px' }}>
                                            <PctInput
                                              className=""
                                              style={{...inpBase,
                                                border:`1px solid ${isApproved?(slVal?(r.sOver?'rgba(248,113,113,0.6)':'rgba(96,165,250,0.5)'):'rgba(96,165,250,0.25)'):'rgba(255,255,255,0.07)'}`,
                                                background: isApproved?'rgba(96,165,250,0.07)':'rgba(255,255,255,0.02)',
                                                opacity: isApproved?1:0.35, cursor: isApproved?'text':'not-allowed'}}
                                              value={slVal} readOnly={!isApproved||isTerminal}
                                              placeholder={isApproved?'0.0%':'—'}
                                              onChange={v=>{if(isApproved)setSignedLinePcts(p=>({...p,[i]:v}));}}
                                            />
                                            {r.sOver && isApproved && <div style={{fontSize:9,color:'#f87171',textAlign:'center'}}>exceeds written</div>}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                  {layerData.length > 1 && (
                                    <tfoot>
                                      <tr style={{ borderTop:'2px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.04)' }}>
                                        <td colSpan={3} style={{ padding:'8px 10px', fontWeight:800, fontSize:11, color:'rgba(255,255,255,0.5)', letterSpacing:'.06em', textTransform:'uppercase' }}>TOTAL</td>
                                        <td style={{ padding:'8px 10px', textAlign:'right', fontWeight:700, color:'rgba(255,255,255,0.7)', fontVariantNumeric:'tabular-nums' }}>{totalLinePrem>0?fmtC(totalLinePrem):'—'}</td>
                                        <td colSpan={4}/>
                                      </tr>
                                    </tfoot>
                                  )}
                                </table>
                              </div>
                            </div>
                          );
                        })()}
                        </div>
                        )}

                        {/* ── WORKFLOW CARDS ── */}
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, alignItems:'start' }}>

                          {/* ── DRAFT (incl. returned / recalled): Submit for Approval ── */}
                          {!isCU && !isTerminal && isDraftLike && (
                            <div className="off-card" style={{ border:'1px solid rgba(0,212,255,0.22)', background:'rgba(0,212,255,0.03)' }}>
                              <div className="off-card-title" style={{ color:'rgba(0,212,255,0.85)' }}>Submit For Approval</div>
                              <div style={{ marginBottom:12 }}>
                                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(255,255,255,0.32)', marginBottom:6 }}>Send to</div>
                                <select value={offerApprover} onChange={e=>setOfferApprover(e.target.value)}
                                  style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(0,212,255,0.32)', borderRadius:8, color:offerApprover?'#fff':'rgba(255,255,255,0.32)', padding:'9px 12px', fontSize:13, fontFamily:'inherit', outline:'none', cursor:'pointer' }}>
                                  <option value="">Select approver…</option>
                                  {(eligibleApprovers||[]).map(a=><option key={a.user_id} value={a.user_id} style={{background:'#0b1526'}}>{[a.display_name,a.role_name].filter(Boolean).join(' — ')||a.email||a.user_id}</option>)}
                                </select>
                              </div>
                              <div style={{ marginBottom:14 }}>
                                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(255,255,255,0.32)', marginBottom:6 }}>Offer Note</div>
                                <textarea className="bbg-textarea" rows={2} value={offerComment} onChange={e=>setOfferComment(e.target.value)}
                                  placeholder="Optional note to the approver…" style={{ width:'100%', boxSizing:'border-box', resize:'vertical' }}/>
                              </div>
                              <button className="bbg-btn bbg-btn--offer" disabled={!offerApprover || !hasAnyWritten} style={{ width:'100%', justifyContent:'center', opacity:(!offerApprover||!hasAnyWritten)?0.42:1, cursor:(!offerApprover||!hasAnyWritten)?'not-allowed':'pointer' }} onClick={doSubmitForApproval}>
                                {isQuote ? 'Submit Quotes →' : 'Submit for Approval →'}
                              </button>
                              {!offerApprover && <div style={{ fontSize:11, color:'rgba(255,255,255,0.32)', marginTop:6, textAlign:'center' }}>Select an approver to proceed</div>}
                              {offerApprover && !hasAnyWritten && (
                                <div style={{ fontSize:11, color:'#00d4ff', marginTop:6, textAlign:'center' }}>
                                  {isQuote ? 'Select at least one structure for approval first' : '⚠ Enter at least one written line first'}
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── AWAITING APPROVAL: UW waiting view + Recall ── */}
                          {!isCU && !isTerminal && offerStatus === 'AWAITING_APPROVAL' && (
                            <div className="off-card" style={{ border:'1px solid rgba(96,165,250,0.22)', background:'rgba(96,165,250,0.04)', textAlign:'center', padding:'20px 16px' }}>
                              <div style={{ fontSize:24, marginBottom:8 }}>⏳</div>
                              <div style={{ fontSize:13, fontWeight:700, color:'#60a5fa', marginBottom:5 }}>Awaiting CU Review</div>
                              <div style={{ fontSize:11, color:'rgba(255,255,255,0.38)', marginBottom:14 }}>
                                Submitted to <b style={{ color:'rgba(255,255,255,0.6)' }}>{(()=>{const ap=eligibleApprovers.find(a=>a.user_id===offerApprover);return [ap?.display_name,ap?.role_name].filter(Boolean).join(' — ')||'approver';})()}</b>
                              </div>
                              <button className="bbg-btn" style={{ borderColor:'rgba(0,212,255,0.45)', color:'#00d4ff' }}
                                onClick={async ()=>{if(window.confirm('Recall this submission? The contract will return to Draft.')){try{await api.recallOffer(contractId,{reason:'Recalled by underwriter',_actor:actorName},quoteMode?{quote:true}:undefined);}catch(e){showToast('Recall failed: '+(e?.message||'Server error'));return;}setOfferStatus('DRAFT');}}}>
                                ↩ Recall
                              </button>
                            </div>
                          )}

                          {/* ── CU: Decision card ── */}
                          {isCU && offerStatus === 'AWAITING_APPROVAL' && (
                            <div className="off-card" style={{ border:'1px solid rgba(0,212,255,0.28)', background:'rgba(0,212,255,0.04)' }}>
                              <div className="off-card-title" style={{ color:'#00d4ff' }}>🔐 Chief Underwriter Decision</div>
                              <div style={{ fontSize:12, color:'rgba(255,255,255,0.42)', marginBottom:10 }}>Review per-layer written lines above. You may adjust them before approving.</div>
                              <textarea className="bbg-textarea" rows={2} value={returnReason} onChange={e=>setReturnReason(e.target.value)}
                                placeholder="Decision note / reason for returning or declining…" style={{ width:'100%', boxSizing:'border-box', marginBottom:10 }}/>
                              <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                                <button className="bbg-btn bbg-btn--offer" style={{ justifyContent:'center' }} onClick={doMarkApproved}>✓ Approve</button>
                                <button className="bbg-btn" style={{ justifyContent:'center', borderColor:'rgba(0,212,255,0.42)', color:'#00d4ff' }} onClick={doReturnToUW}>↩ Return to Underwriter</button>
                                <button className="bbg-btn bbg-btn--decline" style={{ justifyContent:'center' }} onClick={doDecline}>✗ Decline</button>
                              </div>
                            </div>
                          )}

                          {/* ── AWAITING SIGNED LINE: Mark Signed / NTU ── */}
                          {/* Quote sign-off is disabled in this build — quotes terminate at APPROVED.
                              Treaties (isQuote=false) keep the full Mark Signed / NTU flow.
                              Four-eyes: the server only lets an eligible APPROVER confirm signed
                              lines (the submitter gets 403 SIGN_FORBIDDEN), so the confirm button
                              is live for CU/CE and disabled with an explanation for the
                              underwriter. NTU stays available to the owner. */}
                          {!isQuote && offerStatus === 'AWAITING_SIGNED_LINE' && (
                            <div className="off-card" style={{ border:'1px solid rgba(96,165,250,0.25)', background:'rgba(96,165,250,0.04)' }}>
                              <div className="off-card-title" style={{ color:'#60a5fa' }}>✍ Record Signed Lines</div>
                              <div style={{ fontSize:12, color:'rgba(255,255,255,0.42)', marginBottom:10 }}>
                                {isCU
                                  ? 'Offer approved. Enter signed line % per layer above, then confirm below.'
                                  : 'Offer approved. Enter signed line % per layer above — your approver confirms them (four-eyes).'}
                              </div>
                              {anyOverSigned && <div style={{ fontSize:11, color:'#f87171', padding:'6px 10px', borderRadius:6, background:'rgba(248,113,113,0.08)', marginBottom:8 }}>⚠ One or more signed lines exceed the written line</div>}
                              <div style={{ display:'flex', gap:8 }}>
                                <button className="bbg-btn bbg-btn--offer" disabled={!isCU}
                                  style={{ flex:2, justifyContent:'center', opacity:!isCU?0.4:(!hasAnySigned||anyOverSigned)?0.45:1, cursor:!isCU?'not-allowed':'pointer' }}
                                  title={!isCU ? 'Only an eligible approver can confirm signed lines (four-eyes)' : undefined}
                                  onClick={()=>{ if(!isCU){showToast('Only an eligible approver can confirm signed lines (four-eyes).');return;} if(!hasAnySigned){showToast('Enter at least one signed line first.');return;} if(anyOverSigned){showToast('Signed line cannot exceed written line on any layer.');return;} doMarkSigned(); }}>
                                  ✓ Mark Signed
                                </button>
                                <button className="bbg-btn bbg-btn--decline" style={{ flex:1, justifyContent:'center' }}
                                  onClick={()=>{ if(hasAnySigned&&!window.confirm('A signed line is entered. Mark as NTU anyway?'))return; doMarkNTU(); }}>
                                  🚫 NTU
                                </button>
                              </div>
                              {!isCU && (
                                <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:8 }}>
                                  Signed lines are confirmed by the Chief Underwriter from their approvals view.
                                </div>
                              )}
                            </div>
                          )}

                          {/* Quote-mode terminal: APPROVED is the end of the road for quotes
                              in this build. Make the standalone state explicit so testers
                              don't look for a Sign / Bind button that isn't there. */}
                          {isQuote && (offerStatus === 'APPROVED' || offerStatus === 'AWAITING_SIGNED_LINE') && (
                            <div className="off-card" style={{ border:'1px solid rgba(35,209,139,0.30)', background:'rgba(35,209,139,0.04)' }}>
                              <div className="off-card-title" style={{ color:'#23d18b' }}>✅ Quote Approved</div>
                              <div style={{ fontSize:12, color:'rgba(255,255,255,0.55)', marginTop:6 }}>
                                Quotes run as standalone artefacts in this build — no Sign or Bind.
                                Use Request Amendment if the cedant comes back with changes.
                              </div>
                            </div>
                          )}

                          {/* ── TERMINAL state ── */}
                          {isTerminal && (
                            <div className="off-card" style={{ border:`1px solid ${offerStatus==='SIGNED'?'rgba(74,222,128,0.3)':offerStatus==='DECLINED'?'rgba(248,113,113,0.3)':'rgba(0,212,255,0.3)'}`, background:offerStatus==='SIGNED'?'rgba(74,222,128,0.04)':offerStatus==='DECLINED'?'rgba(248,113,113,0.04)':'rgba(0,212,255,0.04)' }}>
                              <div className="off-card-title" style={{ color:offerStatus==='SIGNED'?'#4ade80':offerStatus==='DECLINED'?'#f87171':'#fb923c' }}>
                                {offerStatus==='SIGNED'?'✅ Signed':offerStatus==='DECLINED'?'❌ Declined':'🚫 NTU'}
                              </div>
                              <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:6 }}>This {isQuote ? 'quote' : 'contract'} is now read-only.</div>

                              {/* Quote-to-contract binding is disabled in this build (the
                                  server returns 410). Amendments stay available so cedant
                                  changes can still spawn a new quote version. */}
                              {isQuote && offerStatus === 'SIGNED' && (
                                <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:6 }}>
                                  <button className="bbg-btn"
                                    style={{ justifyContent:'center', borderColor:'rgba(0,212,255,0.35)', color:'#00d4ff', fontSize:11 }}
                                    onClick={async () => {
                                      const reason = window.prompt('Reason for amendment (cedant requested changes):');
                                      if (reason === null) return; // cancelled
                                      try {
                                        const res = await api.amendQuote(contractId, { reason, _actor: actorName });
                                        showToast(`✅ Amendment created!\n\nNew quote version ${res.version}: ${res.new_quote_id.slice(0,8)}…\n\nThe new version is now DRAFT and ready for editing.`);
                                        setShowOfferModal(false);
                                      } catch(e) { showToast('Amendment failed: ' + (e?.message || 'Server error')); }
                                    }}>
                                    ✏ Request Amendment
                                  </button>
                                </div>
                              )}

                              {/* Amendment also available from APPROVED (before signing) */}
                              {isQuote && (offerStatus === 'AWAITING_SIGNED_LINE' || offerStatus === 'APPROVED') && (
                                <button className="bbg-btn" style={{ width:'100%', justifyContent:'center', marginTop:8, borderColor:'rgba(0,212,255,0.35)', color:'#00d4ff', fontSize:11 }}
                                  onClick={async () => {
                                    const reason = window.prompt('Reason for amendment (cedant requested changes):');
                                    if (reason === null) return;
                                    try {
                                      const res = await api.amendQuote(contractId, { reason, _actor: actorName });
                                      showToast(`Amendment v${res.version} created. New quote ID: ${res.new_quote_id.slice(0,8)}…`);
                                      setShowOfferModal(false);
                                    } catch(e) { showToast('Amendment failed: ' + (e?.message || 'Server error')); }
                                  }}>
                                  ✏ Request Amendment
                                </button>
                              )}
                            </div>
                          )}

                          {/* ── APPROVAL TRAIL ── */}
                          {approvalTrail.length > 0 && (
                            <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                              <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(255,255,255,0.35)', marginBottom:4 }}>Approval Trail</div>
                              {approvalTrail.slice(0,5).map((ev,i) => {
                                const evC = { SUBMITTED:{bg:'rgba(96,165,250,0.08)',border:'rgba(96,165,250,0.25)',label:'#60a5fa',icon:'📤'}, SUBMITTED_FOR_APPROVAL:{bg:'rgba(96,165,250,0.08)',border:'rgba(96,165,250,0.25)',label:'#60a5fa',icon:'📤'}, APPROVED:{bg:'rgba(74,222,128,0.08)',border:'rgba(74,222,128,0.25)',label:'#4ade80',icon:'✅'}, RETURNED_TO_UW:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#00d4ff',icon:'↩'}, RETURNED:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#00d4ff',icon:'↩'}, RECALLED:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#00d4ff',icon:'↩'}, DECLINED:{bg:'rgba(248,113,113,0.08)',border:'rgba(248,113,113,0.25)',label:'#f87171',icon:'❌'}, SIGNED:{bg:'rgba(74,222,128,0.06)',border:'rgba(74,222,128,0.20)',label:'#4ade80',icon:'✍'}, NTU:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#fb923c',icon:'🚫'} };
                                const c = evC[ev.event_type] || {bg:'rgba(255,255,255,0.04)',border:'rgba(255,255,255,0.12)',label:'rgba(255,255,255,0.6)',icon:'•'};
                                return (
                                  <div key={i} style={{ display:'flex', gap:8, padding:'7px 10px', borderRadius:7, background:c.bg, border:`1px solid ${c.border}` }}>
                                    <span style={{ fontSize:13, flexShrink:0 }}>{c.icon}</span>
                                    <div style={{ flex:1, minWidth:0 }}>
                                      <div style={{ display:'flex', gap:8, alignItems:'baseline', flexWrap:'wrap' }}>
                                        <span style={{ fontWeight:700, fontSize:11, color:c.label }}>{(ev.event_type||'').replace(/_/g,' ')}</span>
                                        <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)' }}>by {ev.actor||ev.actor_name}</span>
                                        <span style={{ fontSize:10, color:'rgba(255,255,255,0.28)', marginLeft:'auto' }}>{ev.created_at?new Date(ev.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):''}</span>
                                      </div>
                                      {(ev.payload?.reason||ev.comment) && <div style={{ fontSize:10, color:'rgba(255,255,255,0.45)', marginTop:2, fontStyle:'italic' }}>"{ev.payload?.reason||ev.comment}"</div>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* ── FOOTER ── */}
                        <div className="off-footer">
                          <div className="off-footer-left"/>
                          <button className="bbg-btn" style={{ minWidth:90 }} onClick={() => setShowOfferModal(false)}>
                            {isTerminal ? 'Close' : 'Cancel'}
                          </button>
                        </div>

                      </div>

                      {showRetro && !isQuote && (
                        <RetroImpactModal
                          onClose={()=>setShowRetro(false)}
                          subject={retroSubject}
                          currentLinePct={retroCurrent}
                          money={money}
                          contextLabel="Non-Proportional"
                          contractId={contractId}
                          isQuote={false}
                          onApplyLine={isTerminal ? null : (pct)=>{
                            const next = {};
                            layers.forEach((_, i) => { next[i] = String(pct); });
                            setLayerWrittenLines(next);
                            setShowRetro(false);
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              }
