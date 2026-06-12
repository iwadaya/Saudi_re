// @ts-check
// src/screens/non_proportional/stop_loss_pricing/NpStopLossPricing.jsx
//
// Live pricing screen for Stop Loss treaties — aggregate-loss covers
// quoted as percentages of subject premium (e.g. "20% xs 80% LR").
// Aggregate XL is a separate workflow.
//
// Burning cost works on annual loss ratios: for each historical UW
// year we pull the relational EGNPI, apply the on-level rate-change
// chain captured on the Premiums Table (Π over later years of
// (1 + r_i/100)), divide losses by the adjusted premium to get a LR,
// then apply the LR%-based stop-loss layer to derive the burning rate.
//
// The engine still works in absolute terms; we feed it a normalised
// aggregate = LR × current_EPI per year so it can re-use the same
// layerHit / annualiseLoss primitives.
//
// State persists in two layers:
//   - AppContext slice `npStopLossInputs` — session-local, survives
//     wizard navigation
//   - Server (PUT /api/{treaties|quotes}/:id/np/stop-loss-pricing) —
//     cross-session, via useScreenSave
//
// Phase 4.2 decomposition: this file is the orchestrator only. State,
// effects and the derived pricing pipeline live in
// hooks/useStopLossPricingState.ts (pure pieces in
// state/stopLossPricingState.ts); the JSX islands live in components/.
// goldenMaster.test.jsx pins the observable behaviour byte-for-byte.

import WizardLayout from '../../../components/WizardLayout';
import { useStopLossPricingState } from './hooks/useStopLossPricingState';
import { styles } from './components/stopLossUi';
import LayerCoverSection from './components/LayerCoverSection';
import BurningCostSection from './components/BurningCostSection';
import ExposureRatingSection from './components/ExposureRatingSection';
import MonteCarloSection from './components/MonteCarloSection';
import BlendWeightsSection from './components/BlendWeightsSection';
import BlendedResultSection from './components/BlendedResultSection';

const ROUTE_KEY = 'NP_STOP_LOSS_PRICING';

export default function NpStopLossPricing() {
  const {
    inputs,
    setInput,
    layers,
    layerCount,
    layerResults,
    result,
    burningCostRows,
    setYearAggregate,
    handleAggregatePaste,
    save,
  } = useStopLossPricingState();

  return (
    <WizardLayout
      routeKey={ROUTE_KEY}
      title="Stop Loss Pricing"
      headerPill="NP TREATY: STOP LOSS"
      onBeforeBack={save}
      onBeforeNext={save}
    >
      <div style={styles.shell}>
        {/* 1. Layer cover (read-only mirror of Structure) */}
        <LayerCoverSection layers={layers} layerResults={layerResults} layerCount={layerCount} />

        {/* 2. Burning cost — on-level loss ratios by UW year */}
        <BurningCostSection
          burningCostRows={burningCostRows}
          layerResults={layerResults}
          result={result}
          setYearAggregate={setYearAggregate}
          handleAggregatePaste={handleAggregatePaste}
        />

        {/* 3. Exposure rating — compound Poisson */}
        <ExposureRatingSection inputs={inputs} setInput={setInput} result={result} layerResults={layerResults} />

        {/* 4. Monte Carlo — seeded aggregate simulation */}
        <MonteCarloSection inputs={inputs} setInput={setInput} result={result} layerResults={layerResults} />

        {/* 5. Method blend + loading */}
        <BlendWeightsSection inputs={inputs} setInput={setInput} />

        {/* 6. Blended result by layer */}
        <BlendedResultSection layerResults={layerResults} result={result} />
      </div>
    </WizardLayout>
  );
}
