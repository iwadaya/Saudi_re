// @ts-check
// components/MethodSummaries.jsx — per-method summary cards for the
// NP Stop Loss Pricing screen: Burning Cost, Exposure Rating and Monte
// Carlo. Pure presentation, moved VERBATIM from NpStopLossPricing.jsx
// (Phase 4.2); the rendered card text is pinned by goldenMaster.test.jsx.

import { COLORS, styles, fmtMoney, fmtMoneyFull, fmtPct } from './stopLossUi';

/** @param {{ result: import('../../../../logic/stopLossPricing').BurningCostResult | null }} props */
export function BurningCostSummary({ result }) {
  if (!result || result.nYears === 0) {
    return (
      <div style={{ marginTop: 14, fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>
        Enter at least one yearly aggregate to compute burning cost.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
      <div style={styles.resultCard(COLORS.cyan)}>
        <div style={styles.resultLabel}>Annual Loss</div>
        <div style={styles.resultValue(COLORS.cyan)}>{fmtMoney(result.annualLoss)}</div>
        <div style={styles.resultSub}>{fmtMoneyFull(result.annualLoss)}</div>
      </div>
      <div style={styles.resultCard(COLORS.amber)}>
        <div style={styles.resultLabel}>ROL</div>
        <div style={styles.resultValue(COLORS.amber)}>{fmtPct(result.rol, 3)}</div>
        <div style={styles.resultSub}>—</div>
      </div>
      <div style={styles.resultCard(COLORS.mute)}>
        <div style={styles.resultLabel}>Years Observed</div>
        <div style={styles.resultValue(COLORS.mute)}>{result.nYears}</div>
        <div style={styles.resultSub}>incl. zero-loss years</div>
      </div>
    </div>
  );
}

/** @param {{ result: import('../../../../logic/stopLossPricing').ExposureRatingResult | null, limit: number }} props */
export function ExposureRatingSummary({ result, limit }) {
  if (!result) {
    return (
      <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>
        Provide frequency λ and severity parameters to compute exposure rating.
      </div>
    );
  }
  if (!result.normalApproxValid) {
    return (
      <div style={styles.warningBox}>
        Normal approximation invalid for this severity — toggle Monte
        Carlo and weight it instead.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
      <div style={styles.resultCard(COLORS.cyan)}>
        <div style={styles.resultLabel}>Layer Loss</div>
        <div style={styles.resultValue(COLORS.cyan)}>{fmtMoney(result.annualLoss)}</div>
        <div style={styles.resultSub}>{fmtMoneyFull(result.annualLoss)}</div>
      </div>
      <div style={styles.resultCard(COLORS.amber)}>
        <div style={styles.resultLabel}>ROL</div>
        <div style={styles.resultValue(COLORS.amber)}>{fmtPct(result.rol, 3)}</div>
        <div style={styles.resultSub}>Loss / {fmtMoney(limit)}</div>
      </div>
      <div style={styles.resultCard(COLORS.mute)}>
        <div style={styles.resultLabel}>E[S]</div>
        <div style={styles.resultValue(COLORS.mute)}>{fmtMoney(result.aggMean)}</div>
        <div style={styles.resultSub}>{fmtMoneyFull(result.aggMean)}</div>
      </div>
      <div style={styles.resultCard(COLORS.mute)}>
        <div style={styles.resultLabel}>σ[S]</div>
        <div style={styles.resultValue(COLORS.mute)}>{fmtMoney(result.aggStd)}</div>
        <div style={styles.resultSub}>{fmtMoneyFull(result.aggStd)}</div>
      </div>
    </div>
  );
}

/** @param {{ result: import('../../../../logic/stopLossPricing').MonteCarloResult | null, limit: number }} props */
export function MonteCarloSummary({ result, limit }) {
  if (!result) {
    return (
      <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>
        Provide frequency + severity to run Monte Carlo.
      </div>
    );
  }
  return (
    <>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 12 }}>
        <div style={styles.resultCard(COLORS.cyan)}>
          <div style={styles.resultLabel}>Layer Loss</div>
          <div style={styles.resultValue(COLORS.cyan)}>{fmtMoney(result.annualLoss)}</div>
          <div style={styles.resultSub}>{fmtMoneyFull(result.annualLoss)}</div>
        </div>
        <div style={styles.resultCard(COLORS.amber)}>
          <div style={styles.resultLabel}>ROL</div>
          <div style={styles.resultValue(COLORS.amber)}>{fmtPct(result.rol, 3)}</div>
          <div style={styles.resultSub}>Loss / {fmtMoney(limit)}</div>
        </div>
        <div style={styles.resultCard(COLORS.purple)}>
          <div style={styles.resultLabel}>CV</div>
          <div style={styles.resultValue(COLORS.purple)}>{result.cv.toFixed(2)}</div>
          <div style={styles.resultSub}>σ / mean</div>
        </div>
        <div style={styles.resultCard(COLORS.green)}>
          <div style={styles.resultLabel}>Hit Frequency</div>
          <div style={styles.resultValue(COLORS.green)}>{(result.hitFrequency * 100).toFixed(1)}%</div>
          <div style={styles.resultSub}>Pr(layer hit &gt; 0)</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        {[
          ['P50', result.percentiles.p50],
          ['P75', result.percentiles.p75],
          ['P90', result.percentiles.p90],
          ['P95', result.percentiles.p95],
          ['P99', result.percentiles.p99],
        ].map(([label, v]) => (
          <div
            key={label}
            style={{
              background: 'var(--surface-hover)',
              border: '1px solid var(--hairline)',
              borderRadius: 8,
              padding: '8px 10px',
              textAlign: 'center',
            }}
          >
            <div style={styles.resultLabel}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'rgba(var(--text-rgb),0.85)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtMoneyFull(v)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
