// Tests for verified-identity audit actor resolution (services/audit.js).
//
// Audit labels must come from the authenticated user, looked up server-side —
// never from client-supplied x-user-name / x-user-role headers or a body
// `_actor`. These cover an authenticated write and a system (anonymous) write,
// and prove that spoofing x-user-name changes nothing in the trail.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { resolveAuditActor } = await import('./audit.js');
// pricingHelpers.resolveActor must be the very same verified resolver.
const { resolveActor } = await import('../modules/pricing/services/pricingHelpers.js');

// Server-side directory: the only source of truth for a user's display name/role.
const DIRECTORY = {
  'u-cu': { display_name: 'Chief Underwriting Officer', role_code: 'CU' },
};

beforeEach(() => {
  poolMock.query = vi.fn(async (_sql, params) => {
    const row = DIRECTORY[params?.[0]];
    return { rows: row ? [row] : [] };
  });
});

describe('resolveAuditActor — audit identity from verified req.user only', () => {
  it('authenticated write records the verified id + DB-resolved name (spoofed headers ignored)', async () => {
    const req = {
      user: { userId: 'u-cu', displayName: 'header-derived-name', role: 'CE' },
      headers: { 'x-user-name': 'Mallory The Spoofer', 'x-user-role': 'CE', 'x-user-id': 'u-evil' },
    };
    const actor = await resolveAuditActor(req);
    expect(actor).toEqual({ actorUserId: 'u-cu', actorName: 'Chief Underwriting Officer', actorRole: 'CU' });
    expect(actor.actorName).not.toBe('Mallory The Spoofer');
    expect(actor.actorRole).not.toBe('CE');
  });

  it('spoofing x-user-name changes nothing — the same id always resolves to the same trail name', async () => {
    const a = await resolveAuditActor({ user: { userId: 'u-cu' }, headers: { 'x-user-name': 'Name A' } });
    const b = await resolveAuditActor({ user: { userId: 'u-cu' }, headers: { 'x-user-name': 'Name B' } });
    expect(a.actorName).toBe('Chief Underwriting Officer');
    expect(b.actorName).toBe('Chief Underwriting Officer');
    expect(a).toEqual(b);
  });

  it('system write (no verified user) → SYSTEM, never a client-supplied string', async () => {
    const actor = await resolveAuditActor({ headers: { 'x-user-name': 'Mallory', 'x-user-role': 'CE' } });
    expect(actor).toEqual({ actorUserId: null, actorName: 'SYSTEM', actorRole: null });
  });

  it('empty request resolves to SYSTEM', async () => {
    expect(await resolveAuditActor({})).toEqual({ actorUserId: null, actorName: 'SYSTEM', actorRole: null });
    expect(await resolveAuditActor(undefined)).toEqual({ actorUserId: null, actorName: 'SYSTEM', actorRole: null });
  });

  it('verified id with no directory profile → records the id, name SYSTEM (never the header)', async () => {
    const actor = await resolveAuditActor({ user: { userId: 'u-ghost' }, headers: { 'x-user-name': 'Mallory' } });
    expect(actor).toEqual({ actorUserId: 'u-ghost', actorName: 'SYSTEM', actorRole: null });
  });

  it('a directory lookup failure falls back to SYSTEM (id preserved), never the header', async () => {
    poolMock.query = vi.fn(async () => { throw new Error('db down'); });
    const actor = await resolveAuditActor({ user: { userId: 'u-cu' }, headers: { 'x-user-name': 'Mallory' } });
    expect(actor).toEqual({ actorUserId: 'u-cu', actorName: 'SYSTEM', actorRole: null });
  });

  it('only req.user.userId is consulted — the lookup is keyed on the verified id', async () => {
    await resolveAuditActor({ user: { userId: 'u-cu' }, headers: { 'x-user-id': 'u-evil' } });
    expect(poolMock.query).toHaveBeenCalledTimes(1);
    expect(poolMock.query.mock.calls[0][1]).toEqual(['u-cu']); // not 'u-evil'
  });
});

describe('pricingHelpers.resolveActor is the verified resolver', () => {
  it('delegates to resolveAuditActor (DB-resolved name, ignores x-user-name)', async () => {
    const actor = await resolveActor({ user: { userId: 'u-cu' }, headers: { 'x-user-name': 'Mallory' } });
    expect(actor.actorUserId).toBe('u-cu');
    expect(actor.actorName).toBe('Chief Underwriting Officer');
  });

  it('no verified user → SYSTEM', async () => {
    const actor = await resolveActor({ headers: { 'x-user-name': 'Mallory' } });
    expect(actor).toEqual({ actorUserId: null, actorName: 'SYSTEM', actorRole: null });
  });
});
