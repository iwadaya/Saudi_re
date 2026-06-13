// Unit tests for edit-locking enforcement (services/permissions.js) and the
// canEdit annotation on listContractsWithOwnership. The pool is mocked so the
// rules are exercised without a database.
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
  if (sql.includes('FROM public.uw_user u JOIN public.uw_role r')) {
    return Promise.resolve({ rows: scenario.levelRows ?? [] });
  }
  return Promise.resolve({ rows: [] });
}

beforeEach(() => { scenario = {}; poolMock.query.mockReset(); poolMock.query.mockImplementation(fakeQuery); });

describe('computeEditPermission (pure rule)', () => {
  it('owner can edit their own item', () => {
    expect(computeEditPermission({ requesterId: 'A', requesterLevel: 4, assignedToUserId: 'A', ownerLevel: 4 }))
      .toEqual({ canEdit: true, isOwner: true, reason: 'OWNER' });
  });
  it('unassigned item is claim-to-edit', () => {
    expect(computeEditPermission({ requesterId: 'B', requesterLevel: 5, assignedToUserId: null, ownerLevel: null }))
      .toEqual({ canEdit: true, isOwner: false, reason: 'UNASSIGNED' });
  });
  it('a user AT the owner level (non-owner) may edit', () => {
    expect(computeEditPermission({ requesterId: 'B', requesterLevel: 4, assignedToUserId: 'A', ownerLevel: 4 }))
      .toEqual({ canEdit: true, isOwner: false, reason: 'AT_OR_ABOVE_OWNER' });
  });
  it('a higher-authority user (lower level number) may edit a subordinate item', () => {
    expect(computeEditPermission({ requesterId: 'C', requesterLevel: 2, assignedToUserId: 'A', ownerLevel: 4 }))
      .toEqual({ canEdit: true, isOwner: false, reason: 'AT_OR_ABOVE_OWNER' });
  });
  it('a lower-authority colleague (higher level number) is read-only', () => {
    expect(computeEditPermission({ requesterId: 'B', requesterLevel: 5, assignedToUserId: 'A', ownerLevel: 4 }))
      .toEqual({ canEdit: false, isOwner: false, reason: 'READ_ONLY_NOT_OWNER' });
  });
});

describe('assertCanEdit (route guard)', () => {
  const reqAs = (userId, hierarchyLevel) => ({ user: { userId, hierarchyLevel } });
  const ownedBy = (userId, ownerLevel) => { scenario.ownershipRows = [{ assigned_to_user_id: userId, owner_level: ownerLevel, assigned_to_name: 'Owner' }]; };

  it('owner editing own treaty resolves (200)', async () => {
    ownedBy('A', 4);
    const perm = await assertCanEdit(reqAs('A', 4), 'CONTRACT', 'c1');
    expect(perm).toMatchObject({ canEdit: true, isOwner: true });
  });

  it('non-owner subordinate (lower authority) → 403 READ_ONLY', async () => {
    ownedBy('A', 2); // owner is a CU (level 2)
    await expect(assertCanEdit(reqAs('B', 5), 'CONTRACT', 'c1'))
      .rejects.toMatchObject({ status: 403, code: 'READ_ONLY' });
  });

  it('higher-level user editing a subordinate treaty resolves (200)', async () => {
    ownedBy('A', 5); // owner is a TUW (level 5)
    const perm = await assertCanEdit(reqAs('C', 2), 'CONTRACT', 'c1'); // CU
    expect(perm.canEdit).toBe(true);
  });

  it('unassigned treaty is editable (claim-to-edit)', async () => {
    scenario.ownershipRows = [{ assigned_to_user_id: null, owner_level: null, assigned_to_name: null }];
    const perm = await assertCanEdit(reqAs('B', 5), 'CONTRACT', 'c1');
    expect(perm).toMatchObject({ canEdit: true, isOwner: false, reason: 'UNASSIGNED' });
  });

  it('missing entity → 404', async () => {
    scenario.ownershipRows = [];
    await expect(assertCanEdit(reqAs('A', 4), 'CONTRACT', 'missing'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('resolves the requester level from x-user-level header when req.user is absent', async () => {
    ownedBy('A', 4);
    const req = { headers: { 'x-user-id': 'B', 'x-user-level': '5' } };
    await expect(assertCanEdit(req, 'CONTRACT', 'c1')).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
});

describe('listContractsWithOwnership — canEdit annotation', () => {
  it("scope='all' returns canEdit=false on rows above me, true on my own + subordinates'", async () => {
    scenario.listRows = [
      { id: 'c1', assigned_to_user_id: 'A', ownerLevel: 4 }, // mine
      { id: 'c2', assigned_to_user_id: 'B', ownerLevel: 5 }, // subordinate
      { id: 'c3', assigned_to_user_id: 'C', ownerLevel: 2 }, // above me
      { id: 'c4', assigned_to_user_id: null, ownerLevel: null }, // unassigned
    ];
    const rows = await listContractsWithOwnership({ scope: 'all', requesterId: 'A', requesterLevel: 4 });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.c1).toMatchObject({ canEdit: true, isOwner: true });
    expect(byId.c2).toMatchObject({ canEdit: true, isOwner: false });
    expect(byId.c3).toMatchObject({ canEdit: false, isOwner: false });
    expect(byId.c4).toMatchObject({ canEdit: true, isOwner: false });
  });
});
