// components/NpDecisionBar.jsx — Phase 4.1 extraction.
//
// The offer/decline action bar: Save, Export Excel, offer-status badge,
// and the Offer / Decline buttons. JSX moved verbatim from
// NpFinalPricing — props in, callbacks out, no logic changes.

import { exportNpPricingToExcel } from '../exportPricingToExcel.js';
import { toN } from '../formatters.js';
import { logger } from '../../../../utils/logger';

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   isQuote: boolean,
 *   isTerminal: boolean,
 *   mode: string,
 *   npDetail: Record<string, any>,
 *   currency: string,
 *   save: (options?: object) => Promise<boolean>,
 *   showToast: ((message: string) => void) | undefined,
 * }} props
 */
export default function NpDecisionBar({
  pricing,
  isQuote,
  isTerminal,
  mode,
  npDetail,
  currency,
  save,
  showToast,
}) {
  const {
    layers, quoteStructures, saveState, offerStatus,
    setShowOfferModal, setShowDeclineModal,
  } = pricing;

  return (
    <>
              {/* ═══════ OFFER / DECLINE BAR ═══════ */}
              <div className="np-bbg-decision-bar">
                <div className="np-bbg-decision-left">
                  <button
                    className="bbg-btn bbg-btn--save"
                    type="button"
                    onClick={async () => { const ok = await save(); showToast?.(ok ? 'Saved' : 'Save failed'); }}
                    disabled={saveState.status === 'saving'}
                  >
                    {saveState.status === 'saving' ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    className="bbg-btn"
                    style={{ borderColor: 'rgba(34,197,94,0.5)', color: '#4ade80', display: 'flex', alignItems: 'center', gap: 6 }}
                    title="Export all pricing data to Excel"
                    onClick={() => {
                      const progRows = layers.map((l) => {
                        const r = (() => {
                          try {
                            const shareFrac = toN(l.share) / 100 || 0;
                            const prem = shareFrac > 0 ? Math.round(toN(l.egnpi) * toN(l.riskTotalPrice || l.catTotalPrice || '0') / 100 * shareFrac) : 0;
                            const perRisk = shareFrac > 0 ? Math.round(toN(l.limit) * shareFrac) : 0;
                            return { prem, perRisk, catLim: 0, cedantTot: 0, aggContrib: 0, totalCountryAgg: 0, aal: 0, es: 0 };
                          } catch { return {}; }
                        })();
                        return r;
                      });
                      exportNpPricingToExcel({
                        layers,
                        quoteStructures,
                        mode,
                        treatyTypeStr: npDetail?.treatyTypeName || npDetail?.treatyType || '',
                        cedantName: npDetail?.cedantName || '',
                        countryName: npDetail?.countryName || '',
                        uwYear: npDetail?.startYear || '',
                        currency,
                        isQuote,
                        totalROL: (() => {
                          const ep = layers.reduce((s,l) => s + (toN(l.earnedPremium)||0), 0);
                          const lim = layers.reduce((s,l) => s + (toN(l.limit)||0), 0);
                          return (ep > 0 && lim > 0) ? (ep / lim) * 100 : 0;
                        })(),
                        egnpi: npDetail?.estGnpi || npDetail?.est_gnpi || 0,
                        totalLimit: layers.reduce((s, l) => s + (toN(l.limit) || 0), 0),
                        programmeRows: progRows,
                      }).catch(e => logger.error('Export failed:', e));
                    }}
                  >
                    ↓ Export Excel
                  </button>
                  {offerStatus && offerStatus !== 'DRAFT' && (
                    <span className={`bbg-status bbg-status--${offerStatus.toLowerCase()}`}>{offerStatus.replace(/_/g, ' ')}</span>
                  )}
                  {isTerminal && (
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginLeft: 8 }}>
                      Pricing locked — open offer modal to review.
                    </span>
                  )}
                </div>
                <div className="np-bbg-decision-right">
                  <button className="bbg-btn bbg-btn--offer"
                    onClick={() => setShowOfferModal(true)}>
                    {isTerminal ? 'View Offer' : offerStatus === 'AWAITING_APPROVAL' ? '⏳ Awaiting Approval' : offerStatus === 'AWAITING_SIGNED_LINE' ? '✍ Sign / NTU' : isQuote ? 'Submit Quotes' : 'Offer Treaty'}
                  </button>
                  {!isTerminal && (
                    <button className="bbg-btn bbg-btn--decline"
                      onClick={() => setShowDeclineModal(true)}>Decline</button>
                  )}
                </div>
              </div>
    </>
  );
}
