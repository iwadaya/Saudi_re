// Unit tests for computeFacPricing's engine-input wiring.
//
// Regression focus (F76): fac_risk stores brokerage_pct / taxes_pct (whole
// percent 0-100, captured on the Coverage Structure screen) and the shared
// gross-up divides by 1 - comm - brok - tax - margin — but the inputs bag
// never carried them, so the technical gross rate omitted brokerage and
// taxes on all brokered business. They must now arrive in the engine's
// units (fractions).
//
// Regression focus (F109): the loads bag used to read pick('risk_load_pct'),
// but no fac_pricing column holds a percentage risk load (the SELECT fetches
// risk_load_pm, an engine OUTPUT) and the client only posts risk_load_pm —
// so the pick was dead wiring that doubled as an unpersisted body override.
// riskLoadPct is now an explicit 0.
//
// The DB pool and the shared engine entry point are mocked; the premium
// effect of the gross-up itself is pinned in shared/fac/pipeline.test.js and
// in tests/integration/facBrokerageTaxGrossUp.integration.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pool } from '../db/pool.js';
import { priceFacRiskFull } from '../../../shared/fac/index.js';
import { computeFacPricing } from './facPricingService.js';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../../../shared/fac/index.js', () => ({
  priceFacRiskFull: vi.fn(() => ({ ok: true, result: {}, family: 'SCHEDULE_PROPERTY' })),
  buildExposureProfile: vi.fn(() => ({})),
}));

function mockDb({ risk, pricing = [] }) {
  pool.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM public.fac_risk r')) return { rows: [risk] };
    if (sql.includes('FROM public.fac_pricing WHERE')) return { rows: pricing };
    return { rows: [] };
  });
}

const baseRisk = {
  fac_risk_id: 'R1',
  occupancy_code: null,
  risk_country_zone: null,
  cedant_region: null,
  rating_family: null,
  inception_date: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeFacPricing — brokerage / taxes reach the engine (F76)', () => {
  it('converts fac_risk whole-percent brokerage_pct / taxes_pct to engine fractions', async () => {
    // Stored as whole percent (numeric strings, as pg returns them):
    // 5% brokerage, 2% taxes → engine fractions 0.05 / 0.02, completing the
    // audit's worked denominator 1 - 0.25 - 0.05 - 0.05 - 0.02 = 0.63.
    mockDb({ risk: { ...baseRisk, brokerage_pct: '5', taxes_pct: '2' } });

    await computeFacPricing('R1', { commission_pct: 0.25, margin_pct: 0.05 });

    expect(priceFacRiskFull).toHaveBeenCalledOnce();
    const args = priceFacRiskFull.mock.calls[0][0];
    expect(args.inputs.brokerage_pct).toBeCloseTo(0.05, 12);
    expect(args.inputs.tax_pct).toBeCloseTo(0.02, 12);
    // The fraction-scaled commission passes through untouched.
    expect(args.inputs.commission_pct).toBe(0.25);
  });

  it('passes null (engine default 0) when the risk carries no brokerage or taxes', async () => {
    mockDb({ risk: { ...baseRisk, brokerage_pct: null, taxes_pct: null } });

    await computeFacPricing('R1');

    const args = priceFacRiskFull.mock.calls[0][0];
    expect(args.inputs.brokerage_pct).toBeNull();
    expect(args.inputs.tax_pct).toBeNull();
  });
});

describe('computeFacPricing — loads bag (F109)', () => {
  it('riskLoadPct is an explicit 0 — never read from a nonexistent column or a posted body', async () => {
    mockDb({
      risk: { ...baseRisk },
      // A stored pricing row carrying risk_load_pm (the OUTPUT column the
      // SELECT actually fetches) — it must NOT leak into riskLoadPct.
      pricing: [{ cat_load_pm: '0.5', risk_load_pm: '1.25', internal_expense_pct: '0.02' }],
    });

    // Even a caller that posts risk_load_pct (nothing in the repo does) must
    // not be able to inject an unpersisted percentage risk load.
    await computeFacPricing('R1', { risk_load_pct: 0.4 });

    const args = priceFacRiskFull.mock.calls[0][0];
    expect(args.loads.riskLoadPct).toBe(0);
    // The neighbours still wire through from the stored row.
    expect(args.loads.catLoadPm).toBeCloseTo(0.5, 12);
    expect(args.loads.internalExpensePct).toBeCloseTo(0.02, 12);
  });
});
