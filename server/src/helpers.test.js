import { describe, it, expect } from 'vitest';
import { parseNum, toNum, numOrNull, dateOrNull, boolOrDefault, safeSqlIdentifier, yearFromDate, safeUwYear, preserveBool, preserveNum } from './helpers.js';

// These helpers sit on every save path for numeric/date/bool inputs, so
// bugs here show up as wrong data in Postgres. Locking the behaviour
// down with a test suite is the single highest-leverage thing we can
// cover with zero infrastructure.

describe('parseNum', () => {
  it('returns 0 for null/undefined/empty', () => {
    expect(parseNum(null)).toBe(0);
    expect(parseNum(undefined)).toBe(0);
    expect(parseNum('')).toBe(0);
  });

  it('parses numeric strings including commas', () => {
    expect(parseNum('1,234.56')).toBe(1234.56);
    expect(parseNum('42')).toBe(42);
  });

  it('returns 0 for non-numeric strings', () => {
    expect(parseNum('abc')).toBe(0);
    expect(parseNum('N/A')).toBe(0);
  });

  it('passes through finite numbers', () => {
    expect(parseNum(3.14)).toBe(3.14);
    expect(parseNum(0)).toBe(0);
  });

  it('returns 0 for NaN/Infinity', () => {
    expect(parseNum(NaN)).toBe(0);
    expect(parseNum(Infinity)).toBe(0);
  });
});

describe('toNum', () => {
  it('returns null for null/undefined/empty — Postgres-safe', () => {
    expect(toNum(null)).toBe(null);
    expect(toNum(undefined)).toBe(null);
    expect(toNum('')).toBe(null);
    expect(toNum('   ')).toBe(null);
  });

  it('strips commas and parses', () => {
    expect(toNum('1,000,000')).toBe(1_000_000);
    expect(toNum('-250.5')).toBe(-250.5);
  });

  it('returns null for junk strings rather than 0', () => {
    expect(toNum('abc')).toBe(null);
    expect(toNum('N/A')).toBe(null);
  });

  it('handles numbers directly', () => {
    expect(toNum(42)).toBe(42);
    expect(toNum(NaN)).toBe(null);
  });
});

describe('numOrNull', () => {
  it('mirrors toNum for display helpers', () => {
    expect(numOrNull(null)).toBe(null);
    expect(numOrNull('')).toBe(null);
    expect(numOrNull('1,500')).toBe(1500);
    expect(numOrNull(0)).toBe(0);
    expect(numOrNull('xyz')).toBe(null);
  });
});

describe('dateOrNull', () => {
  it('returns null for falsy', () => {
    expect(dateOrNull('')).toBe(null);
    expect(dateOrNull(null)).toBe(null);
    expect(dateOrNull(undefined)).toBe(null);
  });

  it('passes through ISO dates', () => {
    expect(dateOrNull('2026-01-15')).toBe('2026-01-15');
    expect(dateOrNull('2026-01-15T12:34:56Z')).toBe('2026-01-15');
  });

  it('parses DD/MM/YYYY when day > 12', () => {
    expect(dateOrNull('31/01/2026')).toBe('2026-01-31');
  });

  it('parses DD/MM/YYYY for ambiguous dates when first > 12', () => {
    expect(dateOrNull('15/03/2026')).toBe('2026-03-15');
  });

  it('returns null for unparseable strings', () => {
    expect(dateOrNull('not-a-date')).toBe(null);
  });
});

describe('boolOrDefault', () => {
  it('accepts booleans', () => {
    expect(boolOrDefault(true)).toBe(true);
    expect(boolOrDefault(false)).toBe(false);
  });

  it('accepts string forms', () => {
    expect(boolOrDefault('true')).toBe(true);
    expect(boolOrDefault('false')).toBe(false);
  });

  it('accepts 1/0', () => {
    expect(boolOrDefault(1)).toBe(true);
    expect(boolOrDefault(0)).toBe(false);
  });

  it('uses the fallback for anything else', () => {
    expect(boolOrDefault(null, true)).toBe(true);
    expect(boolOrDefault(undefined, false)).toBe(false);
    expect(boolOrDefault('yes', true)).toBe(true);
  });
});

describe('safeSqlIdentifier', () => {
  it('quotes valid identifiers', () => {
    expect(safeSqlIdentifier('contract')).toBe('"contract"');
    expect(safeSqlIdentifier('public.contract')).toBe('"public"."contract"');
  });

  it('rejects injection attempts by falling back to a safe default', () => {
    // The attack surface: `safeSqlIdentifier(userInput)` that then gets
    // interpolated into DDL/DML. We don't want to ever let a drop-table
    // string through — the helper returns "dashboard" as a sentinel.
    expect(safeSqlIdentifier('contract; DROP TABLE users; --')).toBe('"dashboard"');
    expect(safeSqlIdentifier("' OR 1=1 --")).toBe('"dashboard"');
    expect(safeSqlIdentifier('1numeric_start')).toBe('"dashboard"');
  });
});

describe('yearFromDate', () => {
  it('returns the UTC year for a valid date', () => {
    expect(yearFromDate('2020-05-01')).toBe(2020);
  });
  it('returns null for missing or invalid dates (never NaN)', () => {
    expect(yearFromDate(null)).toBeNull();
    expect(yearFromDate('')).toBeNull();
    expect(yearFromDate('not-a-date')).toBeNull();
  });
});

describe('safeUwYear (Finding 4 — NaN guard)', () => {
  it('prefers an explicit uw_year, then inception, then loss year', () => {
    expect(safeUwYear({ uw_year: 2021, policy_inception_date: '2019-01-01' })).toBe(2021);
    expect(safeUwYear({ policy_inception_date: '2019-03-01' })).toBe(2019);
    expect(safeUwYear({ date_of_loss: '2018-07-01' })).toBe(2018);
  });
  it('does NOT propagate NaN from an invalid policy_inception_date', () => {
    // Previously new Date('not-a-date').getUTCFullYear() === NaN, and ?? does
    // not catch NaN, so NaN reached the integer column and aborted the save.
    expect(safeUwYear({ policy_inception_date: 'not-a-date' })).toBeNull();
    expect(safeUwYear({ policy_inception_date: 'not-a-date', date_of_loss: '2017-01-01' })).toBe(2017);
  });
});

describe('preserveBool / preserveNum (Finding 1 — preserve when omitted)', () => {
  it('keeps the existing value when the incoming field is omitted', () => {
    // The loss-list grid omits is_selected → must NOT reset a saved `false`.
    expect(preserveBool(undefined, false)).toBe(false);
    expect(preserveBool(undefined, true)).toBe(true);
    // inflation_factor omitted → keep the saved 1.5 (pg returns numeric as string).
    expect(preserveNum(undefined, '1.5', 1)).toBe(1.5);
  });
  it('lets an explicit incoming value win', () => {
    expect(preserveBool(true, false)).toBe(true);
    expect(preserveBool(false, true)).toBe(false);
    expect(preserveNum(2.0, '1.5', 1)).toBe(2);
  });
  it('applies the default for a brand-new loss (no incoming, no prev)', () => {
    expect(preserveBool(undefined, undefined)).toBe(true);
    expect(preserveNum(undefined, undefined, 1)).toBe(1);
  });
  it('treats stringy booleans as present', () => {
    expect(preserveBool('false', true)).toBe(false);
    expect(preserveBool('true', false)).toBe(true);
  });
});
