// src/screens/non_proportional/stop_loss_pricing/NpStopLossPricing.jsx
//
// Live pricing screen for Stop Loss and Aggregate XL covers. Inputs
// edit in place; everything below them re-computes via priceStopLoss
// from client/src/logic/stopLossPricing.js. State persists in two
// layers:
//   - AppContext slice `npStopLossInputs` — instant, session-local,
//     survives wizard navigation
//   - Server (PUT /api/{treaties|quotes}/:id/np/stop-loss-pricing) —
//     persists across sessions; load happens on mount, save on
//     wizard nav via useScreenSave
//
// Layout (top to bottom):
//   1. Layer cover               — LR% vs absolute attachment + EPI
//   2. Burning Cost              — editable yearly aggregate table
//   3. Exposure Rating           — frequency λ + severity (Lognormal/Pareto)
//   4. Monte Carlo               — toggle + nTrials + seed
//   5. Method blend + loading    — weights and % loading
//   6. Result                    — pure ROL, total rate, annual premium

import { useMemo, useCallback, useRef } from 'react';
import api from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId } from '../../../hooks/useContractId';
import { useScreenSave } from '../../../hooks/useScreenSave';
import WizardLayout from '../../../components/WizardLayout';
import { priceStopLoss } from '../../../logic/stopLossPricing';

const ROUTE_KEY = 'NP_STOP_LOSS_PRICING';
const SLICE_KEY = 'npStopLossInputs';

// ── Defaults & helpers ──────────────────────────────────────────────────────

const DEFAULT_YEARS = 10;

const DEFAULT_INPUTS = {
  attachmentBasis: 'absolute', // 'absolute' | 'lossRatio'
  attachment: '',
  limit: '',
  attachmentLossRatio: '',
  limitLossRatio: '',
  epi: '',
  yearlyAggregates: [], // Hydrated lazily from the underlying treaty's history when empty.
  freqLambda: '',
  severityType: 'lognormal',
  sevMean: '',
  sevCv: '',
  paretoAlpha: '',
  paretoTheta: '',
  weightBurningCost: '50',
  weightExposureRating: '50',
  weightMonteCarlo: '0',
  loading: '20',
  useMonteCarlo: false,
  mcTrials: '10000',
  mcSeed: '1',
};

