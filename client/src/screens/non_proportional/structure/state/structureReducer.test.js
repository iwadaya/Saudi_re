// Regression tests for the layer-1 deductible cascade (structureReducer.ts).
//
// Layer 1's deductible is derived from the treaty-detail deductible, but that
// slice is only hydrated once the user visits Treaty Detail in the session. A
// session that opens Structure directly used to feed the cascade base '0' — a
// TRUTHY string — which overwrote the saved attachment on the first layer edit,
// and the next save persisted the loss (audit finding F2).
import { describe, it, expect } from 'vitest';
import { recomputeDeductibles, fullRecalc, structureReducer } from './structureReducer.ts';

const layer = (over = {}) => ({
  layer: 1, limit: '1000000', deductible: '500000', annualAggLimit: '', egnpi: '10000000',
  earnedPremium: '', rol: '', rate: '5', mdp: '', mdpPct: '', reinstatements: '',
  reinstatementPct: '', aad: false, aadAmount: '', riskCover: true, catCover: true,
  classOfBusinessIds: [], ...over,
});

describe('recomputeDeductibles — base from treaty detail', () => {
  it("keeps the loaded layer-1 attachment when the base is '0' (unhydrated detail slice)", () => {
    const out = recomputeDeductibles([layer()], '0');
    expect(out[0].deductible).toBe('500000');
  });

  it('keeps the loaded layer-1 attachment when the base is empty', () => {
    const out = recomputeDeductibles([layer()], '');
    expect(out[0].deductible).toBe('500000');
  });

  it('applies a real base over the loaded value (detail edit wins)', () => {
    const out = recomputeDeductibles([layer()], '600000');
    expect(out[0].deductible).toBe('600000');
  });

  it('cascades subsequent layers from the updated layer 1', () => {
    const out = recomputeDeductibles(
      [layer(), layer({ layer: 2, limit: '2000000', deductible: '' })],
      '600000',
    );
    expect(out[0].deductible).toBe('600000');
    expect(out[1].deductible).toBe('1600000'); // 600k base + 1m layer-1 limit
  });
});

describe('layer edits in an unhydrated session', () => {
  it('editing the limit no longer resets the saved deductible to 0', () => {
    const state = { layers: [layer()], cobRows: [], cobOptions: [], coveredProps: [] };
    const next = structureReducer(state, {
      type: 'layer/fieldEdited', idx: 0, field: 'limit', value: '2000000', baseDeductible: '',
    });
    expect(next.layers[0].limit).toBe('2000000');
    expect(next.layers[0].deductible).toBe('500000');
  });

  it('fullRecalc with an empty base still recomputes financials against the kept attachment', () => {
    const out = fullRecalc([layer()], '');
    expect(out[0].deductible).toBe('500000');
    expect(out[0].earnedPremium).toBe('500000'); // 10m × 5%
  });
});
