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

import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import api from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId } from '../../../hooks/useContractId';
import { useScreenSave } from '../../../hooks/useScreenSave';
import WizardLayout from '../../../components/WizardLayout';
import { priceStopLoss } from '../../../logic/stopLossPricing';
import { computeOnLevelFactors } from '../../../../../shared/onLevel.js';

const ROUTE_KEY = 'NP_STOP_LOSS_PRICING';
const SLICE_KEY = 'npStopLossInputs';

// ── Defaults & helpers ──────────────────────────────────────────────────────

const DEFAULT_YEARS = 10;

const DEFAULT_INPUTS = {
  // Stop Loss is always quoted as percentages of EPI. The "absolute"
  // attachment basis lived here while Aggregate XL was wedged into
  // the same screen — that's now its own workflow.
  attachmentLossRatio: '',
  limitLossRatio: '',
  epi: '',
  yearlyAggregates: [], // [{year, aggregate}] — raw losses ($) per year
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

// computeOnLevelFactors lives in shared/onLevel.js so the client and
// any future server-side validation work off the same arithmetic.

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

  // ── Pull premiums + rate changes from the relational EGNPI table so
  //    the burning cost can compute on-level adjusted premiums and LRs.
  const [premiumData, setPremiumData] = useState({ premiums: new Map(), rateChanges: new Map() });
  useEffect(() => {
    if (!contractId || typeof api.getNpEgnpiYear !== 'function') return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.getNpEgnpiYear(contractId, apiOpts);
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : (rows?.rows || rows?.years || []);
        const premiums = new Map();
        const rateChanges = new Map();
        for (const r of list) {
          const y = Number(r.uwYear ?? r.uw_year);
          if (!Number.isFinite(y)) continue;
          const egnpi = Number(String(r.egnpi ?? '').replace(/[^0-9.-]/g, ''));
          if (Number.isFinite(egnpi)) premiums.set(y, egnpi);
          const rc = Number(String(r.rate_change_pct ?? r.rateChangePct ?? '').replace(/[^0-9.-]/g, ''));
          if (Number.isFinite(rc)) rateChanges.set(y, rc);
        }
        setPremiumData({ premiums, rateChanges });
      } catch (err) {
        // Premiums missing is fine — burning cost just won't compute LRs.
        if (!cancelled) console.warn('[NpStopLossPricing] egnpi-year load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [contractId, apiOpts]);

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

  // ── On-level burning cost rows ──
  // Compose Premium (adjusted), Aggregate Loss, Loss Ratio, and the
  // normalised aggregate (LR × current_EPI) we feed to the engine.
  const burningCostRows = useMemo(() => {
    const onLevel = computeOnLevelFactors(yearRange, premiumData.rateChanges);
    return yearlyRows.map((r) => {
      const rawPremium = premiumData.premiums.get(r.year);
      const factor = onLevel.get(r.year) ?? 1;
      const adjustedPremium = Number.isFinite(rawPremium) ? rawPremium * factor : null;
      const aggregate = toN(r.aggregate);
      const lossRatio = (aggregate != null && adjustedPremium && adjustedPremium > 0)
        ? aggregate / adjustedPremium
        : null;
      return {
        year: r.year,
        rawPremium: Number.isFinite(rawPremium) ? rawPremium : null,
        onLevelFactor: factor,
        adjustedPremium,
        aggregate,
        aggregateRaw: r.aggregate,
        lossRatio,
      };
    });
  }, [yearRange, yearlyRows, premiumData]);

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
    args.attachmentLossRatio = toN(inputs.attachmentLossRatio);
    args.limitLossRatio = toN(inputs.limitLossRatio);
    args.epi = toN(inputs.epi);

    // Burning cost: feed normalised aggregates = LR × current_EPI so the
    // engine's absolute layer math gives the right answer. Years without
    // a usable LR (missing premium or aggregate) are dropped from the
    // burning cost computation rather than treated as zero — the long-run
    // denominator should only count years where we actually have data.
    const epi = args.epi;
    if (epi != null && epi > 0) {
      const usable = burningCostRows.filter((r) => r.lossRatio != null);
      if (usable.length > 0) {
        args.yearlyAggregates = usable.map((r) => ({ year: r.year, aggregate: r.lossRatio * epi }));
      }
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
  }, [inputs, burningCostRows]);

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
      headerPill="NP TREATY: STOP LOSS"
      onBeforeBack={save}
      onBeforeNext={save}
    >
      <div style={styles.shell}>

        {/* ── 1. Layer cover ───────────────────────────────────────────── */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Layer Cover · Loss-Ratio Basis</div>
          <div style={styles.sectionSub}>
            Stop Loss attaches at a loss ratio of subject premium —
            e.g. "20% xs 80% LR" pays losses between 80% and 100% loss
            ratio. EPI is the current-year subject premium.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <Field label="Attachment LR (%)" hint="e.g. 80 for 80% LR">
              <input
                aria-label="Attachment LR"
                style={styles.input}
                value={inputs.attachmentLossRatio}
                onChange={(e) => setInput({ attachmentLossRatio: e.target.value })}
                placeholder="80"
              />
            </Field>
            <Field label="Limit LR (%)" hint="Layer width as % of EPI">
              <input
                aria-label="Limit LR"
                style={styles.input}
                value={inputs.limitLossRatio}
                onChange={(e) => setInput({ limitLossRatio: e.target.value })}
                placeholder="20"
              />
            </Field>
            <Field label="EPI" hint="Current-year subject premium">
              <input
                aria-label="EPI"
                style={styles.input}
                value={inputs.epi}
                onChange={(e) => setInput({ epi: e.target.value })}
                placeholder="e.g. 10,000,000"
              />
            </Field>
          </div>

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
          <div style={styles.sectionTitle}>Burning Cost · Loss Ratios by UW Year</div>
          <div style={styles.sectionSub}>
            Premium comes from the Premiums Table and is on-levelled by
            the rate changes captured there. Loss Ratio = Aggregate
            Loss ÷ Premium (adjusted); Layer Hit applies the LR layer
            to that ratio and converts back to currency at the current
            EPI. Paste a column of losses from Excel.
          </div>
          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <colgroup>
                <col style={{ width: '11%' }} />
                <col style={{ width: '23%' }} />
                <col style={{ width: '24%' }} />
                <col style={{ width: '14%' }} />
                <col style={{ width: '28%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={styles.th}>UW Year</th>
                  <th style={styles.th}>Premium (Adjusted)</th>
                  <th style={styles.th}>Aggregate Loss</th>
                  <th style={styles.th}>Loss Ratio</th>
                  <th style={styles.th}>Layer Hit</th>
                </tr>
              </thead>
              <tbody>
                {burningCostRows.map((r, i) => {
                  const hit = result.burningCost?.byYear?.find((b) => b.year === r.year)?.inLayer ?? 0;
                  const lrColor = r.lossRatio == null
                    ? 'rgba(148,163,184,0.40)'
                    : r.lossRatio > 1.0
                      ? COLORS.red
                      : r.lossRatio > 0.8
                        ? COLORS.amber
                        : COLORS.green;
                  return (
                    <tr key={r.year} style={{ background: i % 2 === 0 ? COLORS.rowEven : COLORS.rowOdd }}>
                      <td style={{ ...styles.td, fontWeight: 800, color: 'rgba(0,212,255,0.70)', fontSize: 13 }}>
                        {r.year}
                      </td>
                      <td style={{ ...styles.td, ...styles.readonlyCell, textAlign: 'right' }}>
                        {Number.isFinite(r.adjustedPremium) ? (
                          <>
                            {fmtMoneyFull(r.adjustedPremium)}
                            {Math.abs(r.onLevelFactor - 1) > 1e-6 && (
                              <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(148,163,184,0.45)' }}>
                                ×{r.onLevelFactor.toFixed(3)}
                              </span>
                            )}
                          </>
                        ) : (
                          <span style={{ color: 'rgba(148,163,184,0.40)' }}>— (set EGNPI)</span>
                        )}
                      </td>
                      <td style={styles.td}>
                        <input
                          style={{ ...styles.input, maxWidth: 220, margin: '0 auto', textAlign: 'right' }}
                          value={r.aggregateRaw}
                          onChange={(e) => setYearAggregate(r.year, e.target.value)}
                          onPaste={(e) => handleAggregatePaste(e, i)}
                          placeholder="0"
                        />
                      </td>
                      <td style={{ ...styles.td, ...styles.readonlyCell, color: lrColor, fontWeight: 700 }}>
                        {r.lossRatio == null ? '—' : `${(r.lossRatio * 100).toFixed(1)}%`}
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          ...styles.readonlyCell,
                          color: hit > 0 ? COLORS.amber : 'rgba(148,163,184,0.40)',
                          fontWeight: 700,
                          textAlign: 'right',
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
