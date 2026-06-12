// NpStructure.jsx — NP Structure screen orchestrator (Phase 4.2).
//
// All state, math and persistence live in hooks/useNpStructureState.ts
// (typed reducer: state/structureReducer.ts; hydration mappers:
// state/structureHydration.ts). This file only routes between the four
// surfaces (Stop Loss / Aggregate XL / quote mode / standard layer grid)
// and wires the presentational cards in components/.
//
// The layer cascade + recalc behaviour is pinned literal-by-literal in
// goldenMaster.test.jsx — keep it green when touching anything here.
import { useId } from 'react';
import WizardLayout from '../../../components/WizardLayout';
import { useNpStructureState } from './hooks/useNpStructureState';
import { QuoteStructureSection } from './QuoteStructureSection';
import NpStopLossStructure from './NpStopLossStructure';
import NpStopLossExpiring from '../expiring_structure/NpStopLossExpiring';
import NpAggregateXlStructure from './NpAggregateXlStructure';
import LayerTableCard from './components/LayerTableCard';
import CobParticipationCard from './components/CobParticipationCard';
import CoveredPropsCard from './components/CoveredPropsCard';
import ExpiringStructureCard from './components/ExpiringStructureCard';
import ExpiringCurveModal from './components/ExpiringCurveModal';
import ExpiringCoveredPropsCard from './components/ExpiringCoveredPropsCard';

const ROUTE_KEY = 'NP_STRUCTURE';

export default function NpStructure() {
  const structuresCountSelectId = useId();
  const {
    // store state
    layers, cobRows, cobOptions, savedQuoteStructures, loading,
    expiringLayerCount, expiringLayers, expiringTerms, isRenewal,
    expiringAutoPopulated, showExpCurveModal,
    // derived
    quoteMode, mode, currency, structuresCount, isNetXl,
    riskLocked, catLocked, riskPillOn, catPillOn,
    reinstatementOptions, stopLossTreaty, aggregateXlTreaty,
    coveredPropsCalc, expiringCoveredPropsCalc,
    // callbacks
    updateStructuresCount, updateLayer, addLayer, deleteLastLayer,
    handleLayerPaste, handleExpiringPaste,
    updateCobRow, toggleCobLayer, updateCoveredProp,
    updateExpiringLayer, updateExpiringTerm, enableExpiringOverride,
    updateExpiringCoveredProp, addExpiringCoveredProp, removeExpiringCoveredProp,
    setShowExpCurveModal, markDirty, save,
  } = useNpStructureState();

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Structure" headerPill={`${quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY'}: STRUCTURE`} onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="NP_STRUCTURE">
          {stopLossTreaty ? (
            <>
              <NpStopLossStructure currency={currency} />
              <NpStopLossExpiring currency={currency} />
            </>
          ) : aggregateXlTreaty ? (
            <NpAggregateXlStructure currency={currency} />
          ) : loading ? <div className="df-card df-card--notice"><div className="df-note">Loading...</div></div> : (
            <>
              {/* ═══ QUOTE: Structures to Quote selector ═══ */}
              {quoteMode && (
                <section className="np-struct-card glass" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px' }}>
                    <label style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }} htmlFor={structuresCountSelectId}>
                      Structures to Quote
                    </label>
                    <select
                      id={structuresCountSelectId}
                      className="fi"
                      style={{ width: 120 }}
                      value={String(structuresCount)}
                      onChange={e => updateStructuresCount(e.target.value)}
                    >
                      {[1,2,3,4,5].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
                      Number of alternative structures to quote
                    </span>
                  </div>
                </section>
              )}

              {/* ═══ QUOTE MODE: render per-structure simplified sections ═══ */}
              {quoteMode ? (
                <>
                  {Array.from({ length: structuresCount }, (_, si) => (
                    <QuoteStructureSection
                      key={si}
                      structIdx={si}
                      currency={currency}
                      cobOptions={cobOptions}
                      reinstatementOptions={reinstatementOptions}
                      onDirty={markDirty}
                      initialData={savedQuoteStructures[si] || null}
                      mode={mode}
                    />
                  ))}
                </>
              ) : (
              <>
              {/* ═══ STANDARD MODE: full layer table ═══ */}
              <LayerTableCard
                layers={layers}
                currency={currency}
                mode={mode}
                riskLocked={riskLocked}
                catLocked={catLocked}
                riskPillOn={riskPillOn}
                catPillOn={catPillOn}
                reinstatementOptions={reinstatementOptions}
                onUpdateLayer={updateLayer}
                onAddLayer={addLayer}
                onDeleteLastLayer={deleteLastLayer}
                onPaste={handleLayerPaste}
              />

              {/* ═══ COB PARTICIPATION ═══ */}
              <CobParticipationCard
                cobRows={cobRows}
                layers={layers}
                currency={currency}
                onUpdateCobRow={updateCobRow}
                onToggleCobLayer={toggleCobLayer}
              />

              {/* ═══ PROPORTIONAL STRUCTURE COVERED ═══ */}
              <CoveredPropsCard
                isNetXl={isNetXl}
                rows={coveredPropsCalc}
                cobOptions={cobOptions}
                currency={currency}
                onUpdate={updateCoveredProp}
              />

              {/* ═══ EXPIRING STRUCTURE & TERMS ═══ */}
              <ExpiringStructureCard
                expiringLayerCount={expiringLayerCount}
                expiringLayers={expiringLayers}
                expiringTerms={expiringTerms}
                isRenewal={isRenewal}
                expiringAutoPopulated={expiringAutoPopulated}
                currency={currency}
                reinstatementOptions={reinstatementOptions}
                onUpdateLayer={updateExpiringLayer}
                onUpdateTerm={updateExpiringTerm}
                onEnableOverride={enableExpiringOverride}
                onShowCurve={() => setShowExpCurveModal(true)}
                onPaste={handleExpiringPaste}
              />

              {/* ── Expiring Structure Implied Pricing Curve Modal (prototype: fitPowerCurve) ── */}
              {showExpCurveModal && (
                <ExpiringCurveModal
                  expiringLayerCount={expiringLayerCount}
                  expiringLayers={expiringLayers}
                  onClose={() => setShowExpCurveModal(false)}
                />
              )}

              {/* ═══ EXPIRING PROPORTIONAL COVERED ═══ */}
              <ExpiringCoveredPropsCard
                isNetXl={isNetXl}
                isRenewal={isRenewal}
                locked={isRenewal && expiringAutoPopulated}
                rows={expiringCoveredPropsCalc}
                cobOptions={cobOptions}
                currency={currency}
                onUpdate={updateExpiringCoveredProp}
                onAddRow={addExpiringCoveredProp}
                onRemoveRow={removeExpiringCoveredProp}
              />
              </>
              )}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