const toN = (v) => {
  if (v === '' || v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-eE]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const fmtMoney = (v) => {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

const fmtMoneyFull = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const fmtPct = (v, dp = 3) => (Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—');

// ── Styling primitives — match the dark/glass look used elsewhere ───────────

const COLORS = {
  cyan: '#00d4ff',
  amber: '#fbbf24',
  green: '#4ade80',
  red: '#f87171',
  purple: '#a855f7',
  mute: 'rgba(148,163,184,0.55)',
  rowEven: '#080f23',
  rowOdd: '#0a1125',
};

const styles = {
  shell: { maxWidth: 1180, margin: '0 auto', padding: '8px 0 48px' },
  section: {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 12,
    padding: '18px 22px',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '.14em',
    textTransform: 'uppercase',
    color: COLORS.cyan,
    marginBottom: 14,
  },
  sectionSub: {
    fontSize: 11,
    color: COLORS.mute,
    marginTop: -10,
    marginBottom: 14,
  },
  label: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '.10em',
    textTransform: 'uppercase',
    color: 'rgba(148,163,184,0.65)',
    marginBottom: 5,
  },
  input: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 6,
    color: 'rgba(226,232,240,0.92)',
    padding: '7px 10px',
    height: 32,
    width: '100%',
    fontSize: 12,
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 600,
  },
  select: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 6,
    color: 'rgba(226,232,240,0.92)',
    padding: '7px 10px',
    height: 32,
    fontSize: 12,
    outline: 'none',
    fontWeight: 600,
    cursor: 'pointer',
  },
  pillBtn: (active) => ({
    appearance: 'none',
    border: `1px solid ${active ? 'rgba(0,212,255,0.55)' : 'rgba(255,255,255,0.12)'}`,
    background: active ? 'rgba(0,212,255,0.10)' : 'rgba(255,255,255,0.02)',
    color: active ? COLORS.cyan : 'rgba(226,232,240,0.75)',
    borderRadius: 8,
    padding: '7px 14px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.06em',
    cursor: 'pointer',
  }),
  th: {
    padding: '11px 10px',
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.10)',
    background: '#050810',
    textAlign: 'center',
  },
  td: {
    padding: '7px 8px',
    textAlign: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    fontVariantNumeric: 'tabular-nums',
    fontSize: 12,
    verticalAlign: 'middle',
  },
  readonlyCell: {
    fontFamily: 'inherit',
    color: 'rgba(148,163,184,0.75)',
    fontWeight: 600,
  },
  warningBox: {
    marginTop: 14,
    background: 'rgba(248,113,113,0.06)',
    border: '1px solid rgba(248,113,113,0.30)',
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 11,
    color: '#fca5a5',
    lineHeight: 1.5,
  },
  resultCard: (color) => ({
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${color}55`,
    borderRadius: 10,
    padding: '14px 16px',
    textAlign: 'center',
  }),
  resultLabel: {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: 'rgba(148,163,184,0.50)',
    marginBottom: 6,
  },
  resultValue: (color) => ({
    fontSize: 22,
    fontWeight: 900,
    color,
    fontVariantNumeric: 'tabular-nums',
  }),
  resultSub: {
    fontSize: 10,
    color: 'rgba(148,163,184,0.55)',
    marginTop: 4,
  },
};

// Field row helper — label above a single input/select control.
function Field({ label, hint, children, span = 1 }) {
  return (
    <div style={{ gridColumn: `span ${span}` }}>
      <div style={styles.label}>{label}</div>
      {children}
      {hint && (
        <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.50)', marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function NpStopLossPricing() {
  const { state: appState, setSlice, replaceSlice } = useAppState();
  const contractId = useContractId();
  const apiOpts = useMemo(
    () => (appState.quoteMode ? { quote: true } : undefined),
    [appState.quoteMode],
  );
  const inputs = useMemo(
    () => ({ ...DEFAULT_INPUTS, ...(appState[SLICE_KEY] || {}) }),
    [appState],
  );

  // Seed the yearly-aggregates table from the underwriting year range
  // when the user first lands here. Empty aggregates are kept so the
  // burning-cost denominator includes zero-loss years (see annualiseLoss).
  const yearRange = useMemo(() => {
    const npDetail = appState.npTreatyDetail || {};
    const uwYear = parseInt(npDetail.startYear || new Date().getFullYear(), 10);
    const startYear = parseInt(
      npDetail.experienceStartYear || npDetail.startYear || (uwYear - DEFAULT_YEARS + 1),
      10,
    );
    const years = [];
    for (let y = startYear; y < uwYear; y++) years.push(y);
    return years.length > 0 ? years : Array.from({ length: DEFAULT_YEARS }, (_, i) => new Date().getFullYear() - DEFAULT_YEARS + i);
  }, [appState.npTreatyDetail]);

  const yearlyRows = useMemo(() => {
    const saved = inputs.yearlyAggregates || [];
    const savedMap = new Map(saved.map((r) => [r.year, r.aggregate]));
    return yearRange.map((year) => ({
      year,
      aggregate: savedMap.has(year) ? savedMap.get(year) : '',
    }));
  }, [yearRange, inputs.yearlyAggregates]);

  const setInput = useCallback(
    (patch) => {
      setSlice(SLICE_KEY, patch);
      markDirtyRef.current?.();
    },
    [setSlice],
  );

  // ── Server persistence via useScreenSave ──
  const markDirtyRef = useRef(null);
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const loadStopLoss = useCallback(
    (id) => api.getNpStopLossPricing(id, apiOpts),
    [apiOpts],
  );
  const persist = useCallback(
    (id, payload) => api.saveNpStopLossPricing(id, payload, apiOpts),
    [apiOpts],
  );
  const onLoaded = useCallback(
    (data) => {
      // Server returns { inputs, outputs, updated_at }. Replace the
      // whole slice so deletions in the saved record actually clear
      // (a merge would leak stale values from session edits).
      if (data && data.inputs && Object.keys(data.inputs).length > 0) {
        replaceSlice(SLICE_KEY, { ...DEFAULT_INPUTS, ...data.inputs });
      }
    },
    [replaceSlice],
  );

  const setYearAggregate = useCallback(
    (year, raw) => {
      const next = yearlyRows.map((r) =>
        r.year === year ? { year, aggregate: raw } : { year: r.year, aggregate: r.aggregate },
      );
      setInput({ yearlyAggregates: next });
    },
    [yearlyRows, setInput],
  );

  // Excel paste handler for the burning-cost table. Accepts a single
  // column of values (newline-separated) and fills consecutive years
  // downward starting from the pasted row. A pasted block with more
  // values than remaining years is truncated; single-cell pastes still
  // strip non-numeric characters (so "1,250,000" pastes as 1250000).
  const handleAggregatePaste = useCallback(
    (e, startIdx) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      // Excel column copy uses CRLF or LF between cells; we tolerate
      // either. Tab-separated rows are flattened by taking only the
      // first column — pricing data is one number per year, not a grid.
      const values = text
        .split(/[\r\n]+/)
        .map((line) => String(line.split('\t')[0] || '').trim())
        .filter((s) => s.length > 0);
      if (values.length === 0) return;
      e.preventDefault();
      const next = yearlyRows.map((r) => ({ year: r.year, aggregate: r.aggregate }));
      for (let i = 0; i < values.length && startIdx + i < next.length; i++) {
        // Strip currency / comma formatting; leave a bare numeric string
        // so the same code path as keyboard input cleans it via toN().
        const cleaned = values[i].replace(/[^0-9.\-eE]/g, '');
        next[startIdx + i] = { year: next[startIdx + i].year, aggregate: cleaned };
      }
      setInput({ yearlyAggregates: next });
    },
    [yearlyRows, setInput],
  );

  // ── Build the engine args from current inputs ──
  const engineArgs = useMemo(() => {
    const args = {
      loading: toN(inputs.loading) ?? 0,
      weights: {
        burningCost: toN(inputs.weightBurningCost) ?? 0,
        exposureRating: toN(inputs.weightExposureRating) ?? 0,
        monteCarlo: toN(inputs.weightMonteCarlo) ?? 0,
      },
      useMonteCarlo: !!inputs.useMonteCarlo,
      monteCarlo: { nTrials: toN(inputs.mcTrials) ?? 10_000, seed: toN(inputs.mcSeed) ?? 1 },
    };
    if (inputs.attachmentBasis === 'lossRatio') {
      args.attachmentLossRatio = toN(inputs.attachmentLossRatio);
      args.limitLossRatio = toN(inputs.limitLossRatio);
      args.epi = toN(inputs.epi);
    } else {
      args.attachment = toN(inputs.attachment);
      args.limit = toN(inputs.limit);
    }
    const numericRows = yearlyRows
      .map((r) => ({ year: r.year, aggregate: toN(r.aggregate) }))
      .filter((r) => r.aggregate !== null);
    if (numericRows.length > 0) {
      // Pad with zero-loss years for any year in range without an entry
      // (the denominator must include the full window).
      const filledMap = new Map(numericRows.map((r) => [r.year, r.aggregate]));
      args.yearlyAggregates = yearRange.map((y) => ({ year: y, aggregate: filledMap.get(y) ?? 0 }));
    }
    const lambda = toN(inputs.freqLambda);
    if (lambda !== null) {
      args.frequency = { lambda };
      if (inputs.severityType === 'lognormal') {
        const mean = toN(inputs.sevMean);
        const cv = toN(inputs.sevCv);
        if (mean !== null && cv !== null) {
          args.severity = { type: 'lognormal', mean, cv };
        }
      } else if (inputs.severityType === 'pareto') {
        const alpha = toN(inputs.paretoAlpha);
        const theta = toN(inputs.paretoTheta);
        if (alpha !== null && theta !== null) {
          args.severity = { type: 'pareto', alpha, theta };
        }
      }
    }
    return args;
  }, [inputs, yearlyRows, yearRange]);

  // Live-priced result. Memoised so heavy MC runs only re-execute
  // when an input that affects the result changes.
  const result = useMemo(() => priceStopLoss(engineArgs), [engineArgs]);

  // Snapshot the result for the persist payload — drop the per-year
  // burning-cost breakdown to keep the JSONB small; the engine can
  // reproduce it from inputs on demand.
  const outputsSnapshot = useMemo(() => ({
    attachment: result.attachment,
    limit: result.limit,
    blended: result.blended,
    burningCost: result.burningCost
      ? { annualLoss: result.burningCost.annualLoss, rol: result.burningCost.rol, nYears: result.burningCost.nYears }
      : null,
    exposureRating: result.exposureRating,
    monteCarlo: result.monteCarlo
      ? {
          annualLoss: result.monteCarlo.annualLoss,
          rol: result.monteCarlo.rol,
          cv: result.monteCarlo.cv,
          hitFrequency: result.monteCarlo.hitFrequency,
          percentiles: result.monteCarlo.percentiles,
          nTrials: result.monteCarlo.nTrials,
        }
      : null,
    warnings: result.warnings,
  }), [result]);

  const currentState = useCallback(
    () => ({ inputs: inputsRef.current, outputs: outputsSnapshot }),
    [outputsSnapshot],
  );

  const { save, markDirty } = useScreenSave({
    entityId: contractId || '',
    load: loadStopLoss,
    save: persist,
    currentState,
    onLoaded,
    errorLabel: 'Stop loss pricing',
  });
  markDirtyRef.current = markDirty;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <WizardLayout
      routeKey={ROUTE_KEY}
      title="Stop Loss Pricing"
      headerPill="NP TREATY: STOP LOSS / AGGREGATE XL"
      onBeforeBack={save}
      onBeforeNext={save}
    >
      <div style={styles.shell}>

        {/* ── 1. Layer cover ───────────────────────────────────────────── */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Layer Cover</div>
          <div style={styles.sectionSub}>
            Stop Loss attaches at a loss ratio of subject premium;
            Aggregate XL attaches at an absolute aggregate amount.
            Both flow through the same engine.
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              style={styles.pillBtn(inputs.attachmentBasis === 'absolute')}
              onClick={() => setInput({ attachmentBasis: 'absolute' })}
            >
              Absolute (Agg XL)
            </button>
            <button
              type="button"
              style={styles.pillBtn(inputs.attachmentBasis === 'lossRatio')}
              onClick={() => setInput({ attachmentBasis: 'lossRatio' })}
            >
              Loss Ratio (Stop Loss)
            </button>
          </div>

          {inputs.attachmentBasis === 'absolute' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
              <Field label="Attachment (D)" hint="Aggregate priority in currency">
                <input
                  style={styles.input}
                  value={inputs.attachment}
                  onChange={(e) => setInput({ attachment: e.target.value })}
                  placeholder="e.g. 10,000,000"
                />
              </Field>
              <Field label="Limit (L)" hint="Layer width in currency">
                <input
                  style={styles.input}
                  value={inputs.limit}
                  onChange={(e) => setInput({ limit: e.target.value })}
                  placeholder="e.g. 5,000,000"
                />
              </Field>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              <Field label="Attachment LR (%)" hint="e.g. 80 for 80% LR">
                <input
                  style={styles.input}
                  value={inputs.attachmentLossRatio}
                  onChange={(e) => setInput({ attachmentLossRatio: e.target.value })}
                  placeholder="80"
                />
              </Field>
              <Field label="Limit LR (%)" hint="Layer width as % of EPI">
                <input
                  style={styles.input}
                  value={inputs.limitLossRatio}
                  onChange={(e) => setInput({ limitLossRatio: e.target.value })}
                  placeholder="20"
                />
              </Field>
              <Field label="EPI" hint="Subject premium">
                <input
                  style={styles.input}
                  value={inputs.epi}
                  onChange={(e) => setInput({ epi: e.target.value })}
                  placeholder="e.g. 10,000,000"
                />
              </Field>
            </div>
          )}

          {(result.attachment > 0 || result.limit > 0) && (
            <div
              style={{
                marginTop: 14,
                padding: '10px 14px',
                background: 'rgba(0,212,255,0.04)',
                border: '1px solid rgba(0,212,255,0.20)',
                borderRadius: 8,
                fontSize: 12,
                color: 'rgba(226,232,240,0.85)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              Resolved layer:&nbsp;
              <strong style={{ color: COLORS.cyan }}>{fmtMoneyFull(result.limit)}</strong>
              &nbsp;xs&nbsp;
              <strong style={{ color: COLORS.cyan }}>{fmtMoneyFull(result.attachment)}</strong>
            </div>
          )}
        </div>

        {/* ── 2. Burning Cost ───────────────────────────────────────────── */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Burning Cost · Aggregate Annual Losses</div>
          <div style={styles.sectionSub}>
            One row per observation year — leave the cell blank for a
            zero-loss year (it still counts toward the long-run
            frequency denominator). Paste a column from Excel to fill
            multiple years at once.
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '45%' }} />
                <col style={{ width: '35%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={styles.th}>UW Year</th>
                  <th style={styles.th}>Aggregate Loss</th>
                  <th style={styles.th}>Layer Hit</th>
                </tr>
              </thead>
              <tbody>
                {yearlyRows.map((r, i) => {
                  const hit = result.burningCost?.byYear?.find((b) => b.year === r.year)?.inLayer ?? 0;
                  return (
                    <tr key={r.year} style={{ background: i % 2 === 0 ? COLORS.rowEven : COLORS.rowOdd }}>
                      <td style={{ ...styles.td, fontWeight: 800, color: 'rgba(0,212,255,0.70)', fontSize: 13 }}>
                        {r.year}
                      </td>
                      <td style={styles.td}>
                        <input
                          style={{ ...styles.input, maxWidth: 220, margin: '0 auto', textAlign: 'right' }}
                          value={r.aggregate}
                          onChange={(e) => setYearAggregate(r.year, e.target.value)}
                          onPaste={(e) => handleAggregatePaste(e, i)}
                          placeholder="0"
                        />
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          ...styles.readonlyCell,
                          color: hit > 0 ? COLORS.amber : 'rgba(148,163,184,0.40)',
                          fontWeight: 700,
                        }}
                      >
                        {hit > 0 ? fmtMoneyFull(hit) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <BurningCostSummary result={result.burningCost} />
        </div>

        {/* ── 3. Exposure Rating ───────────────────────────────────────── */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Exposure Rating · Compound Poisson</div>
          <div style={styles.sectionSub}>
            Frequency λ is the expected number of claims per year above
            the severity threshold. The Normal approximation prices the
            in-layer expected loss analytically; it breaks down for
            heavy-tailed severity (Pareto α ≤ 2) — use Monte Carlo instead.
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
                    value={inputs.sevMean}
                    onChange={(e) => setInput({ sevMean: e.target.value })}
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
                    value={inputs.paretoTheta}
                    onChange={(e) => setInput({ paretoTheta: e.target.value })}
                    placeholder="e.g. 100,000"
                  />
                </Field>
              </>
            )}
          </div>

          <ExposureRatingSummary result={result.exposureRating} limit={result.limit} />
        </div>

        {/* ── 4. Monte Carlo ───────────────────────────────────────────── */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Monte Carlo · Aggregate Simulation</div>
          <div style={styles.sectionSub}>
            Simulates N years of compound Poisson aggregate losses and
            applies the layer. Uses the same frequency and severity as
            Exposure Rating. Deterministic — seed in for reproducibility.
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

        {/* ── 5. Blend + loading ───────────────────────────────────────── */}
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

        {/* ── 6. Result ────────────────────────────────────────────────── */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Blended Result</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <div style={styles.resultCard(COLORS.cyan)}>
              <div style={styles.resultLabel}>Annual Layer Loss</div>
              <div style={styles.resultValue(COLORS.cyan)}>{fmtMoney(result.blended.annualLoss)}</div>
              <div style={styles.resultSub}>{fmtMoneyFull(result.blended.annualLoss)}</div>
            </div>
            <div style={styles.resultCard(COLORS.amber)}>
              <div style={styles.resultLabel}>Pure ROL</div>
              <div style={styles.resultValue(COLORS.amber)}>{fmtPct(result.blended.rol, 3)}</div>
              <div style={styles.resultSub}>Loss / Limit</div>
            </div>
            <div style={styles.resultCard(COLORS.green)}>
              <div style={styles.resultLabel}>Total Rate · After Loading</div>
              <div style={styles.resultValue(COLORS.green)}>{fmtPct(result.blended.totalRate, 3)}</div>
              <div style={styles.resultSub}>
                Premium: {fmtMoneyFull(result.blended.totalRate * result.limit)}
              </div>
            </div>
          </div>

          {result.warnings && result.warnings.length > 0 && (
            <div style={styles.warningBox}>
              <div style={{ fontWeight: 800, marginBottom: 4, letterSpacing: '.08em', textTransform: 'uppercase', fontSize: 10 }}>
                Warnings
              </div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </WizardLayout>
  );
}

// ── Per-method summary blocks ───────────────────────────────────────────────

function BurningCostSummary({ result }) {
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

function ExposureRatingSummary({ result, limit }) {
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

function MonteCarloSummary({ result, limit }) {
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
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 8,
              padding: '8px 10px',
              textAlign: 'center',
            }}
          >
            <div style={styles.resultLabel}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'rgba(226,232,240,0.85)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtMoneyFull(v)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
