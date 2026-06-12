// @ts-check
// components/MonteCarloSection.jsx — Monte Carlo toggle, trials/seed
// inputs and the simulated-percentile summary. Pure presentation, moved
// VERBATIM from NpStopLossPricing.jsx (Phase 4.2); the seeded-run card
// text is pinned by goldenMaster.test.jsx.

import { COLORS, styles, Field } from './stopLossUi';
import { MonteCarloSummary } from './MethodSummaries';

/**
 * @param {{
 *   inputs: import('../state/stopLossPricingState').StopLossInputs,
 *   setInput: (patch: Record<string, unknown>) => void,
 *   result: import('../state/stopLossPricingState').StopLossResult,
 *   layerResults: import('../state/stopLossPricingState').StopLossResult[],
 * }} props
 */
export default function MonteCarloSection({ inputs, setInput, result, layerResults }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Monte Carlo · Aggregate Simulation</div>
      <div style={styles.sectionSub}>
        Simulates N years of compound Poisson aggregate losses and
        applies the layer. Uses the same frequency and severity as
        Exposure Rating. Deterministic — seed in for reproducibility.
        {layerResults.length > 1 && (
          <> Summary shows Layer 1 percentiles; per-layer MC ROL is in the Blended Result table.</>
        )}
      </div>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          userSelect: 'none',
          marginBottom: 14,
        }}
      >
        <input
          type="checkbox"
          checked={inputs.useMonteCarlo}
          onChange={(e) => setInput({ useMonteCarlo: e.target.checked })}
          style={{ accentColor: COLORS.cyan, width: 16, height: 16 }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(226,232,240,0.85)' }}>
          Run Monte Carlo
        </span>
      </label>

      {inputs.useMonteCarlo && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, marginBottom: 14 }}>
            <Field label="Trials" hint="More trials → tighter estimates">
              <input
                style={styles.input}
                value={inputs.mcTrials}
                onChange={(e) => setInput({ mcTrials: e.target.value })}
                placeholder="10000"
              />
            </Field>
            <Field label="Seed" hint="Same seed → identical output">
              <input
                style={styles.input}
                value={inputs.mcSeed}
                onChange={(e) => setInput({ mcSeed: e.target.value })}
                placeholder="1"
              />
            </Field>
          </div>
          <MonteCarloSummary result={result.monteCarlo} limit={result.limit} />
        </>
      )}
    </div>
  );
}
