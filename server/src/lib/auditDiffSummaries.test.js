// Tests for the bulk-save audit summary builders (lib/auditDiffSummaries.js).
import { describe, it, expect } from 'vitest';
import {
  summarizeCellChanges,
  summarizeLossChanges,
  lossSummaryIsNoop,
  layerDiffMap,
  unionKeys,
} from './auditDiffSummaries.js';

describe('summarizeCellChanges', () => {
  it('counts added/removed/changed with numeric normalisation', () => {
    const before = [
      { origin_year: 2020, dev_months: 12, cum_value: '100.00' },
      { origin_year: 2020, dev_months: 24, cum_value: '200' },
    ];
    const after = [
      { origin_year: 2020, dev_months: 12, cum_value: 100 },     // unchanged (100.00 === 100)
      { origin_year: 2020, dev_months: 24, cum_value: '250' },   // changed
      { origin_year: 2021, dev_months: 12, cum_value: '5' },     // added
    ];
    expect(summarizeCellChanges(before, after)).toEqual({ before: 2, after: 3, added: 1, removed: 0, changed: 1 });
  });

  it('counts removals and tolerates empty inputs', () => {
    expect(summarizeCellChanges([{ origin_year: 2020, dev_months: 12, cum_value: 1 }], []))
      .toEqual({ before: 1, after: 0, added: 0, removed: 1, changed: 0 });
    expect(summarizeCellChanges([], [])).toEqual({ before: 0, after: 0, added: 0, removed: 0, changed: 0 });
  });
});

describe('summarizeLossChanges', () => {
  it('captures selection toggles, amount edits, and additions', () => {
    const prev = [
      { loss_id: 'a', is_selected: true, incurred: '100', paid: '100', os: '0', inflation_factor: '1' },
      { loss_id: 'b', is_selected: false, incurred: '50', paid: '50', os: '0', inflation_factor: '1' },
    ];
    const next = [
      { loss_id: 'a', is_selected: false, incurred: '100', paid: '100', os: '0', inflation_factor: '1' }, // toggle only
      { loss_id: 'b', is_selected: false, incurred: '75', paid: '75', os: '0', inflation_factor: '1' },   // amount only
      { loss_id: null, is_selected: true, incurred: '10', paid: '10', os: '0', inflation_factor: '1' },   // added
    ];
    const s = summarizeLossChanges(prev, next);
    expect(s).toMatchObject({ before: 2, after: 3, added: 1, removed: 0, amountChanged: 1 });
    expect(s.selectionToggles).toEqual([{ loss_id: 'a', from: true, to: false }]);
    expect(lossSummaryIsNoop(s)).toBe(false);
  });

  it('flags removed losses', () => {
    const prev = [{ loss_id: 'a', is_selected: true, incurred: '1' }, { loss_id: 'b', is_selected: true, incurred: '1' }];
    const next = [{ loss_id: 'a', is_selected: true, incurred: '1' }];
    expect(summarizeLossChanges(prev, next).removed).toBe(1);
  });

  it('is a no-op when nothing material changed', () => {
    const rows = [{ loss_id: 'a', is_selected: true, incurred: '100', paid: '100', os: '0', inflation_factor: '1' }];
    const s = summarizeLossChanges(rows, rows.map((r) => ({ ...r })));
    expect(lossSummaryIsNoop(s)).toBe(true);
  });
});

describe('layerDiffMap / unionKeys', () => {
  it('keys layers by number with only the watched fields', () => {
    const map = layerDiffMap([{ layer_number: 1, attachment: '1000', uw_price: '5', extra: 'ignored' }], ['attachment', 'uw_price']);
    expect(map).toEqual({ layer_1: { attachment: '1000', uw_price: '5' } });
  });

  it('unionKeys merges keys across objects and skips nullish', () => {
    expect(unionKeys({ a: 1 }, { b: 2 }, null, { a: 3, c: 4 }).sort()).toEqual(['a', 'b', 'c']);
  });
});
