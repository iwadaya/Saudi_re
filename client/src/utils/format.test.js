import { describe, it, expect } from 'vitest';
import {
  addMonthsClamped,
  dateInputValue,
  fmtPctPoints,
  sanitizeNumber,
  toN,
  toNullableN,
  yearFromDateInput,
} from './format.js';

describe('toN — canonical number parser', () => {
  it('parses plain numbers', () => {
    expect(toN(42)).toBe(42);
    expect(toN('3.14')).toBe(3.14);
  });
  it('strips currency symbols and thousand separators', () => {
    expect(toN('$1,234.50')).toBe(1234.5);
    expect(toN('SAR 1,000,000')).toBe(1_000_000);
  });
  it('handles European decimal comma', () => {
    expect(toN('1.234,56')).toBe(1234.56);
  });
  it('handles parentheses as negative', () => {
    expect(toN('(500)')).toBe(-500);
  });
  it('returns 0 for empty/junk', () => {
    expect(toN('')).toBe(0);
    expect(toN(null)).toBe(0);
    expect(toN(undefined)).toBe(0);
    expect(toN('not a number')).toBe(0);
  });
});

describe('toNullableN', () => {
  it('returns null for empty/junk so callers can distinguish from 0', () => {
    expect(toNullableN('')).toBeNull();
    expect(toNullableN(null)).toBeNull();
    expect(toNullableN(0)).toBe(0);
  });
});

describe('date helpers', () => {
  it('normalises date input values from ISO and local formats', () => {
    expect(dateInputValue('2026-05-01T12:34:00Z')).toBe('2026-05-01');
    expect(dateInputValue('01/05/2026')).toBe('2026-05-01');
    expect(dateInputValue('2026/05/01')).toBe('2026-05-01');
  });

  it('extracts a year without timezone conversion', () => {
    expect(yearFromDateInput('2026-01-01')).toBe(2026);
    expect(yearFromDateInput('invalid')).toBeNull();
  });

  it('adds months with end-of-month clamping', () => {
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonthsClamped('2023-01-31', 1)).toBe('2023-02-28');
    expect(addMonthsClamped('2024-02-29', 12)).toBe('2025-02-28');
  });
});

describe('fmtPctPoints', () => {
  it('formats percentage-point values without ratio conversion', () => {
    expect(fmtPctPoints(12.345)).toBe('12.35%');
    expect(fmtPctPoints(12.345, 1)).toBe('12.3%');
    expect(fmtPctPoints(NaN)).toBe('—');
  });
});

describe('sanitizeNumber — paste/typing input cleaner', () => {
  // Pasting from external sources (Excel, Bloomberg, accounting software,
  // copy-from-PDF). Must produce a numeric string the rest of the app
  // can parse with parseFloat / parseFlexibleNumber.
  describe('paste shapes', () => {
    it('strips currency symbols and thousand separators', () => {
      expect(sanitizeNumber('$1,234.50')).toBe('1234.50');
      expect(sanitizeNumber('SAR 1,000,000')).toBe('1000000');
      expect(sanitizeNumber('£500')).toBe('500');
    });
    it('converts accounting parentheses to a leading minus', () => {
      expect(sanitizeNumber('(500)')).toBe('-500');
      expect(sanitizeNumber('($1,234.50)')).toBe('-1234.50');
    });
    it('handles European thousands+decimal (1.234,56 → 1234.56)', () => {
      expect(sanitizeNumber('1.234,56')).toBe('1234.56');
    });
    it('promotes a short trailing comma to a decimal (1,5 → 1.5)', () => {
      expect(sanitizeNumber('1,5')).toBe('1.5');
    });
    it('converts the Unicode minus sign to ASCII -', () => {
      expect(sanitizeNumber('−500')).toBe('-500');
    });
  });

  // Critical: the same function runs on every keystroke in many inputs.
  // Returning a normalised number for partial input would prevent users
  // from typing decimals at all.
  describe('partial-typing scenarios (every keystroke)', () => {
    it('preserves a trailing dot so the user can type a decimal', () => {
      expect(sanitizeNumber('1.')).toBe('1.');
    });
    it('preserves a leading minus sign while typing a negative', () => {
      expect(sanitizeNumber('-')).toBe('-');
      expect(sanitizeNumber('-1')).toBe('-1');
    });
    it('passes plain numbers through unchanged', () => {
      expect(sanitizeNumber('1234.56')).toBe('1234.56');
    });
    it('returns empty for empty / nullish', () => {
      expect(sanitizeNumber('')).toBe('');
      expect(sanitizeNumber(null)).toBe('');
      expect(sanitizeNumber(undefined)).toBe('');
    });
  });
});
