// quoteEngineReconciliation.test.js
//
// The quote pricing-analysis component cells (pure burn / Pareto / exposure
// ROL%) are MODEL values from the SAME calcLayerPricing the NP assessment /
// loss-selection screens use. This pins the reconciliation:
//   • calcLayerPricing's per-layer output for a sample layer maps, via
//     mergeQuoteEngineResult, onto the layer fields the quote screen displays —
//     layer-for-layer within rounding;
//   • all three components render as ROL% strings (end with "%", none raw);
//   • an underwriter override (marked manual) survives a recompute;
//   • the normalizer drops a clearly-non-ROL component value (> 100%).

import { describe, it, expect } from 'vitest';
import { calcLayerPricing } from '../../../utils/npPricingEngine';
import { toN, fmtPct } from './formatters.js';
import { mergeQuoteEngineResult, normalizeQuotePricingLayer, updateQuotePricingLayer } from './fqQuoteMath.js';

// Five selected large losses + a saved Pareto fit + one risk band — enough for
// the engine to return non-zero pure burn, Pareto and exposure ROLs.
const LARGE = [
  { uw_year: 2018, incurred: 1_500_000, is_selected: true },
  { uw_year: 2019, incurred: 2_000_000, is_selected: true },
  { uw_year: 2020, incurred: 1_200_000, is_selected: true },
  { uw_year: 2021, incurred: 3_000_000, is_selected: true },
  { uw_year: 2022, incurred: 1_800_000, is_selected: true },
];

const mockApi = {
  getLargeLosses: async () => ({ losses: LARGE }),
  getCatLosses: async () => ({ losses: [] }),
  getLossSelectionLatest: async (_id, type) => (type === 'large'
    ? { snapshot: { pareto_alpha: 1.6, pareto_xm: 1_000_000, observation_years: 10, selected_count: 5, threshold: 1_000_000 } }
    : { snapshot: null }),
  getCrestaData: async () => [],
  getNpEgnpiYear: async () => [],
  listClassOfBusiness: async () => [],
  getRiskProfile: async () => ({
    profile: { pml_percentage: 100, selected_curve: 'Y3', gross_loss_ratio: 100 },
    bands: [{ from_amt: 0, to_amt: 10_000_000, no_of_risks: 10, total_sum_insured: 50_000_000 }],
  }),
  getContractCobs: async () => [],
};

const sampleLayer = () => ({
  risk: true, cat: false,
  deductible: 500_000, limit: 100_000_000, egnpi: 50_000_000,
  classOfBusinessIds: ['cob-1'],
});

describe('quote ↔ engine reconciliation', () => {
  it('maps calcLayerPricing output onto the displayed component cells (within rounding) and renders all three with %', async () => {
    const results = await calcLayerPricing(mockApi, 'c1', [sampleLayer()], { estGnpi: 50_000_000 }, 'RISK', true);
    const engine = results[0].risk;

    // The engine returns ROL% strings for all three methods.
    for (const v of [engine.pureBurn, engine.pareto, engine.exposureRating]) {
      expect(v).toMatch(/%$/);
      expect(toN(v)).toBeGreaterThan(0);
    }

    // The quote screen seeds its cells from exactly this output.
    const merged = mergeQuoteEngineResult(sampleLayer(), results[0]);
    expect(toN(merged.riskPureBurn)).toBeCloseTo(toN(engine.pureBurn), 2);
    expect(toN(merged.riskPareto)).toBeCloseTo(toN(engine.pareto), 2);
    expect(toN(merged.riskExposure)).toBeCloseTo(toN(engine.exposureRating), 2);

    // What the cell DISPLAYS is a ROL% (ends with "%"), not a raw number — i.e.
    // the seeded value is the engine's ROL, formatted with "%".
    for (const field of ['riskPureBurn', 'riskPareto', 'riskExposure']) {
      expect(fmtPct(toN(merged[field]))).toMatch(/%$/);
      expect(toN(merged[field])).toBeGreaterThan(0);
    }
  });

  it('an underwriter override (marked manual) survives a recompute', async () => {
    const results = await calcLayerPricing(mockApi, 'c1', [sampleLayer()], { estGnpi: 50_000_000 }, 'RISK', true);
    // Underwriter hand-edits the Pareto cell → flagged manual.
    const edited = updateQuotePricingLayer(sampleLayer(), 'riskPareto', '3.28');
    expect(edited.riskParetoManual).toBe(true);
    // Recompute must NOT clobber the override, but DOES seed the others.
    const merged = mergeQuoteEngineResult(edited, results[0]);
    expect(toN(merged.riskPareto)).toBeCloseTo(3.28, 4);
    expect(toN(merged.riskPureBurn)).toBeCloseTo(toN(results[0].risk.pureBurn), 2);
  });

  it('the normalizer drops a clearly-non-ROL component value (> 100%) so it is recomputed, not rendered raw', () => {
    const norm = normalizeQuotePricingLayer({ risk: true, cat: false, limit: '10000000', attachment: '500000', riskPareto: '150', riskPureBurn: '4.2' });
    expect(toN(norm.riskPareto)).toBeLessThanOrEqual(100); // the raw 150% is gone (dropped → recomputed)
    expect(toN(norm.riskPareto)).not.toBe(150);
    expect(toN(norm.riskPureBurn)).toBeCloseTo(4.2, 4);    // a sane ROL is kept
  });
});
