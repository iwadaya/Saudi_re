// Unit tests for quoteWorkflow.js:
//   • parseQuoteLinePct — the quote-side twin of parseOfferLinePct. Regression
//     focus: an NP per-layer line_pct map must average 0% layers IN (they were
//     dropped by an `n > 0` filter before, which biased the written line upward
//     and silently discarded legitimate 0% layers).
//   • submitQuoteForApprovalAction nominee validation — payload.approver used to
//     be stored with ZERO checks (even a bogus UUID), letting the submitter of a
//     reassigned quote nominate themself and self-approve. The pg pool is
//     mocked with an SQL-text dispatcher for these.

import { describe, it, expect, vi } from 'vitest';

const { poolMock } = vi.hoisted(() => {
  const poolMock = { query: vi.fn(async () => ({ rows: [] })) };
  poolMock.connect = async () => ({ query: (...a) => poolMock.query(...a), release: () => {} });
  return { poolMock };
});
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { parseQuoteLinePct, submitQuoteForApprovalAction } = await import('./quoteWorkflow.js');

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

describe('submitQuoteForApprovalAction — nominee validation', () => {
  const actor = { actorUserId: 'u-sub', actorName: 'Submitter', actorRole: 'UW' };

  /** SQL-text dispatcher: quote row (DRAFT), nominee mandates by user_id. */
  const mockDb = (cfg = {}) => vi.fn(async (sql, params = []) => {
    const s = String(sql);
    const isSelect = /^\s*SELECT/i.test(s);
    if (isSelect && s.includes('v_user_mandate') && s.includes('user_id=$1')) {
      const m = cfg.mandates?.[String(params[0])];
      return { rows: m ? [m] : [] };
    }
    if (isSelect && /SELECT\s+status\s+FROM\s+public\.quote/i.test(s)) return { rows: [{ status: 'DRAFT' }] };
    return { rows: [] };
  });

  const mandate = (user_id, role_code, hierarchy_level) => ({
    user_id, role_code, role_name: role_code, hierarchy_level,
    effective_limit_usd: null, restricted_cob_ids: [], treaty_type_scope: 'BOTH', is_active: true,
  });

  it('403s self-nomination (the submitter cannot be their own approver)', async () => {
    poolMock.query = mockDb({ mandates: { 'u-sub': mandate('u-sub', 'UW', 4) } });
    await expect(submitQuoteForApprovalAction('q1', actor, { approver: 'u-sub', written_line_pct: 30 }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('400s a nominee that does not exist (bogus UUID no longer accepted)', async () => {
    poolMock.query = mockDb({});
    await expect(submitQuoteForApprovalAction('q1', actor, { approver: 'u-ghost', written_line_pct: 30 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('400s a nominee without approval authority (Analyst, level 5)', async () => {
    poolMock.query = mockDb({ mandates: { 'u-an': mandate('u-an', 'AN', 5) } });
    await expect(submitQuoteForApprovalAction('q1', actor, { approver: 'u-an', written_line_pct: 30 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('accepts a valid senior nominee and records them as next_approver', async () => {
    poolMock.query = mockDb({ mandates: { 'u-cu': mandate('u-cu', 'CU', 2) } });
    const r = await submitQuoteForApprovalAction('q1', actor, { approver: 'u-cu', written_line_pct: 30 });
    expect(r).toMatchObject({ status: 'AWAITING_APPROVAL', next_approver: 'u-cu', written_line_pct: 30 });
  });

  it('still submits with no nominee at all (approver stays null)', async () => {
    poolMock.query = mockDb({});
    const r = await submitQuoteForApprovalAction('q1', actor, { written_line_pct: 30 });
    expect(r).toMatchObject({ status: 'AWAITING_APPROVAL', next_approver: null });
  });
});
