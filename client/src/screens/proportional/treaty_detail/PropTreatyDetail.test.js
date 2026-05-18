import { describe, it, expect } from 'vitest';
import {
  yearFromDateStr,
  addMonths,
  extractLpSlides,
  getMissingRequiredFields,
  numOrNull,
} from './PropTreatyDetail.jsx';

describe('yearFromDateStr', () => {
  it('extracts the year prefix without timezone conversion', () => {
    expect(yearFromDateStr('2024-01-01')).toBe(2024);
    expect(yearFromDateStr('2024-12-31')).toBe(2024);
  });
  it('returns null for empty / invalid input', () => {
    expect(yearFromDateStr('')).toBeNull();
    expect(yearFromDateStr(null)).toBeNull();
    expect(yearFromDateStr(undefined)).toBeNull();
    expect(yearFromDateStr('invalid')).toBeNull();
  });
});

describe('addMonths — day-clamping', () => {
  it('clamps Feb 29 + 12 months to Feb 28 in the next year', () => {
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
  });
  it('clamps Jan 31 + 1 month to the last valid day of February', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2023-01-31', 1)).toBe('2023-02-28');
  });
  it('returns "" for empty input', () => {
    expect(addMonths('', 12)).toBe('');
    expect(addMonths(null, 12)).toBe('');
  });
  it('handles trailing time portion (uses date prefix only)', () => {
    expect(addMonths('2024-01-31T00:00:00Z', 1)).toBe('2024-02-29');
  });
});

describe('extractLpSlides', () => {
  it('returns the populated rows regardless of any lpMode flag', () => {
    const slides = [
      { minLr: '60', maxLr: '80', share: '50' },
      { minLr: '80', maxLr: '100', share: '70' },
      { minLr: '100', maxLr: '120', share: '90' },
      { minLr: '', maxLr: '', share: '' },
      { minLr: '', maxLr: '', share: '' },
    ];
    const out = extractLpSlides(slides);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ min_lr: 60, max_lr: 80, share: 50 });
    expect(out[2]).toEqual({ min_lr: 100, max_lr: 120, share: 90 });
  });
  it('drops empty rows', () => {
    expect(extractLpSlides([{ minLr: '', maxLr: '', share: '' }])).toEqual([]);
  });
  it('handles undefined / null safely', () => {
    expect(extractLpSlides(undefined)).toEqual([]);
    expect(extractLpSlides(null)).toEqual([]);
  });
});

describe('numOrNull', () => {
  it('strips commas from formatted numbers', () => {
    expect(numOrNull('1,000,000')).toBe(1_000_000);
  });
  it('returns null for empty / non-numeric', () => {
    expect(numOrNull('')).toBeNull();
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull('not a number')).toBeNull();
  });
});

