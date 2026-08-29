// server/src/validation/nonProp.test.js
// Schema tests for the Non-Proportional treaty validation layer.
// Adds coverage as new endpoints are wired up — currently focused on
// the Stop Loss / Aggregate XL pricing schema.

import { describe, it, expect } from 'vitest';
import { npSaveSchema, stopLossPricingPutSchema } from './nonProp.js';

describe('npSaveSchema detail bounds', () => {
  it('accepts a realistic detail payload (comma strings included)', () => {
    const out = npSaveSchema.parse({
      detail: {
        number_of_layers: 3,
        deductible: '2,000,000',
        max_retention: 5_000_000,
        accounting_method: 'Losses Occurring',
        xl_type: 'Gross XL',
        accounts: 'Annual',
        brokerage_pct: 10,
        taxes_pct: '0',
        profit_commission_pct: '12.5',
        est_gnpi: '25,000,000',
        experience_start_year: 2019,
      },
    });
    expect(out.detail.deductible).toBe(2_000_000);
    expect(out.detail.brokerage_pct).toBe(10);
    expect(out.detail.profit_commission_pct).toBeCloseTo(12.5);
  });

  it('rejects an out-of-range percent instead of letting numeric(5,2) overflow', () => {
    // Regression: brokerage_pct 1010 (a mangled "10" entry) used to reach
    // Postgres and come back as a raw `numeric field overflow` 500.
    expect(() => npSaveSchema.parse({ detail: { brokerage_pct: 1010 } })).toThrow();
    expect(() => npSaveSchema.parse({ detail: { taxes_pct: 101 } })).toThrow();
    expect(() => npSaveSchema.parse({ detail: { profit_commission_pct: -1 } })).toThrow();
  });

  it('rejects fractional or absurd layer counts destined for an integer column', () => {
    expect(() => npSaveSchema.parse({ detail: { number_of_layers: 4.5 } })).toThrow();
    expect(() => npSaveSchema.parse({ detail: { number_of_layers: 1e12 } })).toThrow();
    expect(npSaveSchema.parse({ detail: { number_of_layers: '4' } }).detail.number_of_layers).toBe(4);
  });

  it('accepts >100% reinstatement terms but rejects numeric(5,2) overflow values', () => {
    const ok = npSaveSchema.parse({ layers: [{ layer_number: 1, reinstatement_pct: 125 }] });
    expect(ok.layers[0].reinstatement_pct).toBe(125);
    expect(() => npSaveSchema.parse({ layers: [{ layer_number: 1, reinstatement_pct: 2000 }] })).toThrow();
  });

  it('still accepts an empty save and omitted detail keys', () => {
    expect(npSaveSchema.parse({})).toEqual({});
    const out = npSaveSchema.parse({ detail: {} });
    expect(out.detail).toEqual({});
  });
});

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
