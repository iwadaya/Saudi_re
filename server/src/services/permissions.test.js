// Unit tests for assignee-only edit-locking (services/permissions.js) and the
// canEdit annotation on listContractsWithOwnership. Editing is allowed ONLY for
// the current assignee — hierarchy level grants no edit rights (it governs
// allocate/reassign in assignments.js). The pool is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));
vi.mock('./audit.js', () => ({ logAudit: vi.fn(() => Promise.resolve()) }));

const { computeEditPermission, assertCanEdit } = await import('./permissions.js');
const { listContractsWithOwnership } = await import('./assignments.js');

let scenario = {};
function fakeQuery(sql) {
  if (sql.includes('record_type')) return Promise.resolve({ rows: scenario.listRows ?? [] });
  if (sql.includes('owner_level') || sql.includes('FROM public.contract e')) {
    return Promise.resolve({ rows: scenario.ownershipRows ?? [] });
  }
  return Promise.resolve({ rows: [] });
}

beforeEach(() => { scenario = {}; poolMock.query.mockReset(); poolMock.query.mockImplementation(fakeQuery); });

describe('computeEditPermission (assignee-only)', () => {
  it('the assignee can edit', () => {
    expect(computeEditPermission({ requesterId: 'A', assignedToUserId: 'A' }))
      .toEqual({ canEdit: true, isOwner: true, reason: null });
  });
  it('a non-assignee cannot edit (no reason to read seniority)', () => {
    expect(computeEditPermission({ requesterId: 'B', assignedToUserId: 'A' }))
      .toEqual({ canEdit: false, isOwner: false, reason: 'READ_ONLY_NOT_ASSIGNEE' });
  });
  it('an unassigned treaty is read-only until claimed', () => {
    expect(computeEditPermission({ requesterId: 'B', assignedToUserId: null }))
      .toEqual({ canEdit: false, isOwner: false, reason: 'READ_ONLY_NOT_ASSIGNEE' });
  });
  it('a null requester never matches', () => {
    expect(computeEditPermission({ requesterId: null, assignedToUserId: null }).canEdit).toBe(false);
  });
});

describe('assertCanEdit (route guard)', () => {
  const reqAs = (userId) => ({ user: { userId } });
  const ownedBy = (userId) => { scenario.ownershipRows = [{ assigned_to_user_id: userId, assigned_to_name: 'Owner' }]; };

  it('the assignee editing their own treaty resolves (200)', async () => {
    ownedBy('A');
    const perm = await assertCanEdit(reqAs('A'), 'CONTRACT', 'c1');
    expect(perm).toMatchObject({ canEdit: true, isOwner: true });
  });

  it('a non-assignee peer → 403 READ_ONLY', async () => {
    ownedBy('A');
    await expect(assertCanEdit(reqAs('B'), 'CONTRACT', 'c1'))
      .rejects.toMatchObject({ status: 403, code: 'READ_ONLY' });
  });

  it('a senior (CU/CE) who is NOT the assignee is also 403 — seniority grants no edit', async () => {
    ownedBy('A');
    const seniorReq = { user: { userId: 'CU-user' }, headers: { 'x-user-level': '2' } };
    await expect(assertCanEdit(seniorReq, 'CONTRACT', 'c1'))
      .rejects.toMatchObject({ status: 403, code: 'READ_ONLY' });
  });

  it('an unassigned treaty is read-only (403) until claimed', async () => {
    scenario.ownershipRows = [{ assigned_to_user_id: null, assigned_to_name: null }];
    await expect(assertCanEdit(reqAs('B'), 'CONTRACT', 'c1'))
      .rejects.toMatchObject({ status: 403, code: 'READ_ONLY' });
  });

  it('missing entity → 404', async () => {
    scenario.ownershipRows = [];
    await expect(assertCanEdit(reqAs('A'), 'CONTRACT', 'missing'))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('listContractsWithOwnership — canEdit annotation', () => {
  it("scope='all' returns canEdit=true ONLY on the requester's own rows", async () => {
    scenario.listRows = [
      { id: 'c1', assigned_to_user_id: 'A' },   // mine
      { id: 'c2', assigned_to_user_id: 'B' },   // someone else's
      { id: 'c3', assigned_to_user_id: null },  // unassigned
    ];
    const rows = await listContractsWithOwnership({ scope: 'all', requesterId: 'A' });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.c1).toMatchObject({ canEdit: true, isOwner: true });
    expect(byId.c2).toMatchObject({ canEdit: false, isOwner: false });
    expect(byId.c3).toMatchObject({ canEdit: false, isOwner: false });
  });
});
