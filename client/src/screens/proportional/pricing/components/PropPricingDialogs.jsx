// components/PropPricingDialogs.jsx — Phase 4.2 (docs/frontend-hardening.md).
//
// The screen's inline overlay dialogs — Quick Summary, Decline, Mandate
// Block and the Insight fullscreen modal — extracted from PropPricing.jsx
// with the JSX (and its conditional gates, role="presentation" backdrops
// and embedded panels) verbatim. Each dialog is its own export so the
// orchestrator keeps every overlay in its original DOM position. Props
// in, callbacks out.

import { api } from '../../../../api';
import LossSelectionScreen from '../../../shared/LossSelectionScreen';
import ProfileScreen from '../../../shared/ProfileScreen';
import PropCrestaAggregates from '../../cresta_zones/PropCrestaAggregates';
import { QuickSummaryEmbed } from '../../quick_summary/PropQuickSummary';
import CedantSummaryTabs from '../../../../components/cedant/CedantSummaryTabs';
import { ChecklistPanel } from './insight/ChecklistPanel';
import { CompareTermsPanel } from './insight/CompareTermsPanel';
import { InternalMetricsPanel } from './insight/InternalMetricsPanel';
import { TreatyMetricsPanel } from './insight/TreatyMetricsPanel';
import { INSIGHT_BUTTONS } from './propPricingConstants';

/** Full-screen Quick Summary embed. */
export function PropQuickSummaryModal({ showQuickSummary, setShowQuickSummary, cid }) {
  return (
    <>
      {showQuickSummary && (
        <div className="bbg-modal-overlay" role="presentation" onClick={e => { if (e.target === e.currentTarget) setShowQuickSummary(false); }}>
          <div className="bbg-modal-full">
            <div className="bbg-modal-head">
              <span className="bbg-modal-title">Quick Summary</span>
              <button className="bbg-modal-close" onClick={() => setShowQuickSummary(false)}>×</button>
            </div>
            <div className="bbg-modal-body"><QuickSummaryEmbed contractId={cid} /></div>
          </div>
        </div>
      )}
    </>
  );
}

