// PropPricing.jsx — Phase 4.2 orchestrator (docs/frontend-hardening.md).
//
// All state lives in hooks/usePropPricingState.ts (typed reducer over
// state/propPricingReducer.ts, loads + auto-calc + share auto-fill effects,
// the optimistic-lock save path) with the derived pricing surface in
// hooks/usePropPricingDerived.ts and the snapshot/offer-workflow handlers
// in hooks/usePropPricingActions.js. This file renders the screen: the
// JSX below (and inside the extracted banner/decision-bar/dialog
// components) is the original, moved verbatim.

import { useAppState } from '../../../context/AppContext';
import { useContractId } from '../../../hooks/useContractId';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import AggDrilldownModal from './components/AggDrilldownModal';
import InDepthPortfolioModal from './components/InDepthPortfolioModal';

// ── Sub-components ──────────────────────────────────────────────────────────
import PropBloombergHero from './components/PropBloombergHero';
import PropComponentTable from './components/PropComponentTable';
import PropShareScenarios from './components/PropShareScenarios';
import PropOfferModal from './components/PropOfferModal';
import PropMovingAverageCharts from './components/PropMovingAverageCharts';
import { AggCobBreakdownModal } from './components/insight/AggCobBreakdownModal';
import MarketIntelligenceModal from '../../../components/market/MarketIntelligenceModal.jsx';
import { PropPricingStatusBanners, PropPricingReadOnlyBanner } from './components/PropPricingBanners';
import PropPricingDecisionBar from './components/PropPricingDecisionBar';
import {
  PropQuickSummaryModal, PropDeclineModal, PropMandateBlockModal, PropInsightModal,
} from './components/PropPricingDialogs';
import { INSIGHT_BUTTONS, cn } from './components/propPricingConstants';
import { usePropPricingState } from './hooks/usePropPricingState';

const ROUTE_KEY = 'PROP_PRICING';

