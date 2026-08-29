// components/NpInsightModal.jsx — Phase 4.1 extraction.
//
// The insight modal hosting the embedded screens (Large/CAT loss
// selection, CRESTA aggregates, risk profile, checklist, market
// analysis, cedant summary). JSX moved verbatim from NpFinalPricing —
// props in, callbacks out, no logic changes.

import LossSelectionScreen from '../../../shared/LossSelectionScreen';
import ProfileScreen from '../../../shared/ProfileScreen';
import NpCrestaAggregates from '../../cresta_zones/NpCrestaAggregates';
import NpMarketAnalysis from '../NpMarketAnalysis';
import NpChecklistPanel from './NpChecklistPanel.jsx';
import GemDamageRatioPanel from '../../cat_exposure/GemDamageRatioPanel.jsx';
import CedantSummaryTabs from '../../../../components/cedant/CedantSummaryTabs';
import { cn, fmtRol, layerHit } from '../../../../utils/npPricingEngine.js';

// GEM hands back a ground-up EQ loss in CURRENCY; catPureBurn is a percent
// (ROL) string everywhere else — npPricingEngine writes fmtRol(rol) with
// rol = annual layer loss / limit (calcPureBurningCost step 6). Cut the
// scenario loss to the layer and rate it on the layer limit; never write a
// raw currency amount into the percent field. Returns null when the layer
// has no positive limit (no denominator — caller must skip the write).
// Kept in sync with the same helper in FQEqDamageRatioTab.jsx.
function eqLossToCatPureBurn(groundUpEqLoss, layer) {
  const limit = cn(layer?.limit ?? layer?.layer_limit);
  if (!(limit > 0)) return null;
  const attach = cn(layer?.deductible ?? layer?.attachment);
  const rol = layerHit(cn(groundUpEqLoss), attach, limit) / limit;
  return rol > 0 ? fmtRol(rol) : '0.00%';
}

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   open: boolean,
 *   contractId: string,
 *   isQuote: boolean,
 *   isTerminal?: boolean,
 *   currency: string,
 *   npDetail: Record<string, any>,
 * }} props
 */
export default function NpInsightModal({ pricing, open, contractId, isQuote, isTerminal = false, currency, npDetail }) {
  const {
    insightKey, setInsightOpen, layers, updateLayer, treatyMetrics, quotePricing, portfolioTreaties,
  } = pricing;
  if (!open) return null;
  // Only cat layers with a positive limit can accept the converted burning
  // cost — the panel's Apply button disables when none qualify.
  const catLayers = layers.filter((l) => l.cat && cn(l.limit) > 0);
  return (

                <div className="bbg-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setInsightOpen(false); }}>
                  <div className={`bbg-modal ${['LARGE_LOSSES','CAT_LOSSES','AGGREGATES','CEDANT','RISK_PROFILE','MKT_ANALYSIS','CHECKLIST','GEM'].includes(insightKey) ? 'bbg-modal--fullscreen' : 'bbg-modal--wide'}`}>
                    <div className="bbg-modal-head">
                      <span className="bbg-modal-title">
                        { insightKey === 'LARGE_LOSSES' ? 'Large Loss Selection'
                        : insightKey === 'CAT_LOSSES'   ? 'CAT Loss Selection'
                        : insightKey === 'AGGREGATES'   ? 'Cresta Aggregates'
                        : insightKey === 'MKT_ANALYSIS' ? 'Market Analysis'
                        : insightKey === 'RISK_PROFILE' ? 'Risk Profile'
                        : insightKey === 'CHECKLIST'    ? 'Underwriting Checklist'
                        : insightKey === 'GEM'          ? 'CAT Modelling'
                        : insightKey === 'CEDANT'       ? 'Cedant Summary'
                        : insightKey }
                      </span>
                      <button className="bbg-modal-x" onClick={() => setInsightOpen(false)}>✕</button>
                    </div>
                    <div className="bbg-modal-body bbg-modal-body--embed">
                      {insightKey === 'LARGE_LOSSES' && (
                        <div className="bbg-embed-screen">
                          <LossSelectionScreen routeKey="NP_LARGE_LOSS_SELECTION" title="Large Loss Selection" headerPill="" lossType="large" embedded />
                        </div>
                      )}
                      {insightKey === 'CAT_LOSSES' && (
                        <div className="bbg-embed-screen">
                          <LossSelectionScreen routeKey="NP_CAT_LOSS_SELECTION" title="CAT Loss Selection" headerPill="" lossType="cat" embedded />
                        </div>
                      )}
                      {insightKey === 'AGGREGATES' && (
                        <div className="bbg-embed-screen">
                          <NpCrestaAggregates embedded />
                        </div>
                      )}
                      {insightKey === 'RISK_PROFILE' && (
                        <div className="bbg-embed-screen">
                          <ProfileScreen routeKey="NP_RISK_PROFILE" title="Risk Profile" headerPill="" profileType="risk" embedded />
                        </div>
                      )}
                      {insightKey === 'CHECKLIST' && <NpChecklistPanel contractId={contractId} isQuote={isQuote} />}
                      {insightKey === 'GEM' && (
                        <div className="bbg-embed-screen">
                          <GemDamageRatioPanel
                            contractId={contractId}
                            catLayers={catLayers}
                            currency={currency}
                            onApplyToCat={(groundUpEqLoss) => {
                              // Convert the GEM ground-up EQ loss to the (first)
                              // cat layer's pure-burn ROL % and push it via the
                              // normal layer setter; the screen's existing Save
                              // persists it.
                              const target = catLayers[0];
                              const gi = target ? layers.indexOf(target) : -1;
                              if (gi < 0) return;
                              const rolPct = eqLossToCatPureBurn(groundUpEqLoss, target);
                              if (rolPct != null) updateLayer(gi, 'catPureBurn', rolPct);
                            }}
                            disabled={isTerminal}
                          />
                        </div>
                      )}
                      {insightKey === 'MKT_ANALYSIS' && (
                        <NpMarketAnalysis
                          layers={layers}
                          treatyMetrics={treatyMetrics}
                          quotePricing={quotePricing}
                          npDetail={npDetail}
                          portfolioTreaties={portfolioTreaties}
                        />
                      )}
                      {insightKey === 'CEDANT' && (
                        <CedantSummaryTabs
                          contractId={contractId}
                          currency={currency}
                          layers={layers}
                          isQuote={isQuote}
                          mode="NP"
                        />
                      )}
                    </div>
                  </div>
                </div>

  );
}
