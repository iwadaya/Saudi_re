// Unit tests for parseQuoteLinePct — the quote-side twin of
// parseOfferLinePct. Regression focus: an NP per-layer line_pct map must
// average 0% layers IN (they were dropped by an `n > 0` filter before, which
// biased the written line upward and silently discarded legitimate 0% layers).
//
// Only the pure parser is exercised here; the transactional actions need a DB.

import { describe, it, expect } from 'vitest';
import { parseQuoteLinePct } from './quoteWorkflow.js';

describe('parseQuoteLinePct', () => {
  it('includes 0% layers in the mean — {L1:0,L2:30} → 15 (not 30)', () => {
    expect(parseQuoteLinePct({ line_pct: '{"L1":0,"L2":30}' })).toBe(15);
  });

  it('all-null map → null (nothing usable)', () => {
    expect(parseQuoteLinePct({ line_pct: '{"L1":null,"L2":null}' })).toBe(null);
  });

  it('drops negatives but keeps zeros — {L1:-5,L2:0,L3:30} → 15', () => {
    expect(parseQuoteLinePct({ line_pct: '{"L1":-5,"L2":0,"L3":30}' })).toBe(15);
  });

  it('written_line_pct wins over line_pct', () => {
    expect(parseQuoteLinePct({ written_line_pct: 40, line_pct: '{"L1":0,"L2":30}' })).toBe(40);
  });

  it('plain numeric line_pct (PROP) parses directly', () => {
    expect(parseQuoteLinePct({ line_pct: 30 })).toBe(30);
  });

  it('nothing usable → null', () => {
    expect(parseQuoteLinePct({ written_line_pct: null, line_pct: null })).toBe(null);
  });
});
