// LossParetoScreen.jsx — orchestrator for the Large/Cat Loss Pareto
// screens (Prop + NP variants pass routeKey/title/lossType).
//
// Phase 4.2 decomposition (docs/frontend-hardening.md): this file wires
// the pieces together; the substance lives in ./loss_pareto/
//   math/distributions.js   fits, KS, layer pricing, return periods
//   state/lossParetoReducer.ts + hooks/useLossParetoState.ts  typed state
//   hooks/useLossParetoData.js     load + snapshot hydration
//   hooks/useLossParetoDerived.js  fits/RPs/layer-cost memos + α refit
//   hooks/useLossParetoSave.js     snapshot payload, save, auto-save
//   components/                    the JSX islands
// Behaviour is pinned by LossParetoScreen.goldenMaster.test.jsx and
// utils/paretoFit.verifyExcel.test.js — NO math changes here.

import WizardLayout from '../../components/WizardLayout';
import { useContractId } from '../../hooks/useContractId';
import { useGlobalToast } from '../../hooks/useToast';
import { useAppState } from '../../context/AppContext';
import { toN as cn } from '../../utils/format';
import RpComparisonModal from './RpComparisonModal';
import { fmt, fDec } from './loss_pareto/format.js';
import Fld from './loss_pareto/components/Fld.jsx';
import FreqSevModal from './loss_pareto/components/FreqSevModal.jsx';
import GofTable from './loss_pareto/components/GofTable.jsx';
import StatsReturnPeriodsCards from './loss_pareto/components/StatsReturnPeriodsCards.jsx';
import ParetoRankingTable from './loss_pareto/components/ParetoRankingTable.jsx';
import LayerBurningCostCard from './loss_pareto/components/LayerBurningCostCard.jsx';
import OepCard from './loss_pareto/components/OepCard.jsx';
import { DISTS } from './loss_pareto/math/distributions';
import { useLossParetoState } from './loss_pareto/hooks/useLossParetoState';
import { useLossParetoData } from './loss_pareto/hooks/useLossParetoData.js';
import { useLossParetoDerived } from './loss_pareto/hooks/useLossParetoDerived.js';
import { useLossParetoSave } from './loss_pareto/hooks/useLossParetoSave.js';

// The Pareto math engine used to live in this file and is imported from
// here by utils/paretoFit.verifyExcel.test.js (the Excel verification
// suite) — keep re-exporting the public surface unchanged.
export {
  fitPareto,
  paretoCDF,
  paretoQ,
  calcKS,
  calcLayerPrice,
  lossReturnPeriod,
  rpAtAttachment,
  calcLayerPriceNumerical,
} from './loss_pareto/math/distributions';

/* ══════════════════════════════════════════
   MAIN COMPONENT
   ══════════════════════════════════════════ */