export default function PropPricing() {
  const { state: appState } = useAppState();
  const contractId = useContractId();

  const {
    // identity / context
    td, cid, userRole, userSession, isCU, actorName, showToast, mandateCheck,
    // state
    loading, dirty, saveMsg, contract, components, leads, shareRows, shareGrid,
    yearly, comment, snapshots, snapLabel,
    offerStatus, offerLine, offerComment, offerApprover, eligibleApprovers,
    returnReason, declineReason, approvalTrail, signedLinePct,
    showDecline, showOffer, showMandateBlock, showQuickSummary, showMarketIntelligence,
    showAggBreakdown, showInDepth, showAggDrilldown, showSnapHistory, insightOpen, insightKey,
    showUSD, reinsurers, contractAgg100, otherCountryAgg, cobLabel,
    worstLR, usedPlaceholderLdfs, lossStale,
    // setters
    setLeads, setShareRows, setShareGrid, setComment, setSnapLabel, setShowSnapHistory,
    setOfferStatusState, setOfferLine, setOfferComment, setOfferApprover,
    setReturnReason, setDeclineReason, setSignedLinePct,
    setShowDecline, setShowOffer, setShowMandateBlock, setShowQuickSummary,
    setShowMarketIntelligence, setShowAggBreakdown, setShowInDepth, setShowAggDrilldown,
    setInsightOpen, setInsightKey, setShowUSD, setDirty,
    // grid helpers + derived pricing surface
    setC, getC, calcResult, calcCR, calcMaxComm,
    hdr, det2, treatyType, epi, limit, eventLimit, tMode, isQS, isSurplus,
    qsLimit, retentionPct, retentionAmt, surplusRetention, numLines,
    totalCapacity, combinedTotalLimit,
    commissionPctVal, profitCommPct, mgmtExpPct, taxesPctVal, brokeragePctVal,
    uwYear, cedant, country, broker, crAct, crUw, marginAct, marginUw,
    movingAvgTerms, safeCcy, displayCcy, toDisplay, money, fxLabel, fxInverse,
    balance, drivers, aiCalc,
    // save + snapshots + offer workflow
    save, handleSaveSnapshot, handleDeleteSnapshot, isTerminal, isReadOnly,
    doSubmitForApproval, doMarkApproved, doMarkSigned, doMarkNTU,
    doReturnToUW, doRecall, doDecline,
  } = usePropPricingState({ appState, contractId });

  if (loading) return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="PROPORTIONAL TREATY: FINAL PRICING">
      {() => <div className="bbg-loading">Loading pricing data...</div>}
    </WizardLayout>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="PROPORTIONAL TREATY: FINAL PRICING" onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="PRICING_PAGE">

          <PropPricingStatusBanners usedPlaceholderLdfs={usedPlaceholderLdfs} lossStale={lossStale} />

          {/* ═══ BLOOMBERG HERO ═══ */}
          <PropBloombergHero
            drivers={drivers} balance={balance}
            safeCcy={safeCcy} displayCcy={displayCcy} showUSD={showUSD} fxLabel={fxLabel}
            setShowUSD={setShowUSD}
            uwYear={uwYear} offerStatus={offerStatus} treatyType={treatyType}
            tMode={tMode} isQS={isQS} isSurplus={isSurplus}
            qsLimit={qsLimit} retentionPct={retentionPct} retentionAmt={retentionAmt}
            surplusRetention={surplusRetention} numLines={numLines}
            totalCapacity={totalCapacity} combinedTotalLimit={combinedTotalLimit}
            epi={epi} eventLimit={eventLimit}
            commissionPctVal={commissionPctVal} profitCommPct={profitCommPct}
            mgmtExpPct={mgmtExpPct} taxesPctVal={taxesPctVal} brokeragePctVal={brokeragePctVal}
            crAct={crAct} crUw={crUw} marginAct={marginAct} marginUw={marginUw} worstLR={worstLR}
            toDisplay={toDisplay} money={money} cobLabel={cobLabel}
            epiSplit={contract.epi_split||td.epiSplit||[]} cobNames={cobLabel?cobLabel.split(', '):[]}
            cedant={cedant} country={country} broker={broker}
          />

          {/* ═══ LEAD & EXPIRING + INSIGHT BUTTONS ═══ */}
          <div className="bbg-top-grid">
            <div className="bbg-card">
              <div className="bbg-card-title">Lead & Expiring</div>
              <div className="bbg-lead-form">
                <div className="bbg-field"><span className="bbg-flabel">Lead Reinsurer</span>
                  <select className="bbg-select" value={leads.lead_reinsurer || ''} onChange={e => { setLeads(p => ({ ...p, lead_reinsurer: e.target.value })); setDirty(true); }}>
                    <option value="">Select leader…</option>
                    {reinsurers.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </select></div>
                <div className="bbg-field"><span className="bbg-flabel">Expiring Reinsurer</span>
                  <select className="bbg-select" value={leads.expiring_reinsurer || ''} onChange={e => { setLeads(p => ({ ...p, expiring_reinsurer: e.target.value })); setDirty(true); }}>
                    <option value="">Select expiring…</option>
                    {reinsurers.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </select></div>
                <div className="bbg-field"><span className="bbg-flabel">Lead Share %</span>
                  <PctInput className="bbg-input" value={leads.lead_share_pct || ''} onChange={v => { setLeads(p => ({ ...p, lead_share_pct: v })); setDirty(true); }} placeholder="e.g. 50%" /></div>
              </div>
            </div>
            <div className="bbg-card bbg-card--insights">
              <div className="bbg-card-title">Quick Actions & Insights</div>
              <div className="bbg-insight-grid bbg-insight-grid--5col">
                {INSIGHT_BUTTONS.map(b => (
                  <button key={b.key} className={`bbg-ib bbg-ib--${b.color}`} onClick={() => { setInsightKey(b.key); setInsightOpen(true); }}>{b.label}</button>
                ))}
              </div>
            </div>
          </div>

          {/* ═══ COMPONENT PRICING TABLE ═══ */}
          <PropComponentTable
            getC={getC} setC={setC}
            calcResult={calcResult} calcMaxComm={calcMaxComm}
            snapshots={snapshots} snapLabel={snapLabel} setSnapLabel={setSnapLabel}
            showSnapHistory={showSnapHistory} setShowSnapHistory={setShowSnapHistory}
            dirty={dirty} saveMsg={saveMsg} isReadOnly={isReadOnly}
            onSave={save} onSaveSnapshot={handleSaveSnapshot} onDeleteSnapshot={handleDeleteSnapshot}
            onShowQuickSummary={() => setShowQuickSummary(true)}
            onShowInDepth={() => setShowInDepth(true)}
            onShowMarketIntelligence={() => setShowMarketIntelligence(true)}
            marketIntelligenceAvailable={!!(
              (hdr.country_id || td.countryId || td.country_id)
              && (hdr.primary_class_of_business_id || td.primaryClassOfBusinessId)
              && Number.isFinite(Number(uwYear))
            )}
          />

          {/* ═══ QUICK SUMMARY MODAL ═══ */}
          <PropQuickSummaryModal
            showQuickSummary={showQuickSummary} setShowQuickSummary={setShowQuickSummary} cid={cid}
          />

          {/* ═══ IN-DEPTH PORTFOLIO MODAL ═══ */}
          {showInDepth && (
            <InDepthPortfolioModal
              getC={getC}
              snapshots={snapshots}
              onClose={() => setShowInDepth(false)}
            />
          )}

          {/* ═══ SHARE SCENARIOS ═══ */}
          <PropShareScenarios
            shareRows={shareRows} setShareRows={setShareRows}
            shareGrid={shareGrid} setShareGrid={setShareGrid}
            contractAgg100={contractAgg100} otherCountryAgg={otherCountryAgg}
            toDisplay={toDisplay} setDirty={setDirty}
            onShowAggBreakdown={() => setShowAggBreakdown(true)}
            onShowAggDrilldown={() => setShowAggDrilldown(true)}
          />

          {/* ═══ AGG BREAKDOWN MODAL ═══ */}
          {showAggBreakdown && (
            <AggCobBreakdownModal
              contractId={cid} shareRows={shareRows}
              contractAgg100={contractAgg100} otherCountryAgg={otherCountryAgg}
              onClose={() => setShowAggBreakdown(false)}
            />
          )}

          {/* ═══ AGG DRILL-DOWN MODAL ═══ */}
          {showAggDrilldown && (
            <AggDrilldownModal
              contractId={cid}
              shareRows={shareRows}
              onClose={() => setShowAggDrilldown(false)}
            />
          )}

          {/* ═══ READ-ONLY BANNER ═══ */}
          <PropPricingReadOnlyBanner
            isReadOnly={isReadOnly} offerStatus={offerStatus} setShowOffer={setShowOffer}
          />

          {/* ═══ DECISION BAR ═══ */}
          <PropPricingDecisionBar
            comment={comment} setComment={setComment} setDirty={setDirty}
            isReadOnly={isReadOnly} offerStatus={offerStatus}
            setShowOffer={setShowOffer} setShowDecline={setShowDecline}
            td={td} appState={appState} components={components} yearly={yearly}
            contract={contract} shareRows={shareRows} shareGrid={shareGrid} leads={leads}
          />

          {/* ═══ DECLINE MODAL ═══ */}
          <PropDeclineModal
            showDecline={showDecline} setShowDecline={setShowDecline}
            declineReason={declineReason} setDeclineReason={setDeclineReason}
            cid={cid} actorName={actorName} showToast={showToast}
            setOfferStatusState={setOfferStatusState}
          />

          {/* ═══ MANDATE BLOCK MODAL ═══ */}
          <PropMandateBlockModal
            showMandateBlock={showMandateBlock} setShowMandateBlock={setShowMandateBlock}
            mandateCheck={mandateCheck} userSession={userSession} userRole={userRole}
          />

          {/* ═══ OFFER MODAL ═══ */}
          <PropOfferModal
            show={showOffer} onClose={() => setShowOffer(false)}
            offerStatus={offerStatus} offerLine={offerLine} setOfferLine={setOfferLine}
            offerComment={offerComment} setOfferComment={setOfferComment}
            offerApprover={offerApprover} setOfferApprover={setOfferApprover}
            returnReason={returnReason} setReturnReason={setReturnReason}
            signedLinePct={signedLinePct} setSignedLinePct={setSignedLinePct}
            approvalTrail={approvalTrail} actorName={actorName} isCU={isCU}
            isTerminal={isTerminal} marginAct={marginAct} marginUw={marginUw}
            crAct={crAct} crUw={crUw} epi={epi} limit={limit} eventLimit={eventLimit}
            fxInverse={fxInverse} safeCcy={safeCcy} money={money} aiCalc={aiCalc}
            contractId={cid} mandateCheck={mandateCheck}
            onSubmitForApproval={doSubmitForApproval}
            onMarkApproved={doMarkApproved} onReturnToUW={doReturnToUW}
            onMarkSigned={doMarkSigned} onMarkNTU={doMarkNTU} onDecline={doDecline} onRecall={doRecall}
            eligibleApprovers={eligibleApprovers}
            isQuote={!!appState.quoteMode}
          />

          {/* ═══ MARKET INTELLIGENCE MODAL ═══
              Trigger lives on the Component Pricing toolbar so the
              underwriter can review market context without entering
              the offer flow. */}
          <MarketIntelligenceModal
            show={showMarketIntelligence}
            onClose={() => setShowMarketIntelligence(false)}
            contractId={cid}
            countryId={hdr.country_id || td.countryId || td.country_id || null}
            classOfBusinessId={hdr.primary_class_of_business_id || td.primaryClassOfBusinessId || null}
            countryName={country}
            cobName={(cobLabel || '').split(',')[0]?.trim() || ''}
            targetYear={Number.isFinite(Number(uwYear)) ? Number(uwYear) : null}
            currency={safeCcy}
            treatyMetrics={{
              loss_ratio_pct: null,
              commission_pct: brokeragePctVal || null,
              retention_pct: cn(td.retentionPct) || cn(det2.retention_pct) || null,
              margin_pct: typeof marginAct === 'number' ? marginAct * 100 : null,
            }}
          />

          {/* ═══ INSIGHT MODAL ═══ */}
          <PropInsightModal
            insightOpen={insightOpen} insightKey={insightKey} setInsightOpen={setInsightOpen}
            cid={cid} appState={appState} td={td} yearly={yearly} safeCcy={safeCcy}
            shareGrid={shareGrid} contract={contract} epi={epi} limit={limit}
            marginAct={marginAct} calcCR={calcCR}
          />

          {/* ═══ MOVING AVERAGE CHARTS ═══ */}
          <PropMovingAverageCharts yearly={yearly} terms={movingAvgTerms} />

        </div>
      )}
    </WizardLayout>
  );
}
