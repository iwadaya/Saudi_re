// @ts-check
// components/BlendWeightsSection.jsx — method blend weights + loading
// form. Pure presentation, moved VERBATIM from NpStopLossPricing.jsx
// (Phase 4.2). Weights need not sum to 100 — the engine divides by
// their sum.

import { styles, Field } from './stopLossUi';

/**
 * @param {{
 *   inputs: import('../state/stopLossPricingState').StopLossInputs,
 *   setInput: (patch: Record<string, unknown>) => void,
 * }} props
 */
export default function BlendWeightsSection({ inputs, setInput }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Method Blend &amp; Loading</div>
      <div style={styles.sectionSub}>
        Weights need not sum to 100 — the engine divides by their
        sum. Set Monte Carlo to 0 to ignore it even when enabled.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <Field label="Burning Cost wt (%)">
          <input
            style={styles.input}
            value={inputs.weightBurningCost}
            onChange={(e) => setInput({ weightBurningCost: e.target.value })}
            placeholder="50"
          />
        </Field>
        <Field label="Exposure wt (%)">
          <input
            style={styles.input}
            value={inputs.weightExposureRating}
            onChange={(e) => setInput({ weightExposureRating: e.target.value })}
            placeholder="50"
          />
        </Field>
        <Field label="Monte Carlo wt (%)">
          <input
            style={styles.input}
            value={inputs.weightMonteCarlo}
            onChange={(e) => setInput({ weightMonteCarlo: e.target.value })}
            disabled={!inputs.useMonteCarlo}
            placeholder="0"
          />
        </Field>
        <Field label="Loading (%)" hint="Internal target loss ratio">
          <input
            style={styles.input}
            value={inputs.loading}
            onChange={(e) => setInput({ loading: e.target.value })}
            placeholder="20"
          />
        </Field>
      </div>
    </div>
  );
}
