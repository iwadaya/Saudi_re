import { describe, expect, it } from 'vitest';
import {
  buildSlipReview,
  isBlankValue,
  normalizeSlipValue,
} from './SlipIngestButton.jsx';

describe('SlipIngestButton review helpers', () => {
  it('auto-fills blank fields and flags populated mismatches without overwriting them', () => {
    const review = buildSlipReview(
      {
        countryId: '2',
        inceptionDate: '2026-01-01',
        brokeragePct: 10,
        classIds: ['b', 'a'],
      },
      {
        countryId: '',
        inceptionDate: '2026-01-01',
        brokeragePct: '12%',
        classIds: ['a', 'b'],
        taxesPct: '2',
      },
      {
        fieldLabels: { countryId: 'Country', brokeragePct: 'Brokerage %', taxesPct: 'Taxes %' },
      },
    );

    expect(review.autoFill).toEqual({ countryId: '2' });
    expect(review.verified.map(x => x.key)).toEqual(['inceptionDate', 'classIds']);
    expect(review.conflicts).toEqual([
      expect.objectContaining({ key: 'brokeragePct', label: 'Brokerage %', slipValue: 10 }),
    ]);
    expect(review.missing).toEqual([
      expect.objectContaining({ key: 'taxesPct', label: 'Taxes %' }),
    ]);
  });

  it('normalizes numeric strings, percentages, and arrays for comparisons', () => {
    expect(normalizeSlipValue('1,000.00')).toBe('1000');
    expect(normalizeSlipValue('10%')).toBe('10');
    expect(normalizeSlipValue(['B', 'a'])).toBe('a|b');
  });

  it('treats null, empty strings, and empty arrays as blank', () => {
    expect(isBlankValue(null)).toBe(true);
    expect(isBlankValue('   ')).toBe(true);
    expect(isBlankValue([])).toBe(true);
    expect(isBlankValue(['x'])).toBe(false);
  });
});
