// server/src/lib/pricingVerifier.test.js
// Direct tests against the verifier's detection surface. We don't
// exercise the HTTP layer here — that's covered by the existing
// integration tests (which will start running with PRICING_STRICT=0
// and therefore log-only). This suite pins the pure logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyNpPricingOutputs, summariseDrifts, isStrictMode, warnIfWarnOnlyInProduction } from './pricingVerifier.js';
import { logger } from './logger.js';
import { deriveComponentTotal } from '../../../shared/pricingMath.js';

function row(overrides = {}) {
  return {
    layer_number: 1,
    section:      'RISK',
    pure_burning_cost:   0.03,
    pareto_pricing:      0.01,
    exposure_rating:     0.05,
    burn_weight_pct:     40,
    pareto_weight_pct:   20,
    exposure_weight_pct: 40,
    pricing_loading_pct: 20,
    // total: blended = (40*0.03 + 20*0.01 + 40*0.05) / 100
    //                = (1.2 + 0.2 + 2.0) / 100 = 0.034
    //        loaded  = 0.034 / (1 - 0.20) = 0.0425
    total_price:         0.0425,
    ...overrides,
  };
}

describe('verifyNpPricingOutputs', () => {
  it('returns no drifts when every row agrees with the canonical formula', () => {
    const drifts = verifyNpPricingOutputs([row(), row({ layer_number: 2, section: 'CAT' })]);
    expect(drifts).toEqual([]);
  });

  it('flags a row whose total_price disagrees beyond tolerance', () => {
    const drifts = verifyNpPricingOutputs([
      row({ total_price: 0.07 }),  // ~65% off from 0.0425
    ]);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      layer_number: 1,
      section:      'RISK',
      field:        'total_price',
      stored:       0.07,
    });
    expect(drifts[0].expected).toBeCloseTo(0.0425, 4);
  });

  it('flags rows whose burn + pareto + exposure weights do not sum to ~100', () => {
    const r = row({ burn_weight_pct: 40, pareto_weight_pct: 10, exposure_weight_pct: 60 });  // sums to 110
    // Recompute total for this bad weight triple so we don't double-flag
    r.total_price = deriveComponentTotal(r.pure_burning_cost, r.pareto_pricing, r.exposure_rating, r.burn_weight_pct, r.pareto_weight_pct, r.exposure_weight_pct, r.pricing_loading_pct);
    const drifts = verifyNpPricingOutputs([r]);
    const weightsDrift = drifts.find((d) => d.field === 'weights_sum');
    expect(weightsDrift).toBeTruthy();
    expect(weightsDrift.stored).toBe(110);
    expect(weightsDrift.expected).toBe(100);
  });

  it('tolerates small rounding drift (within 2 bps / 0.2%)', () => {
    // Stored value off by 0.0001 — below both abs + rel tolerances
    const drifts = verifyNpPricingOutputs([row({ total_price: 0.0425 + 0.0001 })]);
    expect(drifts).toEqual([]);
  });

  it('tolerates integer rounding of weights (e.g. 40 + 20 + 39.9 from user input)', () => {
    const r = row({ burn_weight_pct: 40, pareto_weight_pct: 20, exposure_weight_pct: 39.9 });
    r.total_price = deriveComponentTotal(r.pure_burning_cost, r.pareto_pricing, r.exposure_rating, r.burn_weight_pct, r.pareto_weight_pct, r.exposure_weight_pct, r.pricing_loading_pct);
    const drifts = verifyNpPricingOutputs([r]);
    expect(drifts.filter((d) => d.field === 'weights_sum')).toEqual([]);
  });

  it('handles zero values cleanly (no false positive)', () => {
    const drifts = verifyNpPricingOutputs([row({
      pure_burning_cost: 0, pareto_pricing: 0, exposure_rating: 0, total_price: 0,
    })]);
    expect(drifts).toEqual([]);
  });

  it('returns [] for non-array input', () => {
    expect(verifyNpPricingOutputs(null)).toEqual([]);
    expect(verifyNpPricingOutputs(undefined)).toEqual([]);
    expect(verifyNpPricingOutputs({})).toEqual([]);
    expect(verifyNpPricingOutputs('not-an-array')).toEqual([]);
  });

  it('skips rows that are not plain objects', () => {
    const drifts = verifyNpPricingOutputs([null, undefined, 'not-a-row', row()]);
    expect(drifts).toEqual([]);
  });

  it('copes with 99% loading (rate explodes but no NaN)', () => {
    const r = row({ pricing_loading_pct: 99 });
    r.total_price = deriveComponentTotal(r.pure_burning_cost, r.pareto_pricing, r.exposure_rating, r.burn_weight_pct, r.pareto_weight_pct, r.exposure_weight_pct, r.pricing_loading_pct);
    const drifts = verifyNpPricingOutputs([r]);
    expect(drifts).toEqual([]);
  });
});

describe('summariseDrifts', () => {
  it('returns "none" when empty', () => {
    expect(summariseDrifts([])).toBe('none');
    expect(summariseDrifts(null)).toBe('none');
  });

  it('groups by field for a compact operator log line', () => {
    const out = summariseDrifts([
      { field: 'total_price' },
      { field: 'total_price' },
      { field: 'weights_sum' },
    ]);
    expect(out).toContain('3 drifts');
    expect(out).toContain('2×total_price');
    expect(out).toContain('1×weights_sum');
  });

  it('uses singular for exactly one drift', () => {
    expect(summariseDrifts([{ field: 'total_price' }])).toBe('1 drift (1×total_price)');
  });
});

describe('isStrictMode', () => {
  const original = process.env.PRICING_STRICT;
  beforeEach(() => { delete process.env.PRICING_STRICT; });
  afterEach(() => {
    if (original === undefined) delete process.env.PRICING_STRICT;
    else process.env.PRICING_STRICT = original;
  });

  it('defaults to false', () => {
    expect(isStrictMode()).toBe(false);
  });

  it('accepts "1", "true", "yes" as opt-in', () => {
    process.env.PRICING_STRICT = '1';    expect(isStrictMode()).toBe(true);
    process.env.PRICING_STRICT = 'true'; expect(isStrictMode()).toBe(true);
    process.env.PRICING_STRICT = 'yes';  expect(isStrictMode()).toBe(true);
  });

  it('stays off for any other value', () => {
    process.env.PRICING_STRICT = '0';     expect(isStrictMode()).toBe(false);
    process.env.PRICING_STRICT = 'false'; expect(isStrictMode()).toBe(false);
    process.env.PRICING_STRICT = 'no';    expect(isStrictMode()).toBe(false);
    process.env.PRICING_STRICT = '';      expect(isStrictMode()).toBe(false);
  });
});

describe('warnIfWarnOnlyInProduction', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStrict  = process.env.PRICING_STRICT;
  let warnSpy;

  beforeEach(() => {
    delete process.env.PRICING_STRICT;
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalStrict === undefined) delete process.env.PRICING_STRICT;
    else process.env.PRICING_STRICT = originalStrict;
    warnSpy.mockRestore();
  });

  it('warns when NODE_ENV=production and PRICING_STRICT is not set', () => {
    process.env.NODE_ENV = 'production';
    warnIfWarnOnlyInProduction();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/warn-only/i);
  });

  it('stays quiet when PRICING_STRICT=1 even in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.PRICING_STRICT = '1';
    warnIfWarnOnlyInProduction();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('stays quiet outside production (dev / test)', () => {
    process.env.NODE_ENV = 'development';
    warnIfWarnOnlyInProduction();
    process.env.NODE_ENV = 'test';
    warnIfWarnOnlyInProduction();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
