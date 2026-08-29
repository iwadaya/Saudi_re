import { describe, it, expect } from 'vitest';
import { toCandidate, buildTechnicalPremium, technicalAdequacy, METHOD_ROLE } from './pipeline.js';

const workbook = (ratePm) => toCandidate('WORKBOOK_RATE', { available: true, ratePm });
const burn = (ratePm, extra = {}) => toCandidate('BURNING_COST', {
  available: true, ratePm, claimCount: 8, years: 5, diagnostics: {}, ...extra,
});

describe('toCandidate', () => {
  it('carries an unavailable method through with its reason', () => {
    const c = toCandidate('EXPOSURE_CURVE', { available: false, unavailableReason: 'No curve set loaded.' });
    expect(c.available).toBe(false);
    expect(c.ratePm).toBeNull();
    expect(c.unavailableReason).toMatch(/No curve set/);
    expect(c.role).toBe('EXPOSURE');
  });

  it('labels methods and puts them on the right side of the blend', () => {
    expect(METHOD_ROLE.BURNING_COST).toBe('EXPERIENCE');
    expect(METHOD_ROLE.EXPOSURE_CURVE).toBe('EXPOSURE');
    expect(METHOD_ROLE.BENCHMARK).toBe('REFERENCE');
    expect(toCandidate('BURNING_COST', { available: true, ratePm: 1 }).label).toBe('Burning cost');
  });
});

describe('buildTechnicalPremium — the workbook-only invariant', () => {
  // The property engine hands over a NET rate. With no other candidate and
  // no loads, the pipeline must reproduce exactly what that engine produced
  // on its own, or Phase 2 would silently reprice every existing risk.
  it('reproduces the engine gross-up when the workbook rate is the only candidate', () => {
    const netPm = 1.0615;
    const out = buildTechnicalPremium({
      candidates: [workbook(netPm)],
      commissionPct: 0.20, marginPct: 0.05, taxPct: 0.005,
      exposureTotal: 500_000_000,
    });
    expect(out.priced).toBe(true);
    expect(out.weights).toEqual({ WORKBOOK_RATE: 1 });
    expect(out.blendedLossCostPm).toBeCloseTo(netPm, 12);
    expect(out.riskLoadPm).toBe(0);
    expect(out.internalExpensePm).toBe(0);
    // 1.0615 / (1 − 0.20 − 0.05 − 0.005) = 1.0615 / 0.745
    expect(out.technicalGrossPm).toBeCloseTo(netPm / 0.745, 12);
    expect(out.premiums.technicalGross).toBeCloseTo((netPm / 0.745) * 500_000, 6);
  });

  it('grosses up once — the denominator is applied a single time', () => {
    const out = buildTechnicalPremium({
      candidates: [workbook(1)], commissionPct: 0.25, brokeragePct: 0.05,
    });
    expect(out.grossUpDenominator).toBeCloseTo(0.70, 12);
    expect(out.technicalGrossPm).toBeCloseTo(1 / 0.70, 12);
  });

  it('falls back to the net rate rather than dividing by zero', () => {
    const out = buildTechnicalPremium({
      candidates: [workbook(1)], commissionPct: 0.6, marginPct: 0.5,
    });
    expect(out.technicalGrossPm).toBeCloseTo(out.technicalNetPm, 12);
    expect(out.warnings.join(' ')).toMatch(/≥ 100%/);
  });
});

