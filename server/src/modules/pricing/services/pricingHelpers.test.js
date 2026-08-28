// Unit tests for the NP per-layer line% parsers. The client sends line_pct
// for NP treaties as a JSON per-layer map; these collapse it to a single
// number. Regression focus: 0% layers must be INCLUDED in the mean (they were
// previously dropped by an `n > 0` filter, biasing the result upward).

import { describe, it, expect } from 'vitest';
import { parseOfferLinePct, parseSignedLinePct } from './pricingHelpers.js';

describe('parseOfferLinePct', () => {
  it('includes 0% layers in the mean — {L1:0,L2:30} → 15 (not 30)', () => {
    expect(parseOfferLinePct({ line_pct: '{"L1":0,"L2":30}' })).toBe(15);
  });

  it('all-null map → null (nothing usable)', () => {
    expect(parseOfferLinePct({ line_pct: '{"L1":null,"L2":null}' })).toBe(null);
  });

  it('drops negatives but keeps zeros — {L1:-5,L2:0,L3:30} → 15', () => {
    expect(parseOfferLinePct({ line_pct: '{"L1":-5,"L2":0,"L3":30}' })).toBe(15);
  });

  it('written_line_pct wins over line_pct', () => {
    expect(parseOfferLinePct({ written_line_pct: '42', line_pct: '{"L1":0,"L2":30}' })).toBe(42);
  });

  // F103: an explicitly written 0% line is a real decision ("declined to
  // zero") and must persist as 0, not collapse to NULL ("no line entered").
  it('keeps an explicit 0% written line — 0 / "0" / "0%" → 0 (not null)', () => {
    expect(parseOfferLinePct({ written_line_pct: 0 })).toBe(0);
    expect(parseOfferLinePct({ written_line_pct: '0' })).toBe(0);
    expect(parseOfferLinePct({ written_line_pct: '0%' })).toBe(0);
  });

  it('0% written line wins over a non-zero line_pct in the same payload', () => {
    expect(parseOfferLinePct({ written_line_pct: 0, line_pct: '{"L1":30}' })).toBe(0);
  });

  it('unparseable written_line_pct falls back to line_pct instead of null', () => {
    expect(parseOfferLinePct({ written_line_pct: 'abc', line_pct: '25%' })).toBe(25);
    expect(parseOfferLinePct({ written_line_pct: 'abc', line_pct: '{"L1":0,"L2":30}' })).toBe(15);
  });

  it('unparseable written_line_pct with no usable line_pct → null', () => {
    expect(parseOfferLinePct({ written_line_pct: 'abc' })).toBe(null);
  });

  it('plain %-string line_pct parses directly', () => {
    expect(parseOfferLinePct({ line_pct: '25%' })).toBe(25);
  });

  it('null inputs → null', () => {
    expect(parseOfferLinePct({ line_pct: null, written_line_pct: null })).toBe(null);
  });
});

describe('parseSignedLinePct', () => {
  it('includes 0% layers in the mean — {L1:0,L2:30} → 15 (not 30)', () => {
    expect(parseSignedLinePct('{"L1":0,"L2":30}')).toBe(15);
  });

  it('all-null map → null', () => {
    expect(parseSignedLinePct('{"L1":null,"L2":null}')).toBe(null);
  });

  it('plain numeric string parses to a number', () => {
    expect(parseSignedLinePct('30')).toBe(30);
  });

  it('null → null', () => {
    expect(parseSignedLinePct(null)).toBe(null);
  });
});
