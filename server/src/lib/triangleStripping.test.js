import { describe, it, expect } from 'vitest';
import { stripTriangleCells, lossEntryDevMonths, stripFieldForType } from './triangleStripping.js';

describe('stripFieldForType', () => {
  it('maps claims types to their loss amount column', () => {
    expect(stripFieldForType('CLAIMS_PAID')).toBe('paid');
    expect(stripFieldForType('CLAIMS_OS')).toBe('os');
    expect(stripFieldForType('INCURRED')).toBe('incurred');
  });
  it('returns null for non-claims types', () => {
    expect(stripFieldForType('PREMIUM')).toBeNull();
    expect(stripFieldForType('NP_EXCESS')).toBeNull();
    expect(stripFieldForType(undefined)).toBeNull();
  });
});

describe('lossEntryDevMonths', () => {
  it('adds a quarter to the loss age within its underwriting year', () => {
    // Jan loss → age 0 → enters at 3 months
    expect(lossEntryDevMonths(2021, '2021-01-15')).toBe(3);
    // Oct loss → age 9 → enters at 12 months (still within dev year 1)
    expect(lossEntryDevMonths(2021, '2021-10-10')).toBe(12);
    // Nov loss → age 10 → enters at 13 months (past the 12m column → dev year 2)
    expect(lossEntryDevMonths(2021, '2021-11-10')).toBe(13);
  });
  it('treats a missing/invalid date as present from inception', () => {
    expect(lossEntryDevMonths(2021, null)).toBe(0);
    expect(lossEntryDevMonths(2021, 'not-a-date')).toBe(0);
  });
});

describe('stripTriangleCells', () => {
  const annualRow = (year, vals) =>
    vals.map((v, i) => ({ origin_year: year, dev_months: (i + 1) * 12, cum_value: v }));

  it('returns clones unchanged when there is no strip field', () => {
    const cells = annualRow(2021, [100, 200, 300]);
    const out = stripTriangleCells(cells, [{ uw_year: 2021, incurred: 50, date_of_loss: '2021-01-01' }], null);
    expect(out.map(c => c.cum_value)).toEqual([100, 200, 300]);
    expect(out[0]).not.toBe(cells[0]); // cloned
  });

  it('subtracts a loss from the entry dev period onward (cumulative)', () => {
    // Loss in Jan 2021 → enters at dev 3 → affects all annual columns (>=3)
    const cells = annualRow(2021, [100, 300, 320]);
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, paid: 0, os: 0, incurred: 150, date_of_loss: '2021-01-15' }],
      'incurred',
    );
    expect(out.map(c => c.cum_value)).toEqual([0, 150, 170]);
  });

  it('does not touch dev columns before the loss enters', () => {
    // Nov 2021 loss → enters at dev 13 → only the 24m+ columns are stripped
    const cells = annualRow(2021, [100, 300, 320]);
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, incurred: 100, date_of_loss: '2021-11-20' }],
      'incurred',
    );
    expect(out.map(c => c.cum_value)).toEqual([100, 200, 220]);
  });

  it('clamps to zero and keeps the row cumulative-monotonic', () => {
    const cells = annualRow(2021, [100, 120, 130]);
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, incurred: 200, date_of_loss: '2021-01-01' }],
      'incurred',
    );
    // Every column would go negative → clamped to 0, non-decreasing preserved.
    expect(out.map(c => c.cum_value)).toEqual([0, 0, 0]);
  });

  it('enforces monotonicity when only some columns would dip', () => {
    const cells = annualRow(2021, [100, 120, 500]);
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, incurred: 200, date_of_loss: '2021-01-01' }],
      'incurred',
    );
    // 100-200<0→0 ; 120-200<0→0 ; 500-200=300
    expect(out.map(c => c.cum_value)).toEqual([0, 0, 300]);
  });

  it('uses the column matching the triangle type (paid vs os)', () => {
    const cells = annualRow(2021, [100, 200]);
    const losses = [{ uw_year: 2021, paid: 30, os: 70, incurred: 100, date_of_loss: '2021-01-01' }];
    expect(stripTriangleCells(cells, losses, 'paid').map(c => c.cum_value)).toEqual([70, 170]);
    expect(stripTriangleCells(cells, losses, 'os').map(c => c.cum_value)).toEqual([30, 130]);
  });

  it('only strips losses matching the row underwriting year', () => {
    const cells = [...annualRow(2021, [100, 200]), ...annualRow(2022, [100, 200])];
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, incurred: 50, date_of_loss: '2021-01-01' }],
      'incurred',
    );
    const y2021 = out.filter(c => c.origin_year === 2021).map(c => c.cum_value);
    const y2022 = out.filter(c => c.origin_year === 2022).map(c => c.cum_value);
    expect(y2021).toEqual([50, 150]);
    expect(y2022).toEqual([100, 200]); // untouched
  });

  it('sums multiple losses that enter at different periods', () => {
    const cells = annualRow(2021, [100, 300, 600]);
    const out = stripTriangleCells(
      cells,
      [
        { uw_year: 2021, incurred: 50, date_of_loss: '2021-01-01' },  // enters dev 3
        { uw_year: 2021, incurred: 100, date_of_loss: '2021-11-20' }, // enters dev 13
      ],
      'incurred',
    );
    // dev12: -50 → 50 ; dev24: -150 → 150 ; dev36: -150 → 450
    expect(out.map(c => c.cum_value)).toEqual([50, 150, 450]);
  });
});
