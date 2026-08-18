import { describe, it, expect } from 'vitest';
import {
  lineSizeBasis, perRiskLineCheck, zoneAccumulationCheck, systemicChecks, capacityCheck,
} from './accumulation.js';
import { getFamily } from './registry.js';

describe('lineSizeBasis', () => {
  it('takes the top location for property, not the schedule total', () => {
    // One fire does not visit every warehouse.
    const r = lineSizeBasis({
      family: getFamily('SCHEDULE_PROPERTY'),
      exposure: { total_si: 500_000_000, top_location_si: 120_000_000 },
      sections: [],
    });
    expect(r).toEqual({ amount: 120_000_000, basis: 'TOP_LOCATION_SI' });
  });

  it('falls back to the total when there is no location schedule', () => {
    const r = lineSizeBasis({
      family: getFamily('SCHEDULE_PROPERTY'),
      exposure: { total_si: 500_000_000, top_location_si: null },
      sections: [],
    });
    expect(r.basis).toBe('TOTAL_SI');
  });

  it('takes the limit for casualty, which has no value at all', () => {
    const r = lineSizeBasis({
      family: getFamily('LIABILITY_LIMIT'),
      exposure: {},
      sections: [{ limit_amount: 10_000_000 }, { limit_amount: 5_000_000 }],
    });
    expect(r).toEqual({ amount: 15_000_000, basis: 'LIMIT' });
  });

  it('takes the any-one-conveyance for cargo, never the turnover', () => {
    // A £200m-a-year shipper on a £5m any-one-vessel limit is a £5m risk.
    const r = lineSizeBasis({
      family: getFamily('TRANSIT_VALUES'),
      exposure: {},
      sections: [{
        exposure_base: 200_000_000,
        exposure_detail: { max_any_one_conveyance: 5_000_000 },
      }],
    });
    expect(r).toEqual({ amount: 5_000_000, basis: 'MAX_ANY_ONE_CONVEYANCE' });
  });

  it('takes the agreed value for hull and the contract value for a project', () => {
    expect(lineSizeBasis({
      family: getFamily('HULL_VALUE'), exposure: {}, sections: [{ sum_insured: 30_000_000 }],
    })).toEqual({ amount: 30_000_000, basis: 'AGREED_VALUE' });
    expect(lineSizeBasis({
      family: getFamily('PROJECT_WORKS'), exposure: {}, sections: [{ sum_insured: 200_000_000 }],
    })).toEqual({ amount: 200_000_000, basis: 'CONTRACT_VALUE' });
  });

  it('takes the one-event limit for a per-unit family', () => {
    const r = lineSizeBasis({
      family: getFamily('PA_BENEFIT'),
      exposure: {},
      sections: [{ exposure_detail: { cat_limit: 20_000_000 } }],
    });
    expect(r).toEqual({ amount: 20_000_000, basis: 'ONE_EVENT_LIMIT' });
  });
});