describe('buildTechnicalPremium — the blend', () => {
  it('credibility-weights experience against exposure', () => {
    const out = buildTechnicalPremium({
      candidates: [burn(2.0), workbook(1.0)],
      credibility: { k: 8, maxZ: 1 },      // 8 claims → Z = 0.5
    });
    expect(out.credibility.z).toBeCloseTo(0.5, 12);
    expect(out.blendedLossCostPm).toBeCloseTo(1.5, 12);
  });

  it('leans on exposure when the experience is thin', () => {
    const out = buildTechnicalPremium({
      candidates: [burn(4.0, { claimCount: 1 }), workbook(1.0)],
      credibility: { k: 8, maxZ: 0.75 },   // 1 claim → Z = 1/9
    });
    expect(out.credibility.z).toBeCloseTo(1 / 9, 12);
    expect(out.blendedLossCostPm).toBeCloseTo((1 / 9) * 4 + (8 / 9) * 1, 12);
  });

  it('honours a reasoned override of the mechanical weights', () => {
    const out = buildTechnicalPremium({
      candidates: [burn(2.0), workbook(1.0)],
      credibility: { k: 8, maxZ: 1 },
      weightOverride: { weights: { WORKBOOK_RATE: 1 }, reasonCode: 'LARGE_LOSS_DISTORTION' },
    });
    expect(out.weightSource).toBe('OVERRIDE');
    expect(out.weightOverrideReason).toBe('LARGE_LOSS_DISTORTION');
    expect(out.blendedLossCostPm).toBeCloseTo(1.0, 12);
  });

  it('ignores an unreasoned override and warns', () => {
    const out = buildTechnicalPremium({
      candidates: [burn(2.0), workbook(1.0)],
      credibility: { k: 8, maxZ: 1 },
      weightOverride: { weights: { WORKBOOK_RATE: 1 } },
    });
    expect(out.weightSource).toBe('MECHANICAL');
    expect(out.warnings.join(' ')).toMatch(/reason code/);
  });

  it('does not price when nothing produced a rate, and names what failed', () => {
    const out = buildTechnicalPremium({
      candidates: [toCandidate('EXPOSURE_CURVE', { available: false, unavailableReason: 'No curve set loaded.' })],
    });
    expect(out.priced).toBe(false);
    expect(out.reason).toMatch(/No loss-cost method/);
    // The refusal is a to-do list, not a shrug (F51).
    expect(out.reason).toMatch(/Exposure curve: No curve set loaded\./);
  });

  it('keeps override weight off the benchmark (F44)', () => {
    // The stored override path used to bypass the reference invariant that
    // mechanicalWeights enforces: {BENCHMARK: 1} blended at 9.0 with no
    // warning.
    const out = buildTechnicalPremium({
      candidates: [
        workbook(2.0), burn(4.0, { claimCount: 6 }),
        toCandidate('BENCHMARK', { available: true, ratePm: 9 }),
      ],
      credibility: { k: 6, maxZ: 1 },              // 6 claims → Z = 0.5
      weightOverride: { weights: { BENCHMARK: 1 }, reasonCode: 'UNDERWRITER_JUDGEMENT' },
    });
    // Falls back to the mechanical blend: 0.5 × 4 + 0.5 × 2 = 3.
    expect(out.weightSource).toBe('MECHANICAL');
    expect(out.blendedLossCostPm).toBeCloseTo(3.0, 12);
    expect(out.warnings.join(' ')).toMatch(/BENCHMARK/);
  });

  it('falls back to the mechanical blend when an override names only dead methods (F45)', () => {
    // A stored override that names EXPOSURE_CURVE keeps working after the
    // curve set is deactivated — it must not un-price the risk.
    const out = buildTechnicalPremium({
      candidates: [workbook(2.0), burn(4.0, { claimCount: 6 })],
      credibility: { k: 6, maxZ: 1 },
      weightOverride: { weights: { EXPOSURE_CURVE: 1 }, reasonCode: 'DATA_QUALITY' },
    });
    expect(out.priced).toBe(true);
    expect(out.weightSource).toBe('MECHANICAL');
    expect(out.blendedLossCostPm).toBeCloseTo(3.0, 12);
    expect(out.warnings.join(' ')).toMatch(/EXPOSURE_CURVE/);
  });

  it('prices on the additive sections alone when nothing blends, and says so (F51)', () => {
    // Hull table empty, war table loaded: the war section produced a real
    // rate and the placement must not be refused with that rate silently
    // dropped.
    const out = buildTechnicalPremium({
      candidates: [
        toCandidate('HULL_RATE', { available: false, unavailableReason: 'No hull rate loaded.' }),
        toCandidate('WAR_SECTION', { available: true, ratePm: 0.75, lossCost: 22_500 }),
      ],
      exposureTotal: 30_000_000,
    });
    expect(out.priced).toBe(true);
    expect(out.blendedLossCostPm).toBe(0);
    // 22,500 over 30m expressed per mille = 0.75.
    expect(out.additiveLoadPm).toBeCloseTo(0.75, 12);
    expect(out.expectedLossPm).toBeCloseTo(0.75, 12);
    expect(out.premiums.expectedLoss).toBeCloseTo(22_500, 6);
    expect(out.warnings.join(' ')).toMatch(/separately-rated section/i);
    expect(out.warnings.join(' ')).toMatch(/War & strikes/);
    expect(out.warnings.join(' ')).toMatch(/main cover is NOT priced/i);
  });

  it('still refuses when neither the blend nor any additive section priced', () => {
    const out = buildTechnicalPremium({
      candidates: [
        toCandidate('HULL_RATE', { available: false, unavailableReason: 'No hull rate loaded.' }),
        toCandidate('WAR_SECTION', { available: false, unavailableReason: 'No war rate loaded.' }),
      ],
      exposureTotal: 30_000_000,
    });
    expect(out.priced).toBe(false);
    expect(out.reason).toMatch(/Hull rate: No hull rate loaded\./);
  });

  it('shows a benchmark without letting it move the price', () => {
    const withBenchmark = buildTechnicalPremium({
      candidates: [workbook(1.0), toCandidate('BENCHMARK', { available: true, ratePm: 9 })],
    });
    expect(withBenchmark.blendedLossCostPm).toBeCloseTo(1.0, 12);
    expect(withBenchmark.weights.BENCHMARK).toBeUndefined();
    expect(withBenchmark.candidates.some((c) => c.code === 'BENCHMARK')).toBe(true);
  });
});

