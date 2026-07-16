// @ts-check
// components/ExposureRatingSection.jsx — engine-inputs form for the
// compound-Poisson exposure rating (frequency λ + lognormal/Pareto
// severity) plus its summary cards. Pure presentation, moved VERBATIM
// from NpStopLossPricing.jsx (Phase 4.2).

import { styles, Field } from './stopLossUi';
import { ExposureRatingSummary } from './MethodSummaries';
import { formatWithCommasDecimal, sanitizeNumber } from '../../../../utils/format';

/**
 * @param {{
 *   inputs: import('../state/stopLossPricingState').StopLossInputs,
 *   setInput: (patch: Record<string, unknown>) => void,
 *   result: import('../state/stopLossPricingState').StopLossResult,
 *   layerResults: import('../state/stopLossPricingState').StopLossResult[],
 * }} props
 */
export default function ExposureRatingSection({ inputs, setInput, result, layerResults }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Exposure Rating · Compound Poisson</div>
      <div style={styles.sectionSub}>
        Frequency λ is the expected number of claims per year above
        the severity threshold. The Normal approximation prices the
        in-layer expected loss analytically; it breaks down for
        heavy-tailed severity (Pareto α ≤ 2) — use Monte Carlo instead.
        {layerResults.length > 1 && (
          <> The summary below shows Layer 1; per-layer ROL is in the Blended Result table.</>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 12 }}>
        <Field label="Frequency λ" hint="Claims / year (Poisson rate)">
          <input
            style={styles.input}
            value={inputs.freqLambda}
            onChange={(e) => setInput({ freqLambda: e.target.value })}
            placeholder="e.g. 20"
          />
        </Field>
        <Field label="Severity">
          <select
            style={styles.select}
            value={inputs.severityType}
            onChange={(e) => setInput({ severityType: e.target.value })}
          >
            <option value="lognormal">Lognormal</option>
            <option value="pareto">Pareto</option>
          </select>
        </Field>
        {inputs.severityType === 'lognormal' ? (
          <>
            <Field label="Severity Mean" hint="E[X] per claim">
              <input
                style={styles.input}
                inputMode="decimal"
                value={formatWithCommasDecimal(inputs.sevMean)}
                onChange={(e) => setInput({ sevMean: sanitizeNumber(e.target.value) })}
                placeholder="e.g. 200,000"
              />
            </Field>
            <Field label="Severity CV" hint="σ / mean (e.g. 0.6)">
              <input
                style={styles.input}
                value={inputs.sevCv}
                onChange={(e) => setInput({ sevCv: e.target.value })}
                placeholder="0.6"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Pareto α" hint="Shape (>1 for finite mean)">
              <input
                style={styles.input}
                value={inputs.paretoAlpha}
                onChange={(e) => setInput({ paretoAlpha: e.target.value })}
                placeholder="2.5"
              />
            </Field>
            <Field label="Pareto θ" hint="Scale / threshold">
              <input
                style={styles.input}
                inputMode="decimal"
                value={formatWithCommasDecimal(inputs.paretoTheta)}
                onChange={(e) => setInput({ paretoTheta: sanitizeNumber(e.target.value) })}
                placeholder="e.g. 100,000"
              />
            </Field>
          </>
        )}
      </div>

      <ExposureRatingSummary result={result.exposureRating} limit={result.limit} />
    </div>
  );
}
