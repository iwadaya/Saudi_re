// hooks/usePropPricingActions.js — Phase 4.2 (docs/frontend-hardening.md).
//
// PropPricing's imperative handlers — the component-grid snapshot
// save/delete and the offer workflow (submit / approve / sign / NTU /
// return / recall / decline) plus the CU-decline window-event bridge —
// moved VERBATIM out of PropPricing.jsx. Deliberately a plain-JS hook so
// the money-path bodies needed zero translation; like the originals the
// handlers are plain (non-memoized) functions recreated per render, and
// all state flows through the typed reducer setters passed in. The save()
// path itself stays in hooks/usePropPricingState.ts next to the
// optimistic-lock token it rotates.

import { useEffect } from 'react';
import { api } from '../../../../api';
import { COMPONENT_ROWS, fmtPct } from '../components/propPricingConstants.js';
import { logger } from '../../../../utils/logger';

/**
 * @param {{
 *   cid: string,
 *   actorName: string,
 *   showToast: (msg: string, duration?: number) => void,
 *   save: (options?: any) => Promise<boolean>,
 *   getC: (row: string, col: string) => any,
 *   calcResult: (col: string) => number,
 *   calcMaxComm: (col: string) => number,
 *   epi: number,
 *   fxRate: number,
 *   offerStatus: string,
 *   offerLine: string,
 *   offerComment: string,
 *   offerApprover: string,
 *   returnReason: string,
 *   signedLinePct: string,
 *   setSnapshots: Function,
 *   setSnapLabel: Function,
 *   setOfferStatusState: Function,
 *   setApprovalTrail: Function,
 *   setReturnReason: Function,
 * }} params
 */
