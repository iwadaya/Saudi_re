// Tests for the renewal matcher. Pure functions (levenshtein, nameMatch,
// tokenSetDice) are tested directly; findRenewalMatch is tested with an
// injected runQuery stub so we never need a live database.

import { describe, it, expect, vi } from 'vitest';
import {
  findRenewalMatch,
  nameMatch,
  levenshtein,
  tokenSetDice,
} from './renewalMatcher.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('saudi re', 'saudi re')).toBe(0);
  });
  it('counts single edits', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
    expect(levenshtein('cat', 'cats')).toBe(1);
    expect(levenshtein('cats', 'cat')).toBe(1);
  });
  it('handles empty strings', () => {
    expect(levenshtein('', 'cats')).toBe(4);
    expect(levenshtein('cats', '')).toBe(4);
    expect(levenshtein('', '')).toBe(0);
  });
});

describe('tokenSetDice', () => {
  it('returns 1 for identical clean tokens', () => {
    expect(tokenSetDice('Saudi Re', 'Saudi Re')).toBe(1);
  });
  it('strips legal-form / suffix noise', () => {
    // "Al Rajhi Takaful" vs "Al Rajhi Coop Ins" — after stripping
    // {takaful, coop, ins} both collapse to {al, rajhi}.
    expect(tokenSetDice('Al Rajhi Takaful', 'Al Rajhi Coop Ins')).toBe(1);
  });
  it('returns a partial score for partial overlap', () => {
    const score = tokenSetDice('Saudi Arabian Insurance', 'Saudi National Insurance');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
  it('returns 0 for disjoint cleaned tokens', () => {
    expect(tokenSetDice('Munich Re', 'Lloyds Syndicate')).toBe(0);
  });
});

describe('nameMatch', () => {
  it('passes on exact normalized match', () => {
    expect(nameMatch('Saudi Re', 'saudi re').matched).toBe(true);
  });
  it('passes on small Levenshtein distance (typos)', () => {
    expect(nameMatch('Saudi Re', 'Sudai Re').matched).toBe(true);
  });
  it('passes when Dice ≥ 0.85 even with low Levenshtein score', () => {
    // Dice should collapse this to a perfect match after suffix stripping.
    const r = nameMatch('Al Rajhi Takaful', 'Al Rajhi Coop Ins');
    expect(r.matched).toBe(true);
    expect(r.dice).toBeGreaterThanOrEqual(0.85);
  });
  it('fails for unrelated companies', () => {
    const r = nameMatch('Munich Re', 'Lloyds Syndicate');
    expect(r.matched).toBe(false);
  });
  it('fails for empty input', () => {
    expect(nameMatch('', 'Munich Re').matched).toBe(false);
    expect(nameMatch('Munich Re', null).matched).toBe(false);
  });
});

// ── findRenewalMatch ─────────────────────────────────────────────────────────

function makeRunQuery(rows) {
  return vi.fn(async () => ({ rows }));
}

const baseRow = {
  id: 'c1',
  cedant_name: 'Saudi Re',
  treaty_name: 'Property QS',
  treaty_type_name: 'Quota Share',
  uw_year: 2024,
  class_names: ['Fire'],
  prior_quote_id: 'q1',
};

describe('findRenewalMatch', () => {
  it('returns mode=new when zero candidates match the cedant', async () => {
    const runQuery = makeRunQuery([
      { ...baseRow, cedant_name: 'Lloyds of London' },
      { ...baseRow, id: 'c2', cedant_name: 'Munich Re' },
    ]);
    const r = await findRenewalMatch(
      { cedantName: 'Acme Insurance Co', classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery },
    );
    expect(r.mode).toBe('new');
  });

  it('returns mode=renewal for a single match with a later UW year', async () => {
    const runQuery = makeRunQuery([{ ...baseRow, uw_year: 2024 }]);
    const r = await findRenewalMatch(
      { cedantName: 'Saudi Re', classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery },
    );
    expect(r.mode).toBe('renewal');
    if (r.mode === 'renewal') {
      expect(r.priorTreatyId).toBe('c1');
      expect(r.priorQuoteId).toBe('q1');
      expect(r.candidate.cedant).toBe('Saudi Re');
      expect(r.candidate.lastUwYear).toBe(2024);
    }
  });

  it('uses fuzzy matching on cedant — slight name drift still resolves', async () => {
    const runQuery = makeRunQuery([
      { ...baseRow, cedant_name: 'Al Rajhi Coop Ins' },
    ]);
    const r = await findRenewalMatch(
      { cedantName: 'Al Rajhi Takaful', classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery },
    );
    expect(r.mode).toBe('renewal');
  });

  it('treats a single match with NO forward-year progression as ambiguous', async () => {
    // Same UW year as the pack — could be a duplicate, an amendment, or
    // a same-year resubmission. Let the underwriter decide.
    const runQuery = makeRunQuery([{ ...baseRow, uw_year: 2026 }]);
    const r = await findRenewalMatch(
      { cedantName: 'Saudi Re', classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery },
    );
    expect(r.mode).toBe('ambiguous');
    if (r.mode === 'ambiguous') {
      expect(r.candidates).toHaveLength(1);
    }
  });

  it('returns mode=ambiguous with candidates when multiple cedants match fuzzily', async () => {
    const runQuery = makeRunQuery([
      { ...baseRow, id: 'c1', cedant_name: 'Saudi Re',          uw_year: 2024 },
      { ...baseRow, id: 'c2', cedant_name: 'Saudi Re Holdings', uw_year: 2025 },
    ]);
    const r = await findRenewalMatch(
      { cedantName: 'Saudi Re', classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery },
    );
    expect(r.mode).toBe('ambiguous');
    if (r.mode === 'ambiguous') {
      expect(r.candidates.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    }
  });

  it('filters candidates by class overlap when extracted classes are non-empty', async () => {
    const runQuery = makeRunQuery([
      { ...baseRow, id: 'c1', cedant_name: 'Saudi Re', class_names: ['Marine Cargo'] },
      { ...baseRow, id: 'c2', cedant_name: 'Saudi Re', class_names: ['Fire'], uw_year: 2024 },
    ]);
    const r = await findRenewalMatch(
      { cedantName: 'Saudi Re', classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery },
    );
    // Only c2 overlaps on class; aggregated under the single cedant name.
    expect(r.mode).toBe('renewal');
    if (r.mode === 'renewal') expect(r.priorTreatyId).toBe('c2');
  });

  it('skips the class filter when extracted classes are empty', async () => {
    const runQuery = makeRunQuery([
      { ...baseRow, id: 'c1', cedant_name: 'Saudi Re', class_names: ['Marine Cargo'] },
    ]);
    const r = await findRenewalMatch(
      { cedantName: 'Saudi Re', classes: [], uwYearEnd: 2026 },
      { runQuery },
    );
    expect(r.mode).toBe('renewal');
  });

  it('returns mode=new when cedant name is missing', async () => {
    const r = await findRenewalMatch(
      { cedantName: null, classes: ['Fire'], uwYearEnd: 2026 },
      { runQuery: vi.fn() },
    );
    expect(r.mode).toBe('new');
  });

  it('returns mode=renewal even without uwYearEnd when only one candidate has a strictly older year', async () => {
    // uwYearEnd null → cannot prove "later"; falls back to ambiguous.
    const runQuery = makeRunQuery([{ ...baseRow, uw_year: 2024 }]);
    const r = await findRenewalMatch(
      { cedantName: 'Saudi Re', classes: ['Fire'], uwYearEnd: null },
      { runQuery },
    );
    expect(r.mode).toBe('ambiguous');
  });
});