describe('perRiskLineCheck', () => {
  it('passes a share inside the grade\'s allowance', () => {
    const r = perRiskLineCheck({
      lineSize: 100_000_000, maxCapacityPct: 0.75, writtenShare: 0.50,
    });
    expect(r.status).toBe('PASS');
    expect(r.maxLine).toBe(75_000_000);
    expect(r.headroom).toBe(25_000_000);
  });

  it('breaches a share above it', () => {
    const r = perRiskLineCheck({
      lineSize: 100_000_000, maxCapacityPct: 0.50, writtenShare: 0.80,
    });
    expect(r.status).toBe('BREACH');
    expect(r.message).toMatch(/above the 50.0% the score's grade allows/);
  });

  it('says the score has to complete before it can judge', () => {
    const r = perRiskLineCheck({ lineSize: 100_000_000, maxCapacityPct: null });
    expect(r.status).toBe('NOT_APPLICABLE');
    expect(r.message).toMatch(/score has to complete/i);
  });
});

describe('zoneAccumulationCheck', () => {
  const committed = [
    { committed_si: 400_000_000, committed_pml: 120_000_000 },
    { committed_si: 200_000_000, committed_pml: 60_000_000 },
  ];

  it('adds this risk to what is already committed in the zone', () => {
    const r = zoneAccumulationCheck({
      committed, budget: { budget_pml: 300_000_000 }, thisRisk: 50_000_000, zone: 'KSA-01',
    });
    expect(r.committed).toBe(180_000_000);
    expect(r.wouldBe).toBe(230_000_000);
    expect(r.status).toBe('PASS');
    expect(r.utilisation).toBeCloseTo(230 / 300, 9);
  });

  it('breaches when the zone would go over budget', () => {
    const r = zoneAccumulationCheck({
      committed, budget: { budget_pml: 200_000_000 }, thisRisk: 50_000_000, zone: 'KSA-01',
    });
    expect(r.status).toBe('BREACH');
    expect(r.message).toMatch(/over by 30,000,000/);
  });

  it('neither passes nor fails when no budget is loaded — it says so', () => {
    // This is the whole point: fac_zone_budget ships empty, and inventing a
    // budget would make the gate look like it was working.
    const r = zoneAccumulationCheck({
      committed, budget: null, thisRisk: 50_000_000, zone: 'KSA-01',
    });
    expect(r.status).toBe('NO_BUDGET');
    expect(r.committed).toBe(180_000_000);
    expect(r.message).toMatch(/load one in fac_zone_budget/i);
  });

  it('falls back to sums insured where a PML is not recorded', () => {
    const r = zoneAccumulationCheck({
      committed: [{ committed_si: 400_000_000, committed_pml: null }],
      budget: { budget_si: 1_000_000_000 }, thisRisk: 0, zone: 'KSA-01',
    });
    expect(r.committed).toBe(400_000_000);
    expect(r.status).toBe('PASS');
  });
});

describe('systemicChecks', () => {
  it('hard-gates an untagged cyber risk', () => {
    const checks = systemicChecks({
      family: getFamily('CYBER_LIMIT'),
      sections: [{ exposure_detail: {} }],
    });
    expect(checks[0].status).toBe('BREACH');
    expect(checks[0].message).toMatch(/hard gate, not a warning/i);
  });

  it('reports what the book already carries on a tagged vendor', () => {
    const checks = systemicChecks({
      family: getFamily('CYBER_LIMIT'),
      sections: [{ exposure_detail: { dependencies: ['AWS'] } }],
      systemic: { vendorExposure: [{ vendor_key: 'AWS', committed_limit: 240_000_000, risk_count: 12 }] },
    });
    expect(checks[0].status).toBe('PASS');
    expect(checks[0].message).toMatch(/One outage is one loss across all of them/i);
    expect(checks[0].committedLimit).toBe(240_000_000);
  });

  it('says when a tagged vendor is new to the book', () => {
    const checks = systemicChecks({
      family: getFamily('CYBER_LIMIT'),
      sections: [{ exposure_detail: { dependencies: ['ORACLE_CLOUD'] } }],
      systemic: { vendorExposure: [] },
    });
    expect(checks[0].status).toBe('NOT_APPLICABLE');
    expect(checks[0].message).toMatch(/not yet carried anywhere else/i);
  });

  it('checks the cargo any-one-conveyance', () => {
    const ok = systemicChecks({
      family: getFamily('TRANSIT_VALUES'),
      sections: [{ exposure_detail: { max_any_one_conveyance: 5_000_000 } }],
    });
    expect(ok[0].status).toBe('PASS');
    const missing = systemicChecks({
      family: getFamily('TRANSIT_VALUES'), sections: [{ exposure_detail: {} }],
    });
    expect(missing[0].status).toBe('BREACH');
    expect(missing[0].message).toMatch(/binding exposure on a cargo account/i);
  });

  it('surfaces the book\'s exposure in a war region, whatever the family', () => {
    const checks = systemicChecks({
      family: getFamily('HULL_VALUE'),
      sections: [{ exposure_detail: { war_region: 'RED_SEA' } }],
      systemic: { warRegionExposure: [{ region: 'RED_SEA', committed: 90_000_000 }] },
    });
    expect(checks[0].level).toBe('SYSTEMIC_WAR_REGION');
    expect(checks[0].message).toMatch(/close on days, not quarters/i);
  });

  it('checks the PA one-event group', () => {
    const checks = systemicChecks({
      family: getFamily('PA_BENEFIT'), sections: [{ exposure_detail: {} }],
    });
    expect(checks.at(-1).status).toBe('BREACH');
    expect(checks.at(-1).message).toMatch(/travels together/i);
  });

  it('has nothing systemic to say about an ordinary property risk', () => {
    expect(systemicChecks({
      family: getFamily('SCHEDULE_PROPERTY'), sections: [{ exposure_detail: {} }],
    })).toEqual([]);
  });
});

describe('capacityCheck', () => {
  const family = getFamily('SCHEDULE_PROPERTY');

  it('passes when every level passes', () => {
    const out = capacityCheck({
      family,
      sections: [{ exposure_detail: {} }],
      perRiskLine: { lineSize: 100_000_000, maxCapacityPct: 0.75, writtenShare: 0.5 },
      zones: [{
        zone: 'KSA-01', committed: [{ committed_pml: 50_000_000 }],
        budget: { budget_pml: 300_000_000 }, thisRisk: 20_000_000,
      }],
    });
    expect(out.status).toBe('PASS');
    expect(out.referral).toBe(false);
  });

  it('refers, rather than refusing, when a level breaches', () => {
    const out = capacityCheck({
      family,
      sections: [{ exposure_detail: {} }],
      perRiskLine: { lineSize: 100_000_000, maxCapacityPct: 0.25, writtenShare: 0.9 },
      zones: [],
    });
    expect(out.status).toBe('BREACH');
    expect(out.referral).toBe(true);
    expect(out.reasons).toHaveLength(1);
  });

  it('reports what it could not measure separately from what failed', () => {
    const out = capacityCheck({
      family,
      sections: [{ exposure_detail: {} }],
      perRiskLine: { lineSize: 100_000_000, maxCapacityPct: 0.75, writtenShare: 0.5 },
      zones: [{
        zone: 'KSA-01', committed: [], budget: null, thisRisk: 20_000_000,
      }],
    });
    expect(out.status).toBe('NO_BUDGET');
    expect(out.referral).toBe(false);
    expect(out.unmeasured).toHaveLength(1);
  });
});
