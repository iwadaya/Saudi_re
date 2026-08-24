// NpFinalPricing — the NP money-path orchestrator (Phase 4.1 decomposition,
// docs/frontend-hardening.md). This file only wires context → hooks →
// components:
//   • state + data loads:  hooks/useNpPricingState (typed reducer in state/)
//   • imperative handlers: hooks/useNpPricingActions (engines, dual save,
//     offer workflow)
//   • render islands:      components/ (quote panel, treaty sections,
//     decision bar, offer/decline/insight modals, analysis modals)
// The golden-master suite (goldenMaster.test.jsx) pins every computed
// numeric output — keep it passing byte-identically.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useContractId } from '../../../hooks/useContractId';
import { useEditLock } from '../../../hooks/useEditLock';
import EditLockBanner, { ReadOnlyWrap } from '../../../components/EditLockBanner.jsx';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import { getNpTreatyTypeMode, isNpCatFlowDisabled, isNpRiskFlowDisabled, isNpAggregateXlTreaty } from '../../../utils/npTreatyType';
import NpAggregateXlStructure from '../structure/NpAggregateXlStructure';
import { getRole, getUserDisplayName } from '../../../utils/auth';
import MarketIntelligenceModal from '../../../components/market/MarketIntelligenceModal.jsx';

// Quote-mode pricing screen reuses the QuickBenchmark visual language
// (bm-topbar, bm-card, bm-meta-grid) so a treaty quote feels like an
// extension of the benchmarking workflow. All bm-* classes are defined
// in the benchmark.css file imported below — keep that file as the
// single source of truth for those styles.
import '../../benchmark/benchmark.css';

import { ROUTE_KEY } from './constants.js';
import SaveStateIndicator from './components/SaveStateIndicator.jsx';
import NpAggregateXlHero from './components/NpAggregateXlHero';
import NpReinsurerModal from './components/NpReinsurerModal.jsx';
import NpTechAnalysisModal from './components/NpTechAnalysisModal.jsx';
import FQBenchmarkModal from './components/FQBenchmarkModal.jsx';
import FQPricingGraphModal from './components/FQPricingGraphModal.jsx';
import FQPricingAnalysisModal from './components/FQPricingAnalysisModal.jsx';
import FQQuotePricingPanel from './components/FQQuotePricingPanel.jsx';
import NpTreatyInsightHeader from './components/NpTreatyInsightHeader.jsx';
import NpTreatyPricingSections from './components/NpTreatyPricingSections.jsx';
import NpDecisionBar from './components/NpDecisionBar.jsx';
import NpOfferModal from './components/NpOfferModal.jsx';
import NpDeclineModal from './components/NpDeclineModal.jsx';
import NpInsightModal from './components/NpInsightModal.jsx';

// All screen state + data loads (typed reducer, Phase 4.1) and the
// imperative handlers (engines, dual save, offer workflow).
import { useNpPricingState } from './hooks/useNpPricingState';
import { useNpTreatyDetail } from '../../../hooks/useNpTreatyDetail';
import { useNpPricingActions } from './hooks/useNpPricingActions.js';