describe('getMissingRequiredFields', () => {
  // Helper to construct a fully-filled QS treaty slice; tests poke a
  // single field to verify each branch of the validator in isolation.
  const fullQsFixed = {
    countryId: 'cy', cedantId: 'ce', treatyTypeId: 'tt',
    classIds: ['cob-1'], brokerId: 'br', currencyId: 'cu',
    inceptionDate: '2026-01-01', experienceStartYear: 2015,
    qsLimit: '1000000', retentionPct: '50', quotaShareEpi: '500000',
    commissionMode: 'fixed', fixedCommissionQSPct: '30',
    lossPartEnabled: false,
  };

  it('empty slice in fixed/QS mode lists every always-required label + QS fields + fixed QS commission + LP scalars (LP defaults YES)', () => {
    const missing = getMissingRequiredFields({}, { tMode: 'quota', commMode: 'fixed' });
    // Always-required identifiers
    expect(missing).toEqual(expect.arrayContaining([
      'Country', 'Cedant Name', 'Treaty Type', 'Line of Business',
      'Broker', 'Currency', 'Treaty Inception Date', 'Experience Start Year',
    ]));
    // QS side
    expect(missing).toEqual(expect.arrayContaining([
      'QS 100% Limit', 'Retention %', 'Quota Share EPI',
    ]));
    // Fixed-commission side
    expect(missing).toContain('Fixed QS Commission %');
    // LP scalars (lossPartEnabled defaults to true via `!== false`)
    expect(missing).toEqual(expect.arrayContaining([
      'LP Min Loss Ratio %', 'LP Max Loss Ratio %', 'LP Reinsurer Share %',
    ]));
    // Surplus-only fields are NOT in the list — QS treaty
    expect(missing).not.toContain('Surplus Max Retention');
  });

  it('fully-filled QS + fixed + LP=NO returns []', () => {
    expect(getMissingRequiredFields(fullQsFixed, { tMode: 'quota', commMode: 'fixed' })).toEqual([]);
  });

  it('sliding mode with 1 complete + 1 partial row reports the table message', () => {
    const slice = {
      ...fullQsFixed,
      commissionMode: 'sliding',
      slidingMinLossRatio: '40', slidingMaxLossRatio: '80',
      slidingMinCommission: '20', slidingMaxCommission: '35',
      provisionalCommissionPct: '30',
      slidingTable: [
        { lossRatioPct: '50', commissionPct: '25' },
        { lossRatioPct: '60', commissionPct: '' }, // partial → doesn't count
      ],
    };
    const missing = getMissingRequiredFields(slice, { tMode: 'quota', commMode: 'sliding' });
    expect(missing).toContain('Sliding Scale table (need ≥2 complete rows)');
  });

  it('Surplus-only treaty does NOT report QS-side fields', () => {
    const slice = {
      ...fullQsFixed,
      qsLimit: '', retentionPct: '', quotaShareEpi: '',
      surplusMaxRetention: '1000000', numLines: '5', surplusEpi: '500000',
      fixedCommissionSurplusPct: '30',
      fixedCommissionQSPct: '',
    };
    const missing = getMissingRequiredFields(slice, { tMode: 'surplus', commMode: 'fixed' });
    expect(missing).not.toContain('QS 100% Limit');
    expect(missing).not.toContain('Retention %');
    expect(missing).not.toContain('Quota Share EPI');
    expect(missing).not.toContain('Fixed QS Commission %');
    expect(missing).toEqual([]);
  });

  it('"both" mode reports BOTH QS-side and Surplus-side required fields when missing', () => {
    const empty = {
      countryId: 'cy', cedantId: 'ce', treatyTypeId: 'tt',
      classIds: ['cob-1'], brokerId: 'br', currencyId: 'cu',
      inceptionDate: '2026-01-01', experienceStartYear: 2015,
      commissionMode: 'fixed', lossPartEnabled: false,
    };
    const missing = getMissingRequiredFields(empty, { tMode: 'both', commMode: 'fixed' });
    expect(missing).toEqual(expect.arrayContaining([
      'QS 100% Limit', 'Retention %', 'Quota Share EPI',
      'Surplus Max Retention', 'Number of Lines', 'Surplus EPI',
      'Fixed QS Commission %', 'Fixed Surplus Commission %',
    ]));
  });

  it('LP toggle YES + no scalars → reports LP scalar trio', () => {
    const slice = { ...fullQsFixed, lossPartEnabled: true };
    const missing = getMissingRequiredFields(slice, { tMode: 'quota', commMode: 'fixed' });
    expect(missing).toEqual(expect.arrayContaining([
      'LP Min Loss Ratio %', 'LP Max Loss Ratio %', 'LP Reinsurer Share %',
    ]));
  });

  it('LP toggle NO → does NOT report LP scalars', () => {
    const slice = { ...fullQsFixed, lossPartEnabled: false };
    const missing = getMissingRequiredFields(slice, { tMode: 'quota', commMode: 'fixed' });
    expect(missing).not.toContain('LP Min Loss Ratio %');
    expect(missing).not.toContain('LP Max Loss Ratio %');
    expect(missing).not.toContain('LP Reinsurer Share %');
  });

  it('sliding scale with 2 complete rows + filled scalars + LP=NO returns []', () => {
    const slice = {
      ...fullQsFixed,
      commissionMode: 'sliding', fixedCommissionQSPct: '',
      slidingMinLossRatio: '40', slidingMaxLossRatio: '80',
      slidingMinCommission: '20', slidingMaxCommission: '35',
      provisionalCommissionPct: '30',
      slidingTable: [
        { lossRatioPct: '50', commissionPct: '25' },
        { lossRatioPct: '70', commissionPct: '20' },
      ],
    };
    expect(getMissingRequiredFields(slice, { tMode: 'quota', commMode: 'sliding' })).toEqual([]);
  });
});
