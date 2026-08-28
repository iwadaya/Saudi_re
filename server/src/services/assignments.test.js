// server/src/services/assignments.test.js
// reassign() policy guards: DRAFT-only (matching allocate/selfAssign) and the
// hierarchy check — against the current owner when assigned, against the NEW
// owner when the item is unassigned. Pool is mocked; no DB.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// userId → hierarchy_level fixture the fake pool serves for getHierarchyLevel.
const LEVELS = {
  'ce-1': 1, 'cu-2': 2, 'td-3': 3, 'tm-4': 4, 'tuw-5': 5, 'tuw-6': 5,
};

// Per-test entity row served for the ownership SELECT.
let entityRow = null;
const queryLog = [];

function fakeQuery(sql, params) {
  queryLog.push({ sql, params });
  if (/SELECT assigned_to_user_id, uw_status FROM/.test(sql)) {
    return Promise.resolve({ rows: entityRow ? [entityRow] : [] });
  }
  if (/hierarchy_level FROM public\.uw_user/.test(sql)) {
    const lvl = LEVELS[params?.[0]];
    return Promise.resolve({ rows: lvl == null ? [] : [{ hierarchy_level: lvl }] });
  }
  if (/^UPDATE /.test(sql.trim())) return Promise.resolve({ rows: [], rowCount: 1 });
  if (/INSERT INTO public\.contract_assignment_history/.test(sql)) return Promise.resolve({ rows: [] });
  return Promise.resolve({ rows: [] });
}

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn((sql, params) => fakeQuery(sql, params)) },
}));
vi.mock('./audit.js', () => ({ logAudit: vi.fn(() => Promise.resolve()) }));

const { reassign } = await import('./assignments.js');

const updated = () => queryLog.some((q) => /^UPDATE /.test(q.sql.trim()));

beforeEach(() => {
  entityRow = null;
  queryLog.length = 0;
});

describe('reassign: DRAFT-only (matches allocate/selfAssign policy)', () => {
  it('rejects reassigning a SIGNED item — even by a senior over a junior owner', async () => {
    entityRow = { assigned_to_user_id: 'tuw-5', uw_status: 'SIGNED' };
    await expect(reassign({
      entityType: 'CONTRACT', entityId: 'c1', reassignedBy: 'cu-2', newOwnerId: 'tuw-6',
    })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/Only DRAFT items/) });
    expect(updated()).toBe(false);
  });

  it('rejects seizing an unassigned non-DRAFT item', async () => {
    entityRow = { assigned_to_user_id: null, uw_status: 'AWAITING_APPROVAL' };
    await expect(reassign({
      entityType: 'QUOTE', entityId: 'q1', reassignedBy: 'tuw-5', newOwnerId: 'tuw-5',
    })).rejects.toMatchObject({ status: 403 });
    expect(updated()).toBe(false);
  });

  it('treats a NULL uw_status as DRAFT (legacy rows stay reassignable)', async () => {
    entityRow = { assigned_to_user_id: 'tuw-5', uw_status: null };
    const out = await reassign({
      entityType: 'CONTRACT', entityId: 'c1', reassignedBy: 'cu-2', newOwnerId: 'tuw-6',
    });
    expect(out).toEqual({ assigned: true, from: 'tuw-5', to: 'tuw-6' });
  });
});

describe('reassign: hierarchy checks', () => {
  it('rejects a junior reassigning a senior colleague\'s DRAFT', async () => {
    entityRow = { assigned_to_user_id: 'cu-2', uw_status: 'DRAFT' };
    await expect(reassign({
      entityType: 'CONTRACT', entityId: 'c1', reassignedBy: 'tuw-5', newOwnerId: 'tuw-6',
    })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/level or below/) });
    expect(updated()).toBe(false);
  });

  it('allows a senior reassigning a junior colleague\'s DRAFT', async () => {
    entityRow = { assigned_to_user_id: 'tuw-5', uw_status: 'DRAFT' };
    const out = await reassign({
      entityType: 'CONTRACT', entityId: 'c1', reassignedBy: 'td-3', newOwnerId: 'tm-4',
    });
    expect(out.assigned).toBe(true);
    expect(updated()).toBe(true);
  });

  it('UNASSIGNED item: the hierarchy check applies to the NEW owner (junior cannot hand work up)', async () => {
    entityRow = { assigned_to_user_id: null, uw_status: 'DRAFT' };
    await expect(reassign({
      entityType: 'QUOTE', entityId: 'q1', reassignedBy: 'tuw-5', newOwnerId: 'cu-2',
    })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/level or below/) });
    expect(updated()).toBe(false);
  });

  it('UNASSIGNED item: a peer-level handoff is allowed', async () => {
    entityRow = { assigned_to_user_id: null, uw_status: 'DRAFT' };
    const out = await reassign({
      entityType: 'QUOTE', entityId: 'q1', reassignedBy: 'tuw-5', newOwnerId: 'tuw-6',
    });
    expect(out).toEqual({ assigned: true, from: null, to: 'tuw-6' });
  });
});
