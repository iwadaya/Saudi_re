// components/NpDeclineModal.jsx — Phase 4.1 extraction.
//
// "Decline Treaty" confirmation modal. JSX moved verbatim from
// NpFinalPricing — props in, callbacks out, no logic changes.

import { api } from '../../../../api';

/**
 * @param {{
 *   pricing: import('../hooks/useNpPricingState').NpPricingStateApi,
 *   open: boolean,
 *   contractId: string,
 *   quoteMode: boolean,
 *   showToast: ((message: string) => void) | undefined,
 * }} props
 */
export default function NpDeclineModal({ pricing, open, contractId, quoteMode, showToast }) {
  const { declineReason, setDeclineReason, setShowDeclineModal, setOfferStatus } = pricing;
  if (!open) return null;
  return (

                <div className="screen-modal-backdrop" role="presentation" style={{ display: 'flex' }} onClick={e => { if (e.target === e.currentTarget) setShowDeclineModal(false); }}>
                  <div className="screen-modal" role="dialog">
                    <div className="screen-modal-header">
                      <div className="screen-modal-title">Decline Treaty</div>
                      <button className="screen-modal-close" onClick={() => setShowDeclineModal(false)}>✕</button>
                    </div>
                    <div className="screen-modal-body" style={{ padding: 20 }}>
                      <p>Reason for declining:</p>
                      <textarea className="np-mini-input" rows={3} value={declineReason} onChange={e => setDeclineReason(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
                      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                        <button className="np-btn np-btn--danger" onClick={async () => { try { await api.declineContract(contractId, declineReason, quoteMode ? { quote: true } : undefined); } catch(e) { showToast('Decline failed: '+(e?.message||'Server error')); return; } setOfferStatus('DECLINED'); setShowDeclineModal(false); }}>Decline</button>
                        <button className="np-btn" onClick={() => setShowDeclineModal(false)}>Cancel</button>
                      </div>
                    </div>
                  </div>
                </div>
              
  );
}
