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
import CedantSummaryTabs from '../../../../components/cedant/CedantSummaryTabs';

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   open: boolean,
 *   contractId: string,
 *   isQuote: boolean,
 *   currency: string,
 *   npDetail: Record<string, any>,
 * }} props
 */
export default function NpInsightModal({ pricing, open, contractId, isQuote, currency, npDetail }) {
  const {
    insightKey, setInsightOpen, layers, treatyMetrics, quotePricing, portfolioTreaties,
  } = pricing;
  if (!open) return null;
  return (

                <div className="bbg-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setInsightOpen(false); }}>
                  <div className={`bbg-modal ${['LARGE_LOSSES','CAT_LOSSES','AGGREGATES','CEDANT','RISK_PROFILE','MKT_ANALYSIS','CHECKLIST'].includes(insightKey) ? 'bbg-modal--fullscreen' : 'bbg-modal--wide'}`}>
                    <div className="bbg-modal-head">
                      <span className="bbg-modal-title">
                        { insightKey === 'LARGE_LOSSES' ? 'Large Loss Selection'
                        : insightKey === 'CAT_LOSSES'   ? 'CAT Loss Selection'
                        : insightKey === 'AGGREGATES'   ? 'Cresta Aggregates'
                        : insightKey === 'MKT_ANALYSIS' ? 'Market Analysis'
                        : insightKey === 'RISK_PROFILE' ? 'Risk Profile'
                        : insightKey === 'CHECKLIST'    ? 'Underwriting Checklist'
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