export default function LossParetoScreen({ routeKey, title, headerPill, lossType = 'large' }) {
  const contractId = useContractId();
  const showToast = useGlobalToast();
  const { state: appState } = useAppState();
  const isNpMode = appState.wizardMode === 'NP' || appState.quoteMode;
  const td = isNpMode ? (appState.npTreatyDetail || {}) : (appState.propTreatyDetail || {});

  const { state, actions } = useLossParetoState();
  useLossParetoData({ contractId, lossType, appState, td, actions });
  const derived = useLossParetoDerived(state, { lossType, appState, actions });
  const { saveSnapshot } = useLossParetoSave({ contractId, lossType, appState, state, derived, actions, showToast });

  const {
    loading, portfolioFallback, xm, limit, alpha, activeDist, yearsOvr, showChart,
    saving, saveError, lastSaveTime, tpRows, tpSource, rpSource, rpBlend,
    rpCompareOpen, oepRows, showOep, wEmp, wModel,
  } = state;
  const {
    stopLossTreaty, yearlyAggregates, inflated, fits, total, pareto,
    returnPeriods, effectiveReturnPeriods, count, avg, mxL, mnL, sd, t5,
    uwYrs, freq, avgYr, survivalFn, lp, structureLayers, blendedLayerRols,
    oepPts, oepLayerRols, bestFit,
  } = derived;

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={saveSnapshot} onBeforeBack={saveSnapshot}>
      {() => (
        <div className="LARGE_LOSS_PARETO_PAGE">
          {loading ? <div style={{padding:32,color:'rgba(255,255,255,.4)'}}>Loading…</div> : count === 0 ? (
            <div style={{padding:32,textAlign:'center',color:'rgba(255,255,255,.4)'}}>No selected losses. Go to Loss Selection first.</div>
          ) : (<>
            {portfolioFallback && (
              <div style={{margin:'0 0 14px',padding:'10px 16px',borderRadius:10,background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.30)',fontSize:12,color:'rgba(253,230,138,0.95)',lineHeight:1.5}}>
                <b style={{letterSpacing:'.04em'}}>PORTFOLIO AVERAGE.</b>{' '}
                This treaty has no {lossType === 'cat' ? 'CAT' : 'large'} losses of its own — the curve below is fitted to the cedant's wider portfolio
                ({lossType === 'cat' ? 'CAT' : 'large'} losses from {portfolioFallback.treatyCount} other {portfolioFallback.treatyCount === 1 ? 'treaty' : 'treaties'}). Add losses on the Loss Selection step to fit this treaty's own experience.
              </div>
            )}
            {/* HERO */}
            <div className="llp-hero">
              <div className="llp-hero-left">
                <div className="llp-title">
                  {stopLossTreaty ? 'Aggregate Distribution Fit' : 'Severity Distribution Fit'}
                </div>
                <div className="llp-subtitle">
                  {stopLossTreaty
                    ? `Stop Loss treaty: fitting Pareto / Lognormal / Exponential / Weibull to YEARLY AGGREGATES of selected ${lossType} losses (${yearlyAggregates.length} year${yearlyAggregates.length === 1 ? '' : 's'}). Toggle individual losses on the previous step to change the input.`
                    : `Fit parametric distributions to ${lossType} losses. Adjust threshold and limit. Compare Pareto, Lognormal, Exponential, Weibull via KS goodness-of-fit.`}
                </div>
              </div>
              <div className="llp-hero-right" style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                {saving && <span style={{fontSize:11,color:'rgba(255,255,255,.4)'}}>Saving…</span>}
                {saveError && <span style={{fontSize:11,color:'#f87171'}}>⚠ {saveError}</span>}
                {lastSaveTime && !saving && !saveError && <span style={{fontSize:11,color:'#4ade80'}}>✓ Saved</span>}
                <button className="llp-pill-btn" style={{background:'rgba(34,197,94,0.15)',borderColor:'rgba(34,197,94,0.4)',color:'#4ade80'}} onClick={async()=>{const ok=await saveSnapshot();if(!ok)showToast('Save failed — check console');}}>💾 Save Curve</button>
                <button className="llp-pill-btn" onClick={()=>actions.setShowChart(true)}>View Sev-Freq Curve</button>
              </div>
            </div>

            {/* PARAMETERS */}
            <div className="llp-params glass">
              <div className="llp-card-head"><div className="llp-card-title">Parameters</div><div className="llp-card-hint">Inputs auto-recompute stats + pricing</div></div>
              <div className="llp-form-grid">
                <Fld label="Pareto Min (Threshold)" help="Only losses ≥ threshold drive the tail." value={fmt(xm)} onCommit={v=>{const n=cn(v);if(n>0)actions.setXm(n);}}/>
                <Fld label="Treaty Limit (Max)" help="Auto-set from total Risk/Cat layer limits in Structure. Editable override." value={fmt(limit)} onCommit={v=>actions.setLimit(cn(v))}/>
                <Fld label="Alpha (α)" help="Higher α → lighter tail. Editable." value={fDec(alpha,3)} onCommit={v=>{const n=parseFloat(v);if(Number.isFinite(n)&&n>0)actions.setAlpha(n);}}/>
                <Fld label="Observation Years" help="Frequency = tail count ÷ years." value={yearsOvr||'10'} onCommit={v=>actions.setYearsOvr(v)}/>
              </div>
            </div>

            {/* FREQUENCY-SEVERITY CURVE MODAL */}
            {showChart && (
              <FreqSevModal
                lossType={lossType}
                activeDist={activeDist}
                onSelectDist={actions.setActiveDist}
                fits={fits}
                xm={xm}
                limit={limit}
                alpha={alpha}
                freq={freq}
                uwYrs={uwYrs}
                inflated={inflated}
                onClose={() => actions.setShowChart(false)}
              />
            )}

            {/* GOODNESS OF FIT TABLE */}
            <GofTable fits={fits} bestFit={bestFit} activeDist={activeDist} onSelectDist={actions.setActiveDist} />

            {/* STATS + RETURN PERIODS */}
            <StatsReturnPeriodsCards
              lossType={lossType}
              count={count} total={total} avg={avg} mxL={mxL} mnL={mnL} sd={sd} t5={t5}
              avgYr={avgYr} freq={freq} lp={lp} limit={limit}
              activeDist={activeDist}
              effectiveReturnPeriods={effectiveReturnPeriods}
              rpSource={rpSource} rpBlend={rpBlend} tpSource={tpSource}
              onOpenRpCompare={() => actions.setRpCompareOpen(true)}
            />

            {lossType === 'cat' && (
              <RpComparisonModal
                isOpen={rpCompareOpen}
                onClose={() => actions.setRpCompareOpen(false)}
                fittedRows={returnPeriods}
                tpRows={tpRows}
                tpSource={tpSource}
                rpSource={rpSource}
                rpBlend={rpBlend}
                distLabel={DISTS.find(d => d.key === activeDist)?.label || ''}
                fmt={fmt}
                onApply={({ tpRows: rows, tpSource: src, rpSource: sel, rpBlend: blend }) => {
                  actions.applyTp({ tpRows: rows, tpSource: src, rpSource: sel, rpBlend: blend });
                  // Auto-save effect re-runs because saveSnapshot's deps
                  // (via buildSnapshotPayload) include these state values.
                }}
              />
            )}

            {/* PARETO RANKING TABLE */}
            <ParetoRankingTable stopLossTreaty={stopLossTreaty} pareto={pareto} freq={freq} survivalFn={survivalFn} />

            {/* Layer Burning Cost (renders only when blended rows exist) */}
            <LayerBurningCostCard
              blendedLayerRols={blendedLayerRols}
              structureLayers={structureLayers}
              uwYrs={uwYrs}
              activeDist={activeDist}
              wEmp={wEmp} wModel={wModel}
              onSetWeights={actions.setWeights}
            />

            {/* Cat OEP Burning Cost (cat screen only) */}
            {lossType === 'cat' && (
              <OepCard
                showOep={showOep}
                onToggle={actions.toggleOep}
                oepRows={oepRows}
                onSetOepRow={actions.setOepRow}
                oepLayerRols={oepLayerRols}
                oepPts={oepPts}
              />
            )}
          </>)}
        </div>
      )}
    </WizardLayout>
  );
}