/** Decline-treaty reason dialog (confirm calls the decline endpoint directly). */
export function PropDeclineModal({
  showDecline, setShowDecline, declineReason, setDeclineReason,
  cid, actorName, showToast, setOfferStatusState,
}) {
  return (
    <>
      {showDecline && (
        <div className="bbg-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setShowDecline(false); }}>
          <div className="bbg-modal">
            <div className="bbg-modal-head"><span className="bbg-modal-title">Decline Treaty</span><button className="bbg-modal-x" onClick={() => setShowDecline(false)}>✕</button></div>
            <div className="bbg-modal-body">
              <textarea className="bbg-textarea" rows={4} value={declineReason} onChange={e => setDeclineReason(e.target.value)} placeholder="Reason for declining…" />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="bbg-btn bbg-btn--decline" onClick={async () => { try { await api.declineContract(cid, declineReason, { body: { reason: declineReason, _actor: actorName } }); } catch(e) { showToast('Decline failed: '+(e?.message||'Server error')); return; } setOfferStatusState('DECLINED'); setShowDecline(false); }}>Confirm Decline</button>
                <button className="bbg-btn" onClick={() => setShowDecline(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Mandate-restriction explainer shown when an offer is blocked by mandate. */
export function PropMandateBlockModal({
  showMandateBlock, setShowMandateBlock, mandateCheck, userSession, userRole,
}) {
  return (
    <>
      {showMandateBlock && mandateCheck && (
        <div className="bbg-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setShowMandateBlock(false); }}>
          <div className="bbg-modal" style={{ maxWidth: 520 }}>
            <div className="bbg-modal-head">
              <span className="bbg-modal-title">⚠ Mandate Restriction</span>
              <button className="bbg-modal-x" onClick={() => setShowMandateBlock(false)}>✕</button>
            </div>
            <div className="bbg-modal-body">
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginBottom: 12 }}>
                This treaty cannot be offered under your current mandate:
              </div>
              {(mandateCheck.reasons || []).map((r, i) => (
                <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', fontSize: 12, marginBottom: 8 }}>
                  {r}
                </div>
              ))}
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                Your role: <strong style={{ color: 'rgba(255,255,255,0.70)' }}>{userSession?.roleName || userRole}</strong>
                {mandateCheck.mandate?.effectiveLimitUsd ? ` · Limit: USD ${(mandateCheck.mandate.effectiveLimitUsd / 1e6).toFixed(0)}M` : ' · Unlimited'}
                {mandateCheck.resolvedEpiUsd ? ` · Treaty EPI: USD ${(mandateCheck.resolvedEpiUsd / 1e6).toFixed(1)}M` : ''}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="bbg-btn" onClick={() => setShowMandateBlock(false)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Fullscreen insight modal hosting the quick-action panels and embeds. */
export function PropInsightModal({
  insightOpen, insightKey, setInsightOpen,
  cid, appState, td, yearly, safeCcy, shareGrid, contract, epi, limit,
  marginAct, calcCR,
}) {
  return (
    <>
      {insightOpen && (
        <div className="bbg-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) setInsightOpen(false); }}>
          <div className="bbg-modal bbg-modal--fullscreen">
            <div className="bbg-modal-head">
              <span className="bbg-modal-title">{INSIGHT_BUTTONS.find(b => b.key === insightKey)?.label || insightKey}</span>
              <button className="bbg-modal-x" onClick={() => setInsightOpen(false)}>✕</button>
            </div>
            <div className={['CHECKLIST','INTERNAL_METRICS','TREATY_METRICS','COMPARE_TERMS'].includes(insightKey) ? 'bbg-modal-body' : 'bbg-modal-body bbg-modal-body--embed'}>
              {insightKey === 'CHECKLIST' && <ChecklistPanel contractId={cid} isQuote={!!appState.quoteMode} />}
              {insightKey === 'INTERNAL_METRICS' && <InternalMetricsPanel contractId={cid} td={td} yearly={yearly} currency={safeCcy} />}
              {insightKey === 'TREATY_METRICS' && <TreatyMetricsPanel shareGrid={shareGrid} contract={contract} td={td} epi={epi} limit={limit} yearly={yearly} contractId={cid} />}
              {insightKey === 'COMPARE_TERMS' && <CompareTermsPanel contractId={cid} contract={contract} td={td} />}
              {insightKey === 'CEDANT_SUMMARY' && <CedantSummaryTabs contractId={cid} currency={safeCcy} contract={contract} liveModelledMargin={marginAct} liveActualMargin={1 - calcCR('actual')} mode="PROP" />}
              {insightKey === 'LARGE_LOSSES' && <div className="bbg-embed-screen"><LossSelectionScreen routeKey="PROP_LARGE_LOSS_SELECTION" title="Large Loss Selection" headerPill="" lossType="large" embedded /></div>}
              {insightKey === 'CAT_LOSSES' && <div className="bbg-embed-screen"><LossSelectionScreen routeKey="PROP_CAT_LOSS_SELECTION" title="CAT Loss Selection" headerPill="" lossType="cat" embedded /></div>}
              {insightKey === 'RISK_PROFILES' && <div className="bbg-embed-screen"><ProfileScreen routeKey="PROP_RISK_PROFILE" title="Risk Profile" headerPill="" profileType="risk" embedded /></div>}
              {insightKey === 'CLAIMS_PROFILES' && <div className="bbg-embed-screen"><ProfileScreen routeKey="PROP_CLAIMS_PROFILE" title="Claims Profile" headerPill="" profileType="claims" embedded /></div>}
              {insightKey === 'COUNTRY_AGG' && <div className="bbg-embed-screen"><PropCrestaAggregates embedded /></div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
