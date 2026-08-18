import { describe, it, expect } from 'vitest';
import {
  renewalSnapshot, structureChanges, decomposeChange, renewalComparison, STRUCTURE_FIELDS,
} from './renewal.js';

const risk = (o = {}) => ({
  fac_risk_id: 'R-1', bound_reference: 'FAC-2025-00001', uw_year: 2025,
  inception_date: '2025-01-01', status: 'BOUND', total_sum_insured: 100_000_000,
  deductible_amount: 250_000, np_retention: null, np_limit: null,
  our_share_pct: 0.25, ri_share_pct: 1, placement_type: 'PROPORTIONAL',
  policy_period_months: 12, ...o,
});
const pricing = (o = {}) => ({
  final_rate_per_mille: 2.10, technical_gross_rate_pm: 2.00,
  technical_adequacy: 1.05, final_premium: 210_000, ...o,
});

const snap = (r, p, e) => renewalSnapshot(risk(r), pricing(p), e);

describe('renewalSnapshot', () => {
  it('reduces a risk to what a renewal is judged on', () => {
    const s = snap();
    expect(s.reference).toBe('FAC-2025-00001');
    expect(s.premium_base).toBe(100_000_000);
    expect(s.rate_pm).toBe(2.10);
    expect(s.technical_adequacy).toBe(1.05);
  });

  it('prefers the exposure profile over the risk header total', () => {
    expect(snap({}, {}, { total_si: 140_000_000 }).premium_base).toBe(140_000_000);
  });

  it('is null for a risk that is not there', () => {
    expect(renewalSnapshot(null, null, null)).toBeNull();
  });
});

describe('structureChanges', () => {
  it('reports only what actually moved', () => {
    const a = snap();
    const b = snap({ deductible_amount: 500_000, our_share_pct: 0.25 });
    const changes = structureChanges(a, b);
    expect(changes.map((c) => c.key)).toEqual(['deductible_amount']);
    expect(changes[0]).toMatchObject({ label: 'Deductible', from: 250_000, to: 500_000 });
  });

  it('does not call a numerically identical value a change', () => {
    expect(structureChanges(snap(), snap({ our_share_pct: 0.25 }))).toEqual([]);
  });

  it('covers the fields a renewal negotiation actually turns on', () => {
    expect(STRUCTURE_FIELDS.map((f) => f.key)).toEqual([
      'deductible_amount', 'np_retention', 'np_limit', 'our_share_pct',
      'ri_share_pct', 'placement_type', 'policy_period_months',
    ]);
  });
});

describe('decomposeChange', () => {
  it('factorises the premium change into rate and exposure exactly', () => {
    const expiring = snap({}, { final_rate_per_mille: 2.00 }, { total_si: 100_000_000 });
    const renewing = snap({}, { final_rate_per_mille: 2.20 }, { total_si: 120_000_000 });
    const d = decomposeChange(expiring, renewing);

    expect(d.rate_factor).toBeCloseTo(1.10, 12);
    expect(d.exposure_factor).toBeCloseTo(1.20, 12);
    // The point of a multiplicative split: the parts multiply to the whole,
    // with no interaction term hidden in either.
    expect(d.premium_factor).toBeCloseTo(1.32, 12);
    expect(d.rate_factor * d.exposure_factor).toBeCloseTo(d.premium_factor, 12);
  });

  it('separates a pure exposure increase from a rate increase', () => {
    const flat = decomposeChange(
      snap({}, { final_rate_per_mille: 2.00 }, { total_si: 100_000_000 }),
      snap({}, { final_rate_per_mille: 2.00 }, { total_si: 150_000_000 }),
    );
    // The premium is up 50% and the rate has not moved at all — which is the
    // conversation this exists to make possible.
    expect(flat.rate_change_pct).toBeCloseTo(0, 12);
    expect(flat.exposure_change_pct).toBeCloseTo(0.5, 12);
    expect(flat.summary).toMatch(/rate \+0\.0%/);
  });

  it('flags a rate move that came with a structure change', () => {
    const d = decomposeChange(
      snap({ deductible_amount: 250_000 }, { final_rate_per_mille: 2.00 }),
      snap({ deductible_amount: 1_000_000 }, { final_rate_per_mille: 1.70 }),
    );
    expect(d.rate_change_partly_structural).toBe(true);
    expect(d.structure_note).toMatch(/different product rather than a different price/i);
    // And it does not pretend to attribute how much.
    expect(d).not.toHaveProperty('structure_factor');
  });

  it('does not flag a share change as a priced structure change', () => {
    // A share move changes what we write, not what the cover is.
    const d = decomposeChange(
      snap({}, { final_rate_per_mille: 2.00 }),
      snap({ our_share_pct: 0.5 }, { final_rate_per_mille: 2.00 }),
    );
    expect(d.structure_changes.map((c) => c.key)).toEqual(['our_share_pct']);
    expect(d.rate_change_partly_structural).toBe(false);
  });

  it('reports the rate move when an exposure base is missing, rather than guessing', () => {
    const d = decomposeChange(
      snap({ total_sum_insured: null }, { final_rate_per_mille: 2.00 }),
      snap({}, { final_rate_per_mille: 2.40 }),
    );
    expect(d.measurable).toBe(true);
    expect(d.rate_change_pct).toBeCloseTo(0.20, 12);
    expect(d.exposure_factor).toBeNull();
    expect(d.premium_factor).toBeNull();
    expect(d.summary).toMatch(/cannot be split/i);
  });

  it('says there is nothing to compare when no expiring risk is linked', () => {
    const d = decomposeChange(null, snap());
    expect(d.measurable).toBe(false);
    expect(d.reason).toMatch(/no expiring risk is linked/i);
  });

  it('says so when the expiring risk carries no rate', () => {
    const d = decomposeChange(snap({}, { final_rate_per_mille: null }), snap());
    expect(d.measurable).toBe(false);
    expect(d.reason).toMatch(/carries no rate/i);
  });
});

describe('renewalComparison', () => {
  it('reports the move against technical, not just the move in price', () => {
    const c = renewalComparison({
      expiring: snap({}, { final_rate_per_mille: 2.00, technical_adequacy: 0.90 }),
      renewing: snap({}, { final_rate_per_mille: 2.20, technical_adequacy: 0.96 }),
    });
    expect(c.adequacy_move).toBeCloseTo(0.06, 9);
    expect(c.adequacy_note).toMatch(/closer to technical/i);
  });

  it('calls out a rate rise that is still losing ground against technical', () => {
    // Up 10% and further below technical than last year — the case a headline
    // rate change hides completely.
    const c = renewalComparison({
      expiring: snap({}, { final_rate_per_mille: 2.00, technical_adequacy: 0.95 }),
      renewing: snap({}, { final_rate_per_mille: 2.20, technical_adequacy: 0.88 }),
    });
    expect(c.decomposition.rate_change_pct).toBeCloseTo(0.10, 12);
    expect(c.adequacy_move).toBeLessThan(0);
    expect(c.adequacy_note).toMatch(/further below technical/i);
  });

  it('says when the move against technical is unknown', () => {
    const c = renewalComparison({
      expiring: snap({}, { technical_adequacy: null }),
      renewing: snap(),
    });
    expect(c.adequacy_move).toBeNull();
    expect(c.adequacy_note).toMatch(/unknown/i);
  });
});
