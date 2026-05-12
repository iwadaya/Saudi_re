import { describe, it, expect } from 'vitest';
import {
  yearFromDateStr,
  addMonths,
  extractLpSlides,
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
