// Unit tests for the formal read-visibility policy (services/readPolicy.js).
// The four levels nest assigned ⊆ team ⊆ office ⊆ all. The pool is mocked so we
// can drive each policy branch deterministically.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const {
  readPolicyLevel, resolveReadScope, rowInReadScope, readScopeCondition,
  readableContractIds, intersectContractScopes, READ_POLICY_LEVELS, DEFAULT_READ_POLICY,
} = await import('./readPolicy.js');

const ME = '00000000-0000-0000-0000-0000000000aa';
const reqAs = (userId) => ({ user: { userId } });

// Route the mocked pool by SQL fragment so each policy branch is deterministic.
let world = {};
function fakeQuery(sql) {
  if (sql.includes('r.hierarchy_level') && sql.includes('WHERE u.user_id')) {
    return Promise.resolve({ rows: world.requesterCtx ? [world.requesterCtx] : [] });
  }
  if (sql.includes('FROM public.uw_user WHERE office')) {
    return Promise.resolve({ rows: world.officeUsers ?? [] });
  }
  if (sql.includes('>= COALESCE($2, 99)')) {
    return Promise.resolve({ rows: world.teamUsers ?? [] });
  }
  if (sql.includes('FROM public.contract')) {
    return Promise.resolve({ rows: world.contractRows ?? [] });
  }
  return Promise.resolve({ rows: [] });
}

beforeEach(() => { world = {}; poolMock.query.mockReset(); poolMock.query.mockImplementation(fakeQuery); delete process.env.READ_POLICY; });
afterEach(() => { delete process.env.READ_POLICY; });

describe('readPolicyLevel', () => {
  it('defaults to "all" when nothing is set', () => {
    expect(readPolicyLevel()).toBe('all');
    expect(DEFAULT_READ_POLICY).toBe('all');
  });
  it('reads READ_POLICY from the environment, case-insensitively', () => {
    process.env.READ_POLICY = 'TEAM';
    expect(readPolicyLevel()).toBe('team');
  });
  it('an explicit override beats the environment', () => {
    process.env.READ_POLICY = 'all';
    expect(readPolicyLevel('office')).toBe('office');
  });
  it('an unrecognised value fails safe to the default', () => {
    process.env.READ_POLICY = 'nonsense';
    expect(readPolicyLevel()).toBe('all');
    expect(READ_POLICY_LEVELS).toEqual(['assigned', 'team', 'office', 'all']);
  });
});

describe('resolveReadScope', () => {
  it('"all" short-circuits — no identity and no DB hit required', async () => {
    const scope = await resolveReadScope({}, { level: 'all' });
    expect(scope).toEqual({ level: 'all' });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('a restricting policy rejects an anonymous requester with 401', async () => {
    await expect(resolveReadScope({}, { level: 'assigned' }))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('"assigned" returns just the requester and never queries the org', async () => {
    const scope = await resolveReadScope(reqAs(ME), { level: 'assigned' });
    expect(scope).toEqual({ level: 'assigned', userId: ME, visibleUserIds: [ME] });
    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it('"office" returns every user sharing the requester\'s office', async () => {
    world.requesterCtx = { office: 'Riyadh', hierarchy_level: 4 };
    world.officeUsers = [{ user_id: ME }, { user_id: 'peer' }, { user_id: 'boss' }];
    const scope = await resolveReadScope(reqAs(ME), { level: 'office' });
    expect(scope.level).toBe('office');
    expect(new Set(scope.visibleUserIds)).toEqual(new Set([ME, 'peer', 'boss']));
  });

  it('"team" returns office-mates at the requester\'s level or below', async () => {
    world.requesterCtx = { office: 'Riyadh', hierarchy_level: 4 };
    world.teamUsers = [{ user_id: ME }, { user_id: 'junior' }];
    const scope = await resolveReadScope(reqAs(ME), { level: 'team' });
    expect(scope.level).toBe('team');
    expect(new Set(scope.visibleUserIds)).toEqual(new Set([ME, 'junior']));
  });

  it('a requester with no office collapses team/office to just themselves', async () => {
    world.requesterCtx = { office: null, hierarchy_level: 4 };
    const scope = await resolveReadScope(reqAs(ME), { level: 'office' });
    expect(scope.visibleUserIds).toEqual([ME]);
  });
});

describe('rowInReadScope', () => {
  const scope = { level: 'team', userId: ME, visibleUserIds: [ME, 'mate'] };
  it('"all" (or a null scope) admits every row', () => {
    expect(rowInReadScope({ level: 'all' }, { ownerId: 'anyone' })).toBe(true);
    expect(rowInReadScope(null, { ownerId: 'anyone' })).toBe(true);
  });
  it('admits a row owned by someone in the visible set', () => {
    expect(rowInReadScope(scope, { ownerId: 'mate' })).toBe(true);
  });
  it('admits a row CREATED by the requester even if owned elsewhere', () => {
    expect(rowInReadScope(scope, { ownerId: 'stranger', creatorId: ME })).toBe(true);
  });
  it('rejects a row owned and created outside the visible set', () => {
    expect(rowInReadScope(scope, { ownerId: 'stranger', creatorId: 'other' })).toBe(false);
  });
  it('an unassigned, foreign-created row is hidden', () => {
    expect(rowInReadScope(scope, { ownerId: null, creatorId: 'other' })).toBe(false);
  });
});

describe('readScopeCondition', () => {
  it('"all" adds no predicate and no parameter', () => {
    const params = [];
    expect(readScopeCondition({ level: 'all' }, { ownerCol: 'c.assigned_to_user_id', params })).toBeNull();
    expect(params).toHaveLength(0);
  });
  it('a restricting scope pushes the id array and emits an owner-OR-creator predicate', () => {
    const params = ['existing'];
    const scope = { level: 'office', userId: ME, visibleUserIds: [ME, 'mate'] };
    const cond = readScopeCondition(scope, { ownerCol: 'c.assigned_to_user_id', creatorCol: 'c.created_by_user_id', params });
    expect(cond).toBe('(c.assigned_to_user_id = ANY($2::uuid[]) OR c.created_by_user_id = ANY($2::uuid[]))');
    expect(params[1]).toEqual([ME, 'mate']);
  });
  it('omits the creator clause when no creatorCol is supplied', () => {
    const params = [];
    const cond = readScopeCondition({ level: 'assigned', visibleUserIds: [ME] }, { ownerCol: 'q.assigned_to_user_id', params });
    expect(cond).toBe('(q.assigned_to_user_id = ANY($1::uuid[]))');
  });
});

describe('readableContractIds + intersectContractScopes', () => {
  it('"all" returns null (no contract-id filter)', async () => {
    const ids = await readableContractIds(reqAs(ME), { level: 'all' });
    expect(ids).toBeNull();
  });
  it('a restricting policy returns the readable contract ids', async () => {
    world.contractRows = [{ contract_id: 'c1' }, { contract_id: 'c2' }];
    const ids = await readableContractIds(reqAs(ME), { level: 'assigned' });
    expect(ids).toEqual(['c1', 'c2']);
  });
  it('intersect treats null as unrestricted and takes the tighter set', () => {
    expect(intersectContractScopes(null, null)).toBeNull();
    expect(intersectContractScopes(null, ['a', 'b'])).toEqual(['a', 'b']);
    expect(intersectContractScopes(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(intersectContractScopes(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c']);
  });
});
