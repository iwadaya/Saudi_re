// server/src/validation/nonProp.test.js
// Schema tests for the Non-Proportional treaty validation layer.
// Adds coverage as new endpoints are wired up — currently focused on
// the Stop Loss / Aggregate XL pricing schema.

import { describe, it, expect } from 'vitest';
import { stopLossPricingPutSchema } from './nonProp.js';

describe('stopLossPricingPutSchema', () => {
  it('accepts the full screen-state payload sent by NpStopLossPricing', () => {
    const payload = {
      inputs: {
        attachmentBasis: 'absolute',
        attachment: '10000000',
        limit: '5000000',
        epi: '',
        yearlyAggregates: [
          { year: 2020, aggregate: '11000000' },
          { year: 2021, aggregate: '18000000' },
        ],
        freqLambda: '20',
        severityType: 'lognormal',
        sevMean: '200000',
        sevCv: '0.6',
        weightBurningCost: '50',
        weightExposureRating: '50',
        weightMonteCarlo: '0',
        loading: '20',
        useMonteCarlo: false,
        mcTrials: '10000',
        mcSeed: '1',
      },
      outputs: {
        attachment: 10_000_000,
        limit: 5_000_000,
        blended: { annualLoss: 1_700_000, rol: 0.34, totalRate: 0.425 },
      },
    };
    const out = stopLossPricingPutSchema.parse(payload);
    expect(out.inputs.attachmentBasis).toBe('absolute');
    expect(out.outputs.blended.rol).toBeCloseTo(0.34);
  });

  it('accepts empty inputs and null outputs (initial save before any edit)', () => {
    const out = stopLossPricingPutSchema.parse({ inputs: {}, outputs: null });
    expect(out.inputs).toEqual({});
    expect(out.outputs).toBeNull();
  });

  it('defaults missing inputs to {} so legacy / partial bodies still parse', () => {
    const out = stopLossPricingPutSchema.parse({});
    expect(out.inputs).toEqual({});
  });

  it('passthrough preserves forward-compatible fields the engine adds later', () => {
    const payload = {
      inputs: { someFutureKnob: 'lognormal-mixture' },
      outputs: { newField: { deeper: 42 } },
      meta: { schemaVersion: 7 },
    };
    const out = stopLossPricingPutSchema.parse(payload);
    expect(out.inputs.someFutureKnob).toBe('lognormal-mixture');
    expect(out.outputs.newField.deeper).toBe(42);
    // Top-level passthrough also keeps `meta`.
    expect(out.meta?.schemaVersion).toBe(7);
  });

  it('rejects non-object inputs (typed string, array)', () => {
    expect(() => stopLossPricingPutSchema.parse({ inputs: 'foo' })).toThrow();
    expect(() => stopLossPricingPutSchema.parse({ inputs: [] })).toThrow();
  });
});
