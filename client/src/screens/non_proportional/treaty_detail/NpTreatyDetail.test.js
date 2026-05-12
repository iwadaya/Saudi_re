import { describe, it, expect } from 'vitest';
import {
  yearFromDateStr,
  addMonths,
  numOrNull,
} from './NpTreatyDetail.jsx';

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
