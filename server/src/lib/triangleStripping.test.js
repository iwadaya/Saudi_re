import { describe, it, expect } from 'vitest';
import { stripTriangleCells, lossEntryDevMonths, stripFieldForType, summarizeLossPlacement } from './triangleStripping.js';

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

describe('summarizeLossPlacement', () => {
  const annualRow = (year, vals) =>
    vals.map((v, i) => ({ origin_year: year, dev_months: (i + 1) * 12, cum_value: v }));

  it('counts losses placed by reported date vs the loss-date proxy', () => {
    const cells = annualRow(2021, [100, 200, 300]);
    const losses = [
      // Reliable reported date within range → 'reported'.
      { uw_year: 2021, incurred: 50, date_of_loss: '2021-03-10', actuarial_reported_date: '2022-01-01' },
      // No reported date → 'proxy'.
      { uw_year: 2021, incurred: 50, date_of_loss: '2021-03-10' },
      // Reported date far in the future (artifact) → falls back to 'proxy'.
      { uw_year: 2021, incurred: 50, date_of_loss: '2021-03-10', actuarial_reported_date: '2030-01-01' },
    ];
    expect(summarizeLossPlacement(cells, losses, 'incurred')).toEqual({ reported: 1, proxy: 2, total: 3 });
  });

  it('does not count a loss whose entry falls past the observed dev range', () => {
    // Only the 12m column is observed. A late-November loss (age 10) enters at
    // dev 13 — beyond the row — so stripTriangleCells never strips it and it
    // shouldn't be flagged as placed either.
    const cells = annualRow(2021, [100]);
    const losses = [{ uw_year: 2021, incurred: 50, date_of_loss: '2021-11-20' }];
    expect(summarizeLossPlacement(cells, losses, 'incurred')).toEqual({ reported: 0, proxy: 0, total: 0 });
    // Sanity: stripping leaves the observed column untouched.
    expect(stripTriangleCells(cells, losses, 'incurred').map(c => c.cum_value)).toEqual([100]);
  });

  it('ignores zero-amount losses and losses with no matching row', () => {
    const cells = annualRow(2021, [100, 200]);
    const losses = [
      { uw_year: 2021, incurred: 0, date_of_loss: '2021-03-10' },         // zero → skipped
      { uw_year: 2099, incurred: 50, date_of_loss: '2099-03-10' },        // no row → skipped
    ];
    expect(summarizeLossPlacement(cells, losses, 'incurred')).toEqual({ reported: 0, proxy: 0, total: 0 });
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

  it('uses the reported date plus a quarter when present, plausible, and within range', () => {
    // Loss Mar 2021, reported Sep 2022 → age 20m, +1 quarter = 23m, within a 60m row.
    expect(lossEntryDevMonths(2021, '2021-03-10', '2022-09-01', 60)).toBe(23);
  });
  it('ignores a reported date earlier than the loss date', () => {
    // Reported before loss is implausible → fall back to loss date + a quarter.
    expect(lossEntryDevMonths(2021, '2021-06-10', '2021-01-01', 60)).toBe(8);
  });
  it('ignores a reported date past the observed development range (data-entry artifact)', () => {
    // reported_date auto-set to "today" (2026) on a 2021 loss → beyond the
    // 60m row → fall back to the loss-date proxy rather than never stripping.
    expect(lossEntryDevMonths(2021, '2021-03-10', '2026-05-01', 60)).toBe(5);
  });
  it('falls back to the loss-date proxy when no reported date is given', () => {
    expect(lossEntryDevMonths(2021, '2021-03-10', null, 60)).toBe(5);
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

  it('enters the loss at its actuarial reported development period when reliable', () => {
    // Reported Sep 2022 (age 20m) → only the 24m+ columns are stripped.
    const cells = annualRow(2021, [100, 300, 320]);
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, incurred: 150, date_of_loss: '2021-03-10', actuarial_reported_date: '2022-09-01' }],
      'incurred',
    );
    expect(out.map(c => c.cum_value)).toEqual([100, 150, 170]);
  });

  it('falls back to the loss-date proxy when the actuarial reported date is an out-of-range artifact', () => {
    // actuarial date set far past the row → strip from the loss-date proxy
    // (dev 5 → all annual columns) instead of not at all.
    const cells = annualRow(2021, [100, 300, 320]);
    const out = stripTriangleCells(
      cells,
      [{ uw_year: 2021, incurred: 150, date_of_loss: '2021-03-10', actuarial_reported_date: '2026-05-01' }],
      'incurred',
    );
    expect(out.map(c => c.cum_value)).toEqual([0, 150, 170]);
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
