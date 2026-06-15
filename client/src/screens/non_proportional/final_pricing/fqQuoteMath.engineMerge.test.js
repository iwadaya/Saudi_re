// fqQuoteMath.engineMerge.test.js
//
// Part 2 of the quote-mode pure-burn / exposure task: CONFIRM that the
// shared engine's per-component results land in the exact layer fields the
// Pricing Analysis modal reads, for BOTH the risk and cat scopes, and that
// the blended Total then derives from them.
//
// mergeQuoteEngineResult is the single hop between the engine
// (calcLayerPricing → { risk, cat } components) and the FQ layer rows. The
// modal renders layer[scope.fields.pureBurn] (riskPureBurn / catPureBurn)
// and layer[scope.fields.exposure] (riskExposure / catExposure) straight
// off the row, so this mapping is load-bearing.

import { describe, it, expect } from 'vitest';
import { toN } from './formatters.js';
import {
  mergeQuoteEngineResult,
  quoteComponentDerived,
  quoteComponentSummary,
  QUOTE_COMPONENT_SCOPES,
  emptyStrLayer,
  normalizeQuotePricingLayer,
} from './fqQuoteMath.js';

// A synthetic engine result shaped exactly like calcLayerPricing's output:
// each component carries formatted ROL strings (pureBurn / pareto /
// exposureRating) plus probability fields.
const syntheticResult = {
  risk: { pureBurn: '2.50%', pareto: '0.00%', exposureRating: '1.20%', prAttach: '10.00%', prExhaust: '2.00%' },
  cat:  { pureBurn: '0.80%', pareto: '0.00%', exposureRating: '0.50%', prAttach: '5.00%',  prExhaust: '1.00%' },
};

describe('mergeQuoteEngineResult — component mapping', () => {
  it('writes component.pureBurn → riskPureBurn/catPureBurn and component.exposureRating → riskExposure/catExposure', () => {
    const layer = { risk: true, cat: true, limit: '1000000', attachment: '500000', egnpi: '50000000' };
    const merged = mergeQuoteEngineResult(layer, syntheticResult);

    // Risk scope
    expect(toN(merged.riskPureBurn)).toBeCloseTo(2.5, 6);
    expect(toN(merged.riskExposure)).toBeCloseTo(1.2, 6);
    expect(toN(merged.riskPrAttach)).toBeCloseTo(10, 6);
    expect(toN(merged.riskPrExhaust)).toBeCloseTo(2, 6);

    // Cat scope
    expect(toN(merged.catPureBurn)).toBeCloseTo(0.8, 6);
    expect(toN(merged.catExposure)).toBeCloseTo(0.5, 6);
    expect(toN(merged.catPrAttach)).toBeCloseTo(5, 6);
    expect(toN(merged.catPrExhaust)).toBeCloseTo(1, 6);
  });

  it('uses the canonical scope field names (no drift between map and merge)', () => {
    const layer = { risk: true, cat: true, limit: '1000000', attachment: '500000', egnpi: '50000000' };
    const merged = mergeQuoteEngineResult(layer, syntheticResult);
    const rf = QUOTE_COMPONENT_SCOPES.risk.fields;
    const cf = QUOTE_COMPONENT_SCOPES.cat.fields;
    expect(toN(merged[rf.pureBurn])).toBeCloseTo(2.5, 6);
    expect(toN(merged[rf.exposure])).toBeCloseTo(1.2, 6);
    expect(toN(merged[cf.pureBurn])).toBeCloseTo(0.8, 6);
    expect(toN(merged[cf.exposure])).toBeCloseTo(0.5, 6);
  });

  it('feeds the per-component Blend/Total via quoteComponentDerived', () => {
    const layer = { risk: true, cat: true, limit: '1000000', attachment: '500000', egnpi: '50000000' };
    const merged = mergeQuoteEngineResult(layer, syntheticResult);
    // Default weights: burn 50 / pareto 0 / exposure 50.
    // Risk blended = 0.5*2.5 + 0.5*1.2 = 1.85 (before loading).
    const riskDerived = quoteComponentDerived(merged, 'risk', { ignoreUw: true });
    expect(riskDerived.pureBurn).toBeCloseTo(2.5, 6);
    expect(riskDerived.exposure).toBeCloseTo(1.2, 6);
    expect(riskDerived.blendedRol).toBeCloseTo(1.85, 4);
    expect(riskDerived.modeledRol).toBeGreaterThan(0);

    // The summary rolls both active scopes into one structure total.
    const summary = quoteComponentSummary(merged);
    expect(summary.activeScopes).toEqual(['risk', 'cat']);
    expect(summary.pureBurn).toBeCloseTo(2.5 + 0.8, 6);   // sum across components
    expect(summary.exposure).toBeCloseTo(1.2 + 0.5, 6);
    expect(summary.totalRol).toBeGreaterThan(0);
  });

  it('only touches the scope whose component is present', () => {
    const layer = { risk: true, cat: true };
    const merged = mergeQuoteEngineResult(layer, { risk: syntheticResult.risk /* no cat */ });
    expect(toN(merged.riskPureBurn)).toBeCloseTo(2.5, 6);
    // Cat fields stay untouched (engine returned no cat component).
    expect(merged.catPureBurn ?? '').toBe('');
    expect(merged.catExposure ?? '').toBe('');
  });
});

describe('per-layer note fields', () => {
  it('emptyStrLayer seeds riskLayerNote / catLayerNote to empty strings', () => {
    const layer = emptyStrLayer(0);
    expect(layer.riskLayerNote).toBe('');
    expect(layer.catLayerNote).toBe('');
  });

  it('normalizeQuotePricingLayer preserves the notes (round-trips through save)', () => {
    const normalized = normalizeQuotePricingLayer(
      { risk: true, cat: true, limit: '1000000', riskLayerNote: 'cap at 2x', catLayerNote: 'wind only' },
      0,
    );
    expect(normalized.riskLayerNote).toBe('cap at 2x');
    expect(normalized.catLayerNote).toBe('wind only');
  });
});