export default function NpFinalPricing() {
  const contractId = useContractId();
  const { state: appState, structRefsMap } = useAppState();
  const navigate = useNavigate();
  const quoteMode = !!appState.quoteMode;
  const isQuote = quoteMode || ROUTE_KEY === 'NP_FINAL_QUOTE';
  const { readOnly, assignedToName: lockAssignedToName, refresh: refreshLock, markReadOnly } = useEditLock({
    contractId: isQuote ? null : contractId, quoteId: isQuote ? contractId : null, isQuote,
  });

  // npTreatyDetail with server fallback: on a deep link the slice is empty and
  // the header/mode logic would render RISK & CAT XL + SAR with a phantom Risk
  // XL section (audit F6). The treaty-type utils only read .npTreatyDetail, so
  // a shim object keeps them signature-compatible with the merged detail.
  const npDetail = useNpTreatyDetail(contractId, isQuote);
  const detailShim = useMemo(() => ({ npTreatyDetail: npDetail }), [npDetail]);
  const mode = getNpTreatyTypeMode(detailShim);
  const catDisabled = isNpCatFlowDisabled(detailShim);
  const riskDisabled = isNpRiskFlowDisabled(detailShim);
  const currency = npDetail.currencyCode || npDetail.currency || 'SAR';
  // Structure layers synced from NpStructure screen via AppContext
  const structureLayers = useMemo(
    () => (Array.isArray(appState.npStructureLayers) ? appState.npStructureLayers : []),
    [appState.npStructureLayers],
  );

  const isCU = getRole() === 'CU' || getRole() === 'CE'; // only CU/CE see approver panel
  const actorName = useMemo(() => getUserDisplayName(), []);

  // ── All screen state + loads live in the typed reducer hook ──
  // (state/pricingReducer.ts + hooks/useNpPricingState.ts, Phase 4.1).
  const pricing = useNpPricingState({
    contractId,
    quoteMode,
    isQuote,
    npDetail,
    countryId: npDetail.countryId || null,
    mode,
    riskDisabled,
    catDisabled,
    structureLayers,
  });
  const {
    layers, treatyMetrics, cobUwLimits, expiringEgnpi, reinsurers, leadSetup,
    loading, offerStatus, showDeclineModal, showOfferModal, marketModalOpen,
    showReinsurerModal, showTechAnalysisModal, insightOpen,
    quoteStructures, selectedCobs, benchmarkModal,
    saveState, pricingGraphModal, pricingAnalysisModal, expLayers,
    calcEngineRunning, runningStructures, calcEngineError,
    portfolioExportRows, clientStructures, techRatioAvg, quoteCurve,
    setShowReinsurerModal, setShowTechAnalysisModal, setMarketModalOpen,
    setTreatyMetrics, closeBenchmark, closePricingGraph, closePricingAnalysis,
    updateLeadSetup, updateClientStructureLayer, updateClientStructure,
  } = pricing;

  // ── Imperative handlers (engine runs, dual save, offer workflow) ──
  // moved verbatim to hooks/useNpPricingActions.js in Phase 4.1.
  const {
    runQuoteCalcEngine, runQuoteCalcStructure, runCalcEngine, save,
    doSubmitForApproval, doMarkApproved, doMarkSigned,
    doMarkNTU, doReturnToUW, doDecline,
  } = useNpPricingActions({
    pricing, contractId, quoteMode, isQuote, npDetail, mode, structRefsMap, actorName,
    readOnly, onServerReadOnly: markReadOnly,
  });

  // ── Workflow ──
  const isTerminal = ['SIGNED', 'NTU', 'DECLINED'].includes(offerStatus);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title={isQuote ? 'Final Quote' : 'Final Pricing'} headerPill={isQuote ? 'NON-PROPORTIONAL FINAL QUOTE' : 'NON-PROPORTIONAL TREATY: FINAL PRICING'} onBeforeNext={save} onBeforeBack={save}
      /* Own SaveStateIndicator covers workflow-button saves (Submit
         for Approval, Mark Signed, etc) that don't flow through
         wizard nav; suppress the WizardLayout one to avoid a double
         banner on Back/Next. */
      suppressSaveIndicator>
      {({ showToast }) => (
        <div className={`np-final-shell${isQuote ? ' np-final-shell--quote' : ''}`}>
          <SaveStateIndicator saveState={saveState} onRetry={save} />
          {readOnly && <EditLockBanner contractId={isQuote ? null : contractId} quoteId={isQuote ? contractId : null} isQuote={isQuote} assignedToName={lockAssignedToName} onAllocated={refreshLock} />}
          <ReadOnlyWrap readOnly={readOnly}>
          {loading ? <div className="df-card df-card--notice"><div className="df-note">Loading...</div></div> : (
            <>
              {isNpAggregateXlTreaty(detailShim) && (
                /* Aggregate XL treaties get the Bloomberg-style hero
                   at the top (populated from the structure slice)
                   followed by the structure read-only — edits
                   happen on the Structure page. */
                <>
                  <NpAggregateXlHero
                    npDetail={npDetail}
                    aggXlInputs={appState.npAggregateXlInputs}
                    offerStatus={offerStatus}
                    currency={currency}
                    techRatio={techRatioAvg}
                  />
                  <NpAggregateXlStructure currency={currency} readOnly />
                </>
              )}
              {isQuote ? (
                <FQQuotePricingPanel
                  pricing={pricing}
                  npDetail={npDetail}
                  currency={currency}
                  riskDisabled={riskDisabled}
                  catDisabled={catDisabled}
                  save={save}
                  runQuoteCalcEngine={runQuoteCalcEngine}
                  showToast={showToast}
                />
              ) : (
                <NpTreatyInsightHeader
                  pricing={pricing}
                  npDetail={npDetail}
                  mode={mode}
                  currency={currency}
                  navigate={navigate}
                  structureLayers={structureLayers}
                />
              )}

              {/* Country / Regional / Global analysis modal —
                  shared across quote + contract Final Pricing. */}
              <FQBenchmarkModal
                open={benchmarkModal.open}
                scope={benchmarkModal.scope}
                sourceLabel={benchmarkModal.sourceLabel}
                sourceLayers={benchmarkModal.sourceLayers}
                currency={currency}
                cobNames={selectedCobs.map((c) => c.name)}
                contractId={contractId}
                cobIds={selectedCobs.map((c) => c.id).filter(Boolean)}
                onClose={closeBenchmark}
              />
              <FQPricingGraphModal
                open={pricingGraphModal.open}
                sourceLabel={pricingGraphModal.sourceLabel}
                structure={pricingGraphModal.structure}
                expLayers={expLayers}
                npDetail={npDetail}
                portfolioRows={portfolioExportRows}
                currency={currency}
                onClose={closePricingGraph}
              />
              <FQPricingAnalysisModal
                pricingAnalysisModal={pricingAnalysisModal}
                clientStructures={clientStructures}
                currency={currency}
                isQuote={isQuote}
                riskDisabled={riskDisabled}
                catDisabled={catDisabled}
                quoteCurve={quoteCurve}
                contractId={contractId}
                cobIds={selectedCobs.map((c) => c.id).filter(Boolean)}
                runQuoteCalcEngine={runQuoteCalcEngine}
                runQuoteCalcStructure={runQuoteCalcStructure}
                calcEngineRunning={calcEngineRunning}
                runningStructures={runningStructures}
                calcEngineError={calcEngineError}
                updateClientStructureLayer={updateClientStructureLayer}
                updateClientStructure={updateClientStructure}
                save={save}
                doSubmitForApproval={doSubmitForApproval}
                onClose={closePricingAnalysis}
              />

              {isQuote && quoteStructures.length === 0 && (
                <section className="np-final-section">
                  <div className="np-final-card" style={{ padding: 24, textAlign: 'center' }}>
                    <p className="muted">No quote structures found. Define structures on the NP Structure screen.</p>
                  </div>
                </section>
              )}

              <NpTreatyPricingSections
                pricing={pricing}
                isQuote={isQuote}
                isTerminal={isTerminal}
                mode={mode}
                riskDisabled={riskDisabled}
                catDisabled={catDisabled}
                npDetail={npDetail}
                appState={appState}
                structureLayers={structureLayers}
                runCalcEngine={runCalcEngine}
              />

              <NpDecisionBar
                pricing={pricing}
                isQuote={isQuote}
                isTerminal={isTerminal}
                mode={mode}
                npDetail={npDetail}
                currency={currency}
                save={save}
                showToast={showToast}
                contractId={contractId}
                catDisabled={catDisabled}
                riskDisabled={riskDisabled}
              />

              <NpTechAnalysisModal
                open={showTechAnalysisModal}
                onClose={() => setShowTechAnalysisModal(false)}
                treatyMetrics={treatyMetrics}
                setTreatyMetrics={setTreatyMetrics}
                expiringEgnpi={expiringEgnpi}
                npDetail={npDetail}
                cobUwLimits={cobUwLimits}
              />

              <NpReinsurerModal
                open={showReinsurerModal}
                onClose={() => setShowReinsurerModal(false)}
                layers={layers}
                leadSetup={leadSetup}
                updateLeadSetup={updateLeadSetup}
                reinsurers={reinsurers}
                onSave={save}
              />

              <NpOfferModal
                pricing={pricing}
                open={showOfferModal}
                isCU={isCU}
                actorName={actorName}
                isTerminal={isTerminal}
                isQuote={isQuote}
                quoteMode={quoteMode}
                contractId={contractId}
                currency={currency}
                npDetail={npDetail}
                showToast={showToast}
                doSubmitForApproval={doSubmitForApproval}
                doMarkApproved={doMarkApproved}
                doMarkSigned={doMarkSigned}
                doMarkNTU={doMarkNTU}
                doReturnToUW={doReturnToUW}
                doDecline={doDecline}
              />

              {/* Market-intelligence child modal — sibling to the
                  offer modal so closing it returns to the offer
                  modal with state intact (layer lines, comments etc.
                  all live on this NpFinalPricing component, not
                  inside the offer modal). */}
              <MarketIntelligenceModal
                show={marketModalOpen}
                onClose={() => setMarketModalOpen(false)}
                contractId={contractId}
                countryId={npDetail.countryId || null}
                classOfBusinessId={
                  (Array.isArray(npDetail.classOfBusinessIds)
                    && npDetail.classOfBusinessIds[0])
                    || npDetail.primaryClassOfBusinessId
                    || null
                }
                countryName={npDetail?.countryName || npDetail?.country || ''}
                cobName={(() => {
                  const list = npDetail.cobNames
                    || npDetail.classOfBusinessNames
                    || [];
                  return Array.isArray(list) ? (list[0] || '') : '';
                })()}
                targetYear={Number(npDetail?.startYear) || Number(npDetail?.uwYear) || null}
                currency={currency}
                treatyMetrics={{
                  loss_ratio_pct: null,
                  commission_pct: Number.isFinite(Number(npDetail?.brokeragePct))
                    ? Number(npDetail.brokeragePct) : null,
                  retention_pct: null,
                  margin_pct: null,
                }}
              />

              <NpDeclineModal
                pricing={pricing}
                open={showDeclineModal}
                contractId={contractId}
                quoteMode={quoteMode}
                showToast={showToast}
              />

              <NpInsightModal
                pricing={pricing}
                open={insightOpen}
                contractId={contractId}
                isQuote={isQuote}
                isTerminal={isTerminal}
                currency={currency}
                npDetail={npDetail}
              />
            </>
          )}
          </ReadOnlyWrap>
        </div>
      )}
    </WizardLayout>
  );
}
