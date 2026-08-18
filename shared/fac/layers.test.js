import { describe, it, expect } from 'vitest';
import {
  rateOnLine, paybackYears, layerPremium, reinstatementPremium,
  totalCover, freeCover, priceTower,
} from './layers.js';

describe('rateOnLine and payback', () => {
  it('is premium over limit, and payback is its reciprocal', () => {
    expect(rateOnLine(250_000, 5_000_000)).toBeCloseTo(0.05, 12);
    expect(paybackYears(0.05)).toBeCloseTo(20, 12);
  });

  it('is null rather than zero when either side is missing', () => {
    expect(rateOnLine(null, 1e6)).toBeNull();
    expect(rateOnLine(1e5, null)).toBeNull();
    expect(rateOnLine(1e5, 0)).toBeNull();
    expect(paybackYears(0)).toBeNull();
  });
});

describe('layerPremium', () => {
  it('grosses the loss cost up once', () => {
    expect(layerPremium(74_500, 0.745)).toBeCloseTo(100_000, 9);
  });
  it('falls back to the loss cost rather than dividing by zero', () => {
    expect(layerPremium(100, 0)).toBe(100);
    expect(layerPremium(100, -0.2)).toBe(100);
  });
});

describe('reinstatementPremium', () => {
  it('is the stated percentage of the layer premium', () => {
    expect(reinstatementPremium({ premium: 100_000, terms: { pct_of_premium: 1 } })).toBe(100_000);
    expect(reinstatementPremium({ premium: 100_000, terms: { pct_of_premium: 0.5 } })).toBe(50_000);
  });

  it('applies pro rata as to amount only when the slip says so', () => {
    const terms = { pct_of_premium: 1, pro_rata_amount: true };
    expect(reinstatementPremium({ premium: 100_000, terms, amountUsed: 0.4 })).toBeCloseTo(40_000, 9);
    // A term that is not stated is not applied.
    expect(reinstatementPremium({
      premium: 100_000, terms: { pct_of_premium: 1 }, amountUsed: 0.4,
    })).toBe(100_000);
  });

  it('applies pro rata as to time only when the slip says so', () => {
    const terms = { pct_of_premium: 1, pro_rata_time: true };
    expect(reinstatementPremium({ premium: 100_000, terms, timeLeft: 0.25 })).toBeCloseTo(25_000, 9);
  });

  it('combines both when both are stated', () => {
    const terms = { pct_of_premium: 1, pro_rata_amount: true, pro_rata_time: true };
    expect(reinstatementPremium({ premium: 100_000, terms, amountUsed: 0.5, timeLeft: 0.5 }))
      .toBeCloseTo(25_000, 9);
  });
});

describe('totalCover', () => {
  it('counts the limit plus each reinstatement', () => {
    expect(totalCover({ limit_amount: 1_000_000, reinstatements: 2 })).toBe(3_000_000);
    expect(totalCover({ limit_amount: 1_000_000, reinstatements: 0 })).toBe(1_000_000);
  });

  it('is capped by an aggregate limit', () => {
    expect(totalCover({ limit_amount: 1_000_000, reinstatements: 5, aggregate_limit: 2_500_000 }))
      .toBe(2_500_000);
  });

  it('is the aggregate when reinstatements are unlimited', () => {
    expect(totalCover({ limit_amount: 1e6, reinstatements: null, aggregate_limit: 4e6 })).toBe(4e6);
    expect(totalCover({ limit_amount: 1e6, reinstatements: null })).toBeNull();
  });

  it('is null for an unlimited top layer', () => {
    expect(totalCover({ limit_amount: null, reinstatements: 1 })).toBeNull();
  });
});

describe('freeCover', () => {
  it('flags a layer sitting above anything the experience reached', () => {
    // Pricing this off a burning cost would produce a confident nil.
    const out = freeCover({ attachment: 5_000_000, limit: 5_000_000, largestAsIfLoss: 2_000_000 });
    expect(out.isFreeCover).toBe(true);
    expect(out.exposedPortion).toBe(0);
  });

  it('reports how much of a partly-exposed layer the experience reaches', () => {
    const out = freeCover({ attachment: 1_000_000, limit: 4_000_000, largestAsIfLoss: 3_000_000 });
    expect(out.isFreeCover).toBe(false);
    expect(out.exposedPortion).toBeCloseTo(0.5, 12);   // 2m of a 4m layer
  });

  it('caps the exposed portion at the whole layer', () => {
    const out = freeCover({ attachment: 0, limit: 1_000_000, largestAsIfLoss: 9_000_000 });
    expect(out.exposedPortion).toBe(1);
  });

  it('declines to judge without any loss history', () => {
    const out = freeCover({ attachment: 1e6, limit: 1e6, largestAsIfLoss: null });
    expect(out.isFreeCover).toBe(false);
    expect(out.exposedPortion).toBeNull();
  });
});

describe('priceTower', () => {
  const layers = [
    { layer_no: 2, attachment: 5_000_000, limit_amount: 5_000_000, our_share_pct: 0.10, reinstatements: 1 },
    { layer_no: 1, attachment: 1_000_000, limit_amount: 4_000_000, our_share_pct: 0.25, reinstatements: 2 },
  ];
  const lossCostFor = (l) => (l.layer_no === 1 ? 200_000 : 50_000);

  it('prices each layer in order and totals the tower', () => {
    const out = priceTower({ layers, lossCostFor, grossUpDenominator: 0.8 });
    expect(out.layers.map((l) => l.layer_no)).toEqual([1, 2]);      // sorted
    expect(out.layers[0].premium).toBeCloseTo(250_000, 9);          // 200k / 0.8
    expect(out.layers[0].rol_pct).toBeCloseTo(250_000 / 4_000_000, 12);
    expect(out.layers[0].payback_years).toBeCloseTo(16, 9);
    expect(out.layers[0].our_premium).toBeCloseTo(62_500, 9);       // × 25%
    expect(out.total.premium).toBeCloseTo(312_500, 9);
    expect(out.total.our_premium).toBeCloseTo(68_750, 9);
    expect(out.total.layer_count).toBe(2);
  });

  it('carries the reinstated cover through', () => {
    const out = priceTower({ layers, lossCostFor, grossUpDenominator: 0.8 });
    expect(out.layers[0].total_cover).toBe(12_000_000);             // 4m × 3
    expect(out.layers[1].total_cover).toBe(10_000_000);             // 5m × 2
  });

  it('marks the layers the experience never reached', () => {
    const out = priceTower({ layers, lossCostFor, grossUpDenominator: 0.8, largestAsIfLoss: 3_000_000 });
    expect(out.layers[0].free_cover).toBe(false);
    expect(out.layers[1].free_cover).toBe(true);
    expect(out.total.free_cover_layers).toBe(1);
  });

  it('survives a layer nothing could price', () => {
    const out = priceTower({ layers, lossCostFor: () => null, grossUpDenominator: 0.8 });
    expect(out.layers[0].premium).toBeNull();
    expect(out.layers[0].rol_pct).toBeNull();
    expect(out.total.premium).toBe(0);
  });
});