export function usePropPricingActions({
  cid,
  actorName,
  showToast,
  save,
  getC,
  calcResult,
  calcMaxComm,
  epi,
  fxRate = 1,
  offerStatus,
  offerLine,
  offerComment,
  offerApprover,
  returnReason,
  signedLinePct,
  setSnapshots,
  setSnapLabel,
  setOfferStatusState,
  setApprovalTrail,
  setReturnReason,
}) {
  // ── Snapshot handlers ─────────────────────────────────────────────────────
  const handleSaveSnapshot = async (label) => {
    if (!cid) return;
    const snapData = {};
    COMPONENT_ROWS.forEach(name => {
      snapData[name] = {};
      ['actuarial', 'actual', 'exposure', 'market', 'uw', 'downside', 'comment'].forEach(col => {
        const isCalc = name === 'Result' || name.includes('Maximum');
        snapData[name][col] = isCalc ? (name === 'Result' ? fmtPct(calcResult(col)) : fmtPct(calcMaxComm(col))) : getC(name, col);
      });
    });
    try {
      const saved = await api.saveComponentSnapshot(cid, { label: label || `Snapshot ${new Date().toLocaleDateString()}`, components: snapData });
      setSnapshots(prev => [saved, ...prev]);
      setSnapLabel('');
    } catch (e) { logger.error('Snapshot save failed:', e); }
  };

  const handleDeleteSnapshot = async (snapId) => {
    try { await api.deleteComponentSnapshot(snapId); setSnapshots(prev => prev.filter(s => s.id !== snapId)); } catch (e) { logger.error('deleteComponentSnapshot failed:', e); showToast('Failed to delete snapshot: ' + (e?.message || 'Server error')); }
  };

  // ── Workflow actions ──────────────────────────────────────────────────────
  const isTerminal = ['SIGNED', 'NTU', 'DECLINED'].includes(offerStatus);
  const isReadOnly = isTerminal;

  const doSubmitForApproval = async ({ peer1UserId, breachType, comment } = {}) => {
    if (!offerLine) { showToast('Enter a written line % first.'); return; }
    // offerApprover holds the selected user_id from the dropdown
    const selectedPeer = peer1UserId || offerApprover || null;
    if (!selectedPeer) { showToast('Please select who to send the offer to.'); return; }
    const ok = await save();
    if (!ok) { showToast('Cannot submit: the latest pricing failed to save. Retry save first.'); return; }
    // epi_usd must actually be USD (F79): `epi` is in the TREATY currency, so
    // convert with the same local→USD fxRate the screen already uses for its
    // USD display toggle. The server derives its own USD EPI from the stored
    // contract and that value wins; this converted figure is only the fallback
    // when derivation finds nothing — it must not be an FX-factor-off local
    // amount compared against USD mandate limits.
    const epiUsd = Number.isFinite(epi) && epi > 0 ? epi * (Number.isFinite(fxRate) && fxRate > 0 ? fxRate : 1) : null;
    try {
      await api.submitOfferForApproval(cid, {
        line_pct: offerLine, peer1_user_id: selectedPeer,
        breach_type: breachType || null, epi_usd: epiUsd,
        comment: comment || offerComment, _actor: actorName,
      });
      setOfferStatusState('AWAITING_APPROVAL');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast(e.message || 'Failed to submit'); }
  };
  const doMarkApproved = async () => {
    const ok = await save();
    if (!ok) { showToast('Cannot approve: the latest pricing failed to save. Retry save first.'); return; }
    // Only advance UI state if the server actually accepted the
    // approval. The previous behaviour caught any error here and then
    // unconditionally advanced — leaving the local UI in APPROVED while
    // the contract on the server stayed in AWAITING_APPROVAL (or whatever
    // pre-approval state). The next save would then 422 because the
    // status machine on the server is the source of truth.
    try {
      await api.markOfferApproved(cid, { _actor: actorName, comment: returnReason || offerComment, line_pct: offerLine });
    } catch (e) {
      logger.error('mark-approved error:', e.message);
      showToast('Approval failed: ' + (e?.message || 'Server error') + '. UI state unchanged — please retry.');
      return;
    }
    setOfferStatusState('AWAITING_SIGNED_LINE');
    setReturnReason('');
    api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  };
  const doMarkSigned = async () => {
    // Hard guard: reject empty / zero / non-numeric signed line
    // (belt-and-braces with the modal button's own check).
    const n = parseFloat(String(signedLinePct || '').replace(/%/g, '').trim());
    if (!Number.isFinite(n) || n <= 0) {
      showToast('Cannot mark signed: enter a non-zero signed line %.');
      return;
    }
    const w = parseFloat(String(offerLine || '').replace(/%/g, '').trim());
    if (Number.isFinite(w) && n > w) {
      showToast(`Signed line (${n}%) cannot exceed the written line (${w}%).`);
      return;
    }
    try {
      await api.markOfferSigned(cid, { signed_line_pct: signedLinePct, _actor: actorName });
      setOfferStatusState('SIGNED');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to mark signed: ' + (e?.message || 'Server error')); }
  };
  const doMarkNTU = async () => {
    try {
      await api.markOfferNTU(cid, { reason: returnReason || offerComment || '', _actor: actorName });
    } catch(e) { showToast('Failed to mark NTU: ' + (e?.message || 'Server error')); return; }
    setOfferStatusState('NTU');
    api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  };
  const doReturnToUW = async () => {
    if (!returnReason.trim()) { showToast('Please enter a reason for returning to the underwriter.'); return; }
    try {
      await api.returnToUnderwriter(cid, { reason: returnReason, _actor: actorName });
      setReturnReason(''); setOfferStatusState('DRAFT');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to return: ' + (e?.message || 'Server error')); }
  };
  const doRecall = async (reason) => {
    try {
      await api.recallOffer(cid, { reason: reason || 'Recalled by underwriter', _actor: actorName });
    } catch(e) { showToast('Recall failed: ' + (e?.message || 'Server error')); return; }
    setReturnReason('');
    setOfferStatusState('DRAFT');
    api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
  };
  const doDecline = async () => {
    if (!window.confirm('Decline this treaty? This cannot be undone.')) return;
    const reason = returnReason.trim() || offerComment.trim() || 'Declined by Chief Underwriter';
    try {
      await api.declineContract(cid, reason, { body: { reason, _actor: actorName } });
      setOfferStatusState('DECLINED');
      api.getApprovalTrail(cid).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to decline: ' + (e?.message || 'Server error')); }
  };

  // ── CU decline triggered from offer modal ────────────────────────────────
  useEffect(() => {
    const handler = () => doDecline();
    window.addEventListener('prop-decline-from-cu', handler);
    return () => window.removeEventListener('prop-decline-from-cu', handler);
  });

  return {
    handleSaveSnapshot, handleDeleteSnapshot,
    isTerminal, isReadOnly,
    doSubmitForApproval, doMarkApproved, doMarkSigned, doMarkNTU,
    doReturnToUW, doRecall, doDecline,
  };
}

export default usePropPricingActions;
