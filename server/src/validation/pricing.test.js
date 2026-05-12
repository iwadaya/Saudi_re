// server/src/validation/pricing.test.js
// Pins the pricing schemas against both the "correct" wrapped
// shape and the real-world shapes the client has been sending.
// Several of these endpoints pre-date the Zod guard, so the
// schemas have to be permissive about legacy shapes.

import { describe, it, expect } from 'vitest';
import {
  pricingOutputsPutSchema,
  pricingYearlyPutSchema,
  compositePricingSaveSchema,
  straightStatsSaveSchema,
} from './pricing.js';

describe('pricingOutputsPutSchema', () => {
  it('accepts any object', () => {
    expect(() => pricingOutputsPutSchema.parse({ foo: 1, nested: { bar: 'x' } })).not.toThrow();
  });

  it('rejects a bare array (handler needs an object)', () => {
    expect(() => pricingOutputsPutSchema.parse([])).toThrow();
  });
});

describe('pricingYearlyPutSchema', () => {
  it('accepts the wrapped { rows: [...] } shape', () => {
    const out = pricingYearlyPutSchema.parse({ rows: [{ uw_year: 2026, premium: 1000 }] });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].uw_year).toBe(2026);
  });

  it('accepts a bare array — PropProjectedSummary.save() sends this', () => {
    // The real payload from PropProjectedSummary.jsx
    const payload = [
      { uw_year: 2024, record_type: 'ACTUAL',    ultimate_premium: 1000, ultimate_loss: 500, loss_ratio: 0.5 },
      { uw_year: 2024, record_type: 'PROJECTED', ultimate_premium: 1100, ultimate_loss: 550, loss_ratio: 0.5 },
    ];
    const out = pricingYearlyPutSchema.parse(payload);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0].record_type).toBe('ACTUAL');
    expect(out.rows[1].uw_year).toBe(2024);
  });

  it('accepts an empty body → { rows: [] }', () => {
    expect(pricingYearlyPutSchema.parse({}).rows).toEqual([]);
  });

  it('accepts an empty array', () => {
    expect(pricingYearlyPutSchema.parse([]).rows).toEqual([]);
  });
});

describe('compositePricingSaveSchema', () => {
  it('accepts contractId', () => {
    expect(() => compositePricingSaveSchema.parse({
      contractId: '00000000-0000-0000-0000-000000000001',
    })).not.toThrow();
  });

  it('accepts the snake_case contract_id alias', () => {
    expect(() => compositePricingSaveSchema.parse({
      contract_id: '00000000-0000-0000-0000-000000000001',
    })).not.toThrow();
  });

  it('rejects when neither id form is present', () => {
    expect(() => compositePricingSaveSchema.parse({ outputs: {} })).toThrow();
  });

  it('accepts the full PropPricing.save() payload — leads is OBJECT not array', () => {
    // Regression: leads was z.array(...) and rejected PropPricing's
    // `{ lead_reinsurer, expiring_reinsurer, lead_share_pct }` object,
    // which blocked submit-for-approval with "pricing failed to save".
    const payload = {
      contract_id: '00000000-0000-0000-0000-000000000001',
      components: [{ component_name: 'exposure', actuarial_value: 1 }],
      leads: {
        lead_reinsurer: 'acme-id',
        expiring_reinsurer: 'beta-id',
        lead_share_pct: '50',
      },
      share_scenarios: [{ share_label: '50%', foo: 1 }],
      comment: 'ship it',
      outputs: {
        status: 'DRAFT', offer_line: 1, actuarial_margin: 0.15,
      },
    };
    expect(() => compositePricingSaveSchema.parse(payload)).not.toThrow();
  });
});

describe('straightStatsSaveSchema', () => {
  it('accepts the exact shape the client sends', () => {
    const payload = {
      contractId: '00000000-0000-0000-0000-000000000001',
      tailType: 'SHORT_TAIL',
      stats: [
        { underwriting_year: 2024, premium: 100, paid_claims: 30, os_claims: 10 },
      ],
    };
    expect(() => straightStatsSaveSchema.parse(payload)).not.toThrow();
  });

  it('rejects an unknown tailType value (CHECK constraint in DB)', () => {
    expect(() => straightStatsSaveSchema.parse({
      contractId: '00000000-0000-0000-0000-000000000001',
      tailType: 'MEDIUM_TAIL',
      stats: [],
    })).toThrow();
  });
});