describe('buildTechnicalPremium — loads', () => {
  it('adds the cat load after the blend, never inside it', () => {
    const out = buildTechnicalPremium({ candidates: [workbook(1.0)], catLoadPm: 0.25 });
    expect(out.blendedLossCostPm).toBeCloseTo(1.0, 12);
    expect(out.expectedLossPm).toBeCloseTo(1.25, 12);
  });

  it('loads on measured dispersion when the experience gives three or more years', () => {
    const out = buildTechnicalPremium({
      candidates: [burn(1.0, {
        diagnostics: {
          average_exposure: 100_000_000,
          annual_layer_losses: [
            { year: 2022, layer_loss: 0 }, { year: 2023, layer_loss: 0 },
            { year: 2024, layer_loss: 300_000 }, { year: 2025, layer_loss: 100_000 },
          ],
        },
      })],
      riskLoadTheta: 0.10,
    });
    expect(out.riskLoadBasis.kind).toBe('THETA_SIGMA');
    // annual layer losses 0 / 0 / 300k / 100k → mean 100k, σ = √(2e10) ≈ 141,421
    expect(out.riskLoadPm).toBeCloseTo((0.10 * Math.sqrt(2e10)) / 100_000_000 * 1000, 9);
  });

  it('falls back to a percentage load when dispersion cannot be measured, and says so', () => {
    const out = buildTechnicalPremium({
      candidates: [workbook(1.0)], riskLoadPct: 0.08,
    });
    expect(out.riskLoadBasis.kind).toBe('PERCENTAGE');
    expect(out.riskLoadPm).toBeCloseTo(0.08, 12);
    expect(out.warnings.join(' ')).toMatch(/fewer than three years/);
  });

  it('stacks expected loss, risk load and expense into the technical net', () => {
    const out = buildTechnicalPremium({
      candidates: [workbook(1.0)], catLoadPm: 0.5, riskLoadPct: 0.10, internalExpensePct: 0.02,
    });
    expect(out.expectedLossPm).toBeCloseTo(1.5, 12);
    expect(out.riskLoadPm).toBeCloseTo(0.15, 12);
    expect(out.internalExpensePm).toBeCloseTo(0.03, 12);
    expect(out.technicalNetPm).toBeCloseTo(1.68, 12);
  });
});

describe('technicalAdequacy', () => {
  it('is quoted over technical', () => {
    expect(technicalAdequacy(1.12, 1.0)).toBeCloseTo(1.12, 12);
  });
  it('is null when either side is missing or the technical rate is nil', () => {
    expect(technicalAdequacy(null, 1)).toBeNull();
    expect(technicalAdequacy(1, 0)).toBeNull();
  });
});
