// fqQuoteMath.paretoTechnicalRol.test.js
//
// Pareto pricing FROM the Monte-Carlo: pure premium = simulated mean ceded loss
// as a ROL% (mean / limit × 100 — the existing component base), plus the
// underwriter risk load (θ·SD, or a multiple of the TVaR excess over the mean).

import { describe, it, expect } from 'vitest';
import { paretoTechnicalRol } from './fqQuoteMath.js';

const aggregate = {
  mean: 300_000,
  sd: 200_000,
  tail: [
    { rp: 2, var: 0, tvar: 100_000 },
    { rp: 10, var: 600_000, tvar: 800_000 },
    { rp: 50, var: 1_100_000, tvar: 1_300_000 },
    { rp: 100, var: 1_300_000, tvar: 1_500_000 },
    { rp: 200, var: 1_600_000, tvar: 1_800_000 },
  ],
};

describe('paretoTechnicalRol', () => {
  it('pure ROL = mean / limit × 100, matching the existing Pareto base', () => {
    const r = paretoTechnicalRol(aggregate, 3_000_000, { method: 'SD', factor: 0 });
    expect(r.purePremium).toBe(300_000);
    expect(r.pureRol).toBeCloseTo(10, 6);    // 300k / 3m
    expect(r.loadedRol).toBeCloseTo(10, 6);  // zero load ⇒ loaded = pure
  });

  it('θ·SD load adds θ × SD before dividing by limit', () => {
    const r = paretoTechnicalRol(aggregate, 3_000_000, { method: 'SD', factor: 0.5 });
    expect(r.riskLoad).toBe(100_000);                 // 0.5 × 200k
    expect(r.loadedRol).toBeCloseTo(13.3333, 3);      // (300k + 100k) / 3m
  });

  it('TVaR-multiple load uses the TVaR excess over the mean', () => {
    const r = paretoTechnicalRol(aggregate, 3_000_000, { method: 'TVAR', factor: 0.2, tvarRp: 100 });
    expect(r.riskLoad).toBeCloseTo(240_000, 6);        // 0.2 × (1.5m − 300k)
    expect(r.loadedRol).toBeCloseTo(18, 6);            // (300k + 240k) / 3m
  });

  it('returns zeros for a non-positive limit', () => {
    expect(paretoTechnicalRol(aggregate, 0, { method: 'SD', factor: 0.5 }).loadedRol).toBe(0);
    expect(paretoTechnicalRol(null, 3_000_000, {}).loadedRol).toBe(0);
  });
});
