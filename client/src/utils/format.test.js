import { describe, it, expect } from 'vitest';
import {
  addMonthsClamped,
  dateInputValue,
  fmtBal,
  fmtComma,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtPctPoints,
  fmtX,
  formatWithCommasDecimal,
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

describe('fmtNum / fmtPct — N/A-aware like fmtBal', () => {
  it('formats finite values, including genuine zeros', () => {
    expect(fmtNum(1234567)).toBe('1,234,567');
    expect(fmtNum(0)).toBe('0');
    expect(fmtPct(0.12345)).toBe('12.35%');
    expect(fmtPct(0)).toBe('0.00%');
  });
  it('renders null/undefined/non-numeric as — (server null means N/A, not 0)', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(undefined)).toBe('—');
    expect(fmtNum('abc')).toBe('—');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(undefined)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
  });
});

describe('fmtMoney — scaled money display', () => {
  it('scales with K/M/B units', () => {
    expect(fmtMoney(2500000)).toBe('2.50M');
    expect(fmtMoney(-1500)).toBe('-1.50K');
    expect(fmtMoney(1.2e9)).toBe('1.20B');
  });
  it('keeps 0 for a genuine zero but — for missing/non-numeric', () => {
    expect(fmtMoney(0)).toBe('0');
    expect(fmtMoney(null)).toBe('—');
    expect(fmtMoney(undefined)).toBe('—');
    expect(fmtMoney(NaN)).toBe('—');
    expect(fmtMoney('abc')).toBe('—');
  });
});

describe('fmtComma — comma grouping for money inputs', () => {
  it('groups integers exactly as before', () => {
    expect(fmtComma('1234567')).toBe('1,234,567');
    expect(fmtComma(2500000)).toBe('2,500,000');
    expect(fmtComma('1,234,567')).toBe('1,234,567');
  });
  it('preserves up to 2 decimals instead of reading them as integer digits', () => {
    expect(fmtComma('1234.56')).toBe('1,234.56');
    expect(fmtComma(1234.5)).toBe('1,234.5');
    expect(fmtComma('0.5')).toBe('0.5');
  });
  it('returns empty for blank / non-numeric input', () => {
    expect(fmtComma('')).toBe('');
    expect(fmtComma(null)).toBe('');
    expect(fmtComma(undefined)).toBe('');
    expect(fmtComma('abc')).toBe('');
  });
});

describe('fmtX — treaty balance multiplier', () => {
  it('formats finite values with a × suffix to 2dp', () => {
    expect(fmtX(2.5)).toBe('2.50×');
    expect(fmtX(0)).toBe('0.00×');
    expect(fmtX('1.234')).toBe('1.23×');
  });
  it('returns an em dash for non-finite input', () => {
    expect(fmtX(null)).toBe('0.00×'); // Number(null) === 0 is finite
    expect(fmtX(undefined)).toBe('—');
    expect(fmtX(NaN)).toBe('—');
    expect(fmtX('abc')).toBe('—');
  });
});

describe('fmtBal — N/A-aware balance multiplier', () => {
  it('formats finite values (including a genuine 0) with a × suffix', () => {
    expect(fmtBal(2.5)).toBe('2.50×');
    expect(fmtBal(0)).toBe('0.00×');
    expect(fmtBal('1.234')).toBe('1.23×');
  });
  it('renders null/blank/non-finite as N/A (—) — unlike fmtX(null)', () => {
    expect(fmtBal(null)).toBe('—');
    expect(fmtBal(undefined)).toBe('—');
    expect(fmtBal(NaN)).toBe('—');
    expect(fmtBal('abc')).toBe('—');
  });
});

describe('formatWithCommasDecimal — live money-entry display', () => {
  it('groups the integer part with commas', () => {
    expect(formatWithCommasDecimal('1234567')).toBe('1,234,567');
    expect(formatWithCommasDecimal(2500000)).toBe('2,500,000');
  });
  it('keeps typed fraction digits verbatim (no rounding)', () => {
    expect(formatWithCommasDecimal('1234.56')).toBe('1,234.56');
    expect(formatWithCommasDecimal('1234.5000')).toBe('1,234.5000');
  });
  it('preserves a trailing dot so the user can type a decimal', () => {
    expect(formatWithCommasDecimal('1234.')).toBe('1,234.');
  });
  it('preserves a leading minus', () => {
    expect(formatWithCommasDecimal('-1234.5')).toBe('-1,234.5');
  });
  it('re-groups values that already contain commas', () => {
    expect(formatWithCommasDecimal('1,234,567')).toBe('1,234,567');
  });
  it('passes through empty / blank values', () => {
    expect(formatWithCommasDecimal('')).toBe('');
    expect(formatWithCommasDecimal(null)).toBe('');
    expect(formatWithCommasDecimal(undefined)).toBe('');
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
