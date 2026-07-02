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
