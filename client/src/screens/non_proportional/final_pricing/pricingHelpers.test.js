// Tests for pricingHelpers — the pure math pulled out of the main
// screen. Guards against silent drift when someone "simplifies" a
// formula in either file.

import { describe, it, expect } from 'vitest';
import { computeLineAnalysis, calcTechRatio } from './pricingHelpers.js';

describe('computeLineAnalysis', () => {
  const layers = [
    { layer: 'L1', limit: 1_000_000, deductible: 500_000, reinsurerPricing: 5, riskCover: true, catCover: false },
    { layer: 'L2', limit: 2_000_000, attachment:  1_500_000, leadPricing:     3, riskCover: false, catCover: true },
  ];

  it('returns one row per input layer', () => {
    const out = computeLineAnalysis(layers, {}, {});
    expect(out).toHaveLength(2);
  });

  it('writes zero cash figures when the written % is absent', () => {
    const [row] = computeLineAnalysis([layers[0]], {}, {});
    expect(row.linePrem).toBe(0);
    expect(row.lineLimit).toBe(0);
  });

  it('computes line premium + line limit from the written %', () => {
    // ep100 = 1m * 5 / 100 = 50k. With 25% written: linePrem = 12.5k, lineLimit = 250k.
    const [row] = computeLineAnalysis([layers[0]], { 0: '25%' }, {});
    expect(row.ep100).toBe(50_000);
    expect(row.wlFrac).toBeCloseTo(0.25, 4);
    expect(row.linePrem).toBe(12_500);
    expect(row.lineLimit).toBe(250_000);
  });

  it('falls back to leadPricing when reinsurerPricing is 0', () => {
    // layers[1] only has leadPricing=3 → ep100 = 2m * 3/100 = 60k
    const [row] = computeLineAnalysis([layers[1]], {}, {});
    expect(row.ep100).toBe(60_000);
  });

  it('attachment field is read when deductible missing', () => {
    const [row] = computeLineAnalysis([layers[1]], {}, {});
    expect(row.attach).toBe(1_500_000);
  });

  it('classifies peril from risk/cat flags', () => {
    const both = computeLineAnalysis([{ limit: 1, riskCover: true,  catCover: true }], {}, {})[0];
    const risk = computeLineAnalysis([{ limit: 1, riskCover: true,  catCover: false }], {}, {})[0];
    const cat  = computeLineAnalysis([{ limit: 1, riskCover: false, catCover: true }], {}, {})[0];
    const none = computeLineAnalysis([{ limit: 1 }], {}, {})[0];
    expect(both.peril).toBe('BOTH');
    expect(risk.peril).toBe('RISK');
    expect(cat.peril).toBe('CAT');
    expect(none.peril).toBe('—');
  });

  it('tolerates a signed % written with or without a percent sign', () => {
    const [row] = computeLineAnalysis([layers[0]], {}, { 0: '10' });
    expect(row.slFrac).toBeCloseTo(0.1, 4);
    expect(row.sLinePrem).toBe(5_000);
  });

  it('defaults layer label to "L<n>" when the layer lacks one', () => {
    const [row] = computeLineAnalysis([{ limit: 1 }], {}, {});
    expect(row.layer).toBe('L1');
  });

  describe('ep100Warning', () => {
    it('is false when rolPct + limit produce a positive ep100', () => {
      const [row] = computeLineAnalysis([layers[0]], {}, {});
      expect(row.ep100).toBeGreaterThan(0);
      expect(row.ep100Warning).toBe(false);
    });

    it('is false when rolPct is missing but earnedPremium is present', () => {
      const [row] = computeLineAnalysis(
        [{ limit: 1_000_000, earnedPremium: 75_000 }],
        {}, {}
      );
      expect(row.ep100).toBe(75_000);
      expect(row.ep100Warning).toBe(false);
    });

    it('is true when both rolPct and earnedPremium are missing → ep100 = 0', () => {
      const [row] = computeLineAnalysis(
        [{ limit: 1_000_000 }],   // no pricing %, no earned premium
        {}, {}
      );
      expect(row.ep100).toBe(0);
      expect(row.ep100Warning).toBe(true);
    });

    it('is also true when limit is missing (rolPct path needs both)', () => {
      const [row] = computeLineAnalysis(
        [{ reinsurerPricing: 5 }],   // no limit, no earned premium
        {}, {}
      );
      expect(row.ep100).toBe(0);
      expect(row.ep100Warning).toBe(true);
    });
  });
});

describe('calcTechRatio', () => {
  it('returns 100 - histM - brok - taxes', () => {
    expect(calcTechRatio(70, 2.5, 1)).toBe(26.5);
  });
  it('returns 0 when historical margin is missing or zero', () => {
    expect(calcTechRatio(0,    2.5, 1)).toBe(0);
    expect(calcTechRatio(null, 2.5, 1)).toBe(0);
    expect(calcTechRatio('',   2.5, 1)).toBe(0);
  });
  it('treats missing brokerage and taxes as zero', () => {
    expect(calcTechRatio(70, null, undefined)).toBe(30);
  });
  it('handles string inputs that parse to numbers', () => {
    expect(calcTechRatio('70', '2.5', '1')).toBe(26.5);
  });
});
