import { describe, it, expect } from 'vitest';
import {
  credibilityFactor, mechanicalWeights, applyWeightOverride, blendRates,
  annualLossVolatility, OVERRIDE_REASONS, DEFAULT_CREDIBILITY,
} from './credibility.js';

const exposureC = (code, ratePm) => ({ code, role: 'EXPOSURE', available: true, ratePm });
const experienceC = (code, ratePm) => ({ code, role: 'EXPERIENCE', available: true, ratePm });

describe('credibilityFactor — Bühlmann–Straub Z = n/(n+k)', () => {
  it('gives half weight at n = k', () => {
    expect(credibilityFactor(8, { k: 8, maxZ: 1 }).z).toBeCloseTo(0.5, 12);
  });

  it('rises with volume and never reaches 1', () => {
    const a = credibilityFactor(2, { k: 8, maxZ: 1 }).z;
    const b = credibilityFactor(20, { k: 8, maxZ: 1 }).z;
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
  });

  it('is zero with no experience', () => {
    expect(credibilityFactor(0, { k: 8 }).z).toBe(0);
  });

  it('honours the family cap and says it capped', () => {
    // Excess casualty: however many claims, layer experience is thin.
    const out = credibilityFactor(1000, { k: 8, maxZ: 0.6 });
    expect(out.z).toBe(0.6);
    expect(out.capped).toBe(true);
  });

  it('defaults to half weight at 8 claims, capped at 75%', () => {
    expect(DEFAULT_CREDIBILITY).toMatchObject({ k: 8, maxZ: 0.75 });
    expect(credibilityFactor(8).z).toBeCloseTo(0.5, 12);
    expect(credibilityFactor(1e6).z).toBe(0.75);
  });
});

describe('mechanicalWeights', () => {
  it('splits Z to experience and the complement across the exposure methods', () => {
    const out = mechanicalWeights(
      [experienceC('BURNING_COST', 1), exposureC('WORKBOOK_RATE', 2), exposureC('EXPOSURE_CURVE', 3)],
      { k: 8, maxZ: 1 }, 8,
    );
    expect(out.z).toBeCloseTo(0.5, 12);
    expect(out.weights.BURNING_COST).toBeCloseTo(0.5, 12);
    expect(out.weights.WORKBOOK_RATE).toBeCloseTo(0.25, 12);
    expect(out.weights.EXPOSURE_CURVE).toBeCloseTo(0.25, 12);
  });

  it('gives exposure the whole weight when there is no experience', () => {
    const out = mechanicalWeights([exposureC('WORKBOOK_RATE', 2)], {}, 0);
    expect(out.weights.WORKBOOK_RATE).toBe(1);
    expect(out.z).toBe(0);
  });

  it('lets experience carry the risk when nothing else can, and reports the thin Z', () => {
    const out = mechanicalWeights([experienceC('BURNING_COST', 1)], { k: 8, maxZ: 0.75 }, 1);
    expect(out.weights.BURNING_COST).toBe(1);
    expect(out.z).toBeCloseTo(1 / 9, 12);
    expect(out.detail.reason).toMatch(/no exposure-basis method/i);
  });

  it('leaves an unavailable method out entirely rather than weighting it zero', () => {
    // Averaging in a zero rate would quietly halve the price.
    const out = mechanicalWeights([
      exposureC('WORKBOOK_RATE', 2),
      { code: 'EXPOSURE_CURVE', role: 'EXPOSURE', available: false, ratePm: null },
    ], {}, 0);
    expect(out.weights).toEqual({ WORKBOOK_RATE: 1 });
  });

  it('never weights a REFERENCE method', () => {
    const out = mechanicalWeights([
      exposureC('WORKBOOK_RATE', 2),
      { code: 'BENCHMARK', role: 'REFERENCE', available: true, ratePm: 9 },
    ], {}, 0);
    expect(out.weights.BENCHMARK).toBeUndefined();
  });

  it('reports no weights at all when nothing is usable', () => {
    const out = mechanicalWeights([], {}, 0);
    expect(out.weights).toEqual({});
    expect(out.z).toBeNull();
  });
});

describe('applyWeightOverride', () => {
  const mech = { BURNING_COST: 0.5, WORKBOOK_RATE: 0.5 };

  it('passes the mechanical weights through when there is no override', () => {
    expect(applyWeightOverride(mech, null)).toEqual({ weights: mech, source: 'MECHANICAL' });
  });

  it('refuses an override with no reason code — that is the control', () => {
    const out = applyWeightOverride(mech, { weights: { BURNING_COST: 1 } });
    expect(out.source).toBe('MECHANICAL');
    expect(out.weights).toEqual(mech);
    expect(out.error).toMatch(/reason code/);
  });

  it('refuses a reason code that is not on the approved list', () => {
    const out = applyWeightOverride(mech, { weights: { BURNING_COST: 1 }, reasonCode: 'BECAUSE' });
    expect(out.source).toBe('MECHANICAL');
    expect(out.error).toMatch(/approved list/);
  });

  it('accepts an override with a recognised reason and normalises to 1', () => {
    const out = applyWeightOverride(mech, {
      weights: { BURNING_COST: 3, WORKBOOK_RATE: 1 },
      reasonCode: 'LARGE_LOSS_DISTORTION',
    });
    expect(out.source).toBe('OVERRIDE');
    expect(out.reasonCode).toBe('LARGE_LOSS_DISTORTION');
    expect(out.weights.BURNING_COST).toBeCloseTo(0.75, 12);
    expect(out.weights.WORKBOOK_RATE).toBeCloseTo(0.25, 12);
  });

  it('publishes the approved reasons so the UI cannot invent its own', () => {
    expect(Object.keys(OVERRIDE_REASONS).length).toBeGreaterThan(3);
    expect(OVERRIDE_REASONS.DATA_QUALITY).toMatch(/unreliable/);
  });
});

describe('blendRates', () => {
  it('is a weighted average', () => {
    const rate = blendRates(
      [{ code: 'A', ratePm: 1 }, { code: 'B', ratePm: 3 }],
      { A: 0.25, B: 0.75 },
    );
    expect(rate).toBeCloseTo(2.5, 12);
  });

  it('renormalises over the weights it can actually use', () => {
    const rate = blendRates(
      [{ code: 'A', ratePm: 1 }, { code: 'B', ratePm: null }],
      { A: 0.5, B: 0.5 },
    );
    expect(rate).toBe(1);
  });

  it('is null when nothing carries weight', () => {
    expect(blendRates([{ code: 'A', ratePm: 1 }], {})).toBeNull();
  });
});

describe('annualLossVolatility', () => {
  it('is the sample standard deviation of the annual layer loss', () => {
    const out = annualLossVolatility([
      { layer_loss: 0 }, { layer_loss: 0 }, { layer_loss: 300 }, { layer_loss: 100 },
    ]);
    expect(out.years).toBe(4);
    expect(out.mean).toBeCloseTo(100, 12);
    // variance = ((100²)+(100²)+(200²)+0)/3 = 20000 → σ ≈ 141.42
    expect(out.sigma).toBeCloseTo(Math.sqrt(20000), 9);
  });

  it('declines to measure dispersion from fewer than three years', () => {
    expect(annualLossVolatility([{ layer_loss: 1 }, { layer_loss: 2 }])).toBeNull();
    expect(annualLossVolatility([])).toBeNull();
  });
});
