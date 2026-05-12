import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../db/pool.js';
import {
  normaliseCategory,
  loadTreatyCategory,
  requireTreatyCategory,
  assertBodyCategoryMatches,
} from './treatyCategoryGuard.js';

function mkRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

describe('normaliseCategory', () => {
  it('maps known prop strings to PROPORTIONAL', () => {
    expect(normaliseCategory('PROPORTIONAL')).toBe('PROPORTIONAL');
    expect(normaliseCategory('proportional')).toBe('PROPORTIONAL');
    expect(normaliseCategory(' Proportional ')).toBe('PROPORTIONAL');
  });

  it('maps known NP strings to NON_PROPORTIONAL', () => {
    expect(normaliseCategory('NON_PROPORTIONAL')).toBe('NON_PROPORTIONAL');
    expect(normaliseCategory('non-proportional')).toBe('NON_PROPORTIONAL');
    expect(normaliseCategory('Non Prop')).toBe('NON_PROPORTIONAL');
  });

  it('returns null for empty / unknown values', () => {
    expect(normaliseCategory(null)).toBeNull();
    expect(normaliseCategory('')).toBeNull();
    expect(normaliseCategory('FAC')).toBeNull();
  });
});

describe('loadTreatyCategory', () => {
  beforeEach(() => { pool.query.mockReset(); });

  it('400s when contract id is missing', async () => {
    const req = { params: {} };
    const res = mkRes();
    const next = vi.fn();
    await loadTreatyCategory(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('MISSING_CONTRACT_ID');
    expect(next).not.toHaveBeenCalled();
  });

  it('404s when contract not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const req = { params: { id: 'abc' } };
    const res = mkRes();
    const next = vi.fn();
    await loadTreatyCategory(req, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches treatyContext on success and calls next', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ contract_id: 'abc', uw_status: 'DRAFT', treaty_category: 'PROPORTIONAL' }],
    });
    const req = { params: { id: 'abc' } };
    const res = mkRes();
    const next = vi.fn();
    await loadTreatyCategory(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.treatyContext).toEqual({
      contractId: 'abc',
      treatyCategory: 'PROPORTIONAL',
      uwStatus: 'DRAFT',
      isNp: false,
      isProp: true,
    });
  });

  it('normalises NON-PROPORTIONAL category', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ contract_id: 'abc', uw_status: 'DRAFT', treaty_category: 'NON_PROPORTIONAL' }],
    });
    const req = { params: { id: 'abc' } };
    const res = mkRes();
    const next = vi.fn();
    await loadTreatyCategory(req, res, next);
    expect(req.treatyContext.isNp).toBe(true);
    expect(req.treatyContext.isProp).toBe(false);
  });
});

describe('requireTreatyCategory', () => {
  it('throws at boot when given a bad category', () => {
    expect(() => requireTreatyCategory('FAC')).toThrow();
  });

  it('500s when called without loadTreatyCategory upstream', () => {
    const mw = requireTreatyCategory('PROPORTIONAL');
    const req = {}; const res = mkRes(); const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('409s when category mismatches', () => {
    const mw = requireTreatyCategory('PROPORTIONAL');
    const req = { treatyContext: { contractId: 'x', treatyCategory: 'NON_PROPORTIONAL' } };
    const res = mkRes(); const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TREATY_CATEGORY_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes when category matches', () => {
    const mw = requireTreatyCategory('PROPORTIONAL');
    const req = { treatyContext: { contractId: 'x', treatyCategory: 'PROPORTIONAL' } };
    const res = mkRes(); const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('409s when treaty category is unknown', () => {
    const mw = requireTreatyCategory('PROPORTIONAL');
    const req = { treatyContext: { contractId: 'x', treatyCategory: null } };
    const res = mkRes(); const next = vi.fn();
    mw(req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TREATY_CATEGORY_UNKNOWN');
  });
});

describe('assertBodyCategoryMatches', () => {
  it('passes through when body has no declared category', () => {
    const req = { body: {}, treatyContext: { treatyCategory: 'PROPORTIONAL' } };
    const res = mkRes(); const next = vi.fn();
    assertBodyCategoryMatches(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes when declared matches actual', () => {
    const req = {
      body: { treaty_category: 'proportional' },
      treatyContext: { contractId: 'x', treatyCategory: 'PROPORTIONAL' },
    };
    const res = mkRes(); const next = vi.fn();
    assertBodyCategoryMatches(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('409s when declared mismatches actual', () => {
    const req = {
      body: { treaty_category: 'PROPORTIONAL' },
      treatyContext: { contractId: 'x', treatyCategory: 'NON_PROPORTIONAL' },
    };
    const res = mkRes(); const next = vi.fn();
    assertBodyCategoryMatches(req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TREATY_CATEGORY_MISMATCH');
    expect(next).not.toHaveBeenCalled();
  });

  it('500s when run without loadTreatyCategory upstream', () => {
    const req = { body: { treaty_category: 'PROPORTIONAL' } };
    const res = mkRes(); const next = vi.fn();
    assertBodyCategoryMatches(req, res, next);
    expect(res.statusCode).toBe(500);
  });
});
