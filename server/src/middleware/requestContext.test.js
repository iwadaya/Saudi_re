// Authentication middleware: identity from a verified token (role/level from
// the DB), the ALLOW_DEMO_AUTH header fallback, and anonymous-by-default with
// spoofed x-user-* headers granting NOTHING.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { authenticate, requireAuth, requireRole, requireMinLevel } = await import('./requestContext.js');
const { signAuthToken, verifyAuthToken } = await import('../lib/authToken.js');

// Minimal Express-like req with header() lookup (case-insensitive).
function makeReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, header: (n) => lower[String(n).toLowerCase()] };
}
function makeRes() {
  return { statusCode: 200, body: null, locals: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

beforeEach(() => { poolMock.query.mockReset(); process.env.ALLOW_DEMO_AUTH = 'true'; });
afterEach(() => { delete process.env.ALLOW_DEMO_AUTH; });

describe('authToken', () => {
  it('round-trips a token', () => {
    const t = signAuthToken({ sub: 'u-1' });
    expect(verifyAuthToken(t)).toMatchObject({ sub: 'u-1' });
  });
  it('rejects a tampered token', () => {
    const t = signAuthToken({ sub: 'u-1' });
    expect(verifyAuthToken(t.slice(0, -2) + 'xx')).toBeNull();
  });
  it('rejects an expired token', () => {
    expect(verifyAuthToken(signAuthToken({ sub: 'u-1' }, -10))).toBeNull();
  });
});

describe('authenticate — token path (DB is source of truth)', () => {
  it('reads role/level FRESH from the DB, ignoring any spoofed header', async () => {
    poolMock.query.mockResolvedValue({ rows: [{
      user_id: 'u-cu', display_name: 'Chief', role_code: 'CU', hierarchy_level: 2,
      effective_limit_usd: null, restricted_cob_ids: [], treaty_type_scope: 'BOTH',
    }] });
    const token = signAuthToken({ sub: 'u-cu' });
    const req = makeReq({ authorization: `Bearer ${token}`, 'x-user-role': 'CE', 'x-user-level': '1' }); // spoof CE
    const next = vi.fn();
    await authenticate(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, source: 'token' });
  });

  it('an unknown/inactive subject → anonymous when demo auth is off', async () => {
    delete process.env.ALLOW_DEMO_AUTH;
    poolMock.query.mockResolvedValue({ rows: [] });
    const req = makeReq({ authorization: `Bearer ${signAuthToken({ sub: 'ghost' })}` });
    await authenticate(req, makeRes(), vi.fn());
    expect(req.user).toBeNull();
  });
});

describe('authenticate — demo + anonymous', () => {
  it('with ALLOW_DEMO_AUTH=true, a valid x-user-role header authenticates', async () => {
    const req = makeReq({ 'x-user-role': 'CU', 'x-user-id': 'u-x', 'x-user-level': '2' });
    await authenticate(req, makeRes(), vi.fn());
    expect(req.user).toMatchObject({ roleCode: 'CU', hierarchyLevel: 2, source: 'demo-header' });
    expect(poolMock.query).not.toHaveBeenCalled(); // no token → no DB hit
  });

  it('with ALLOW_DEMO_AUTH unset, spoofed x-user-* headers grant NOTHING (anonymous)', async () => {
    delete process.env.ALLOW_DEMO_AUTH;
    const req = makeReq({ 'x-user-role': 'CE', 'x-user-id': 'attacker', 'x-user-level': '1' });
    await authenticate(req, makeRes(), vi.fn());
    expect(req.user).toBeNull();
  });
});

describe('requireMinLevel / requireRole (verified req.user only)', () => {
  it('requireMinLevel(2): an Underwriter (level 5) is 403, a CU (level 2) passes', () => {
    const uw = makeRes(); const uwNext = vi.fn();
    requireMinLevel(2)({ user: { hierarchyLevel: 5, roleCode: 'TUW' } }, uw, uwNext);
    expect(uwNext).not.toHaveBeenCalled();
    expect(uw.statusCode).toBe(403);
    expect(uw.body).toMatchObject({ code: 'FORBIDDEN' });

    const cuNext = vi.fn();
    requireMinLevel(2)({ user: { hierarchyLevel: 2, roleCode: 'CU' } }, makeRes(), cuNext);
    expect(cuNext).toHaveBeenCalled();
  });

  it('requireRole: only listed roles pass; anonymous is 401', () => {
    const okNext = vi.fn();
    requireRole('CE', 'CU')({ user: { roleCode: 'CE' } }, makeRes(), okNext);
    expect(okNext).toHaveBeenCalled();

    const noRes = makeRes(); const noNext = vi.fn();
    requireRole('CE', 'CU')({ user: { roleCode: 'TUW' } }, noRes, noNext);
    expect(noNext).not.toHaveBeenCalled();
    expect(noRes.statusCode).toBe(403);

    const anonRes = makeRes();
    requireRole('CU')({ user: null }, anonRes, vi.fn());
    expect(anonRes.statusCode).toBe(401);
  });
});

describe('requireAuth', () => {
  it('passes through when req.user is set', () => {
    const next = vi.fn();
    requireAuth({ user: { userId: 'u' } }, makeRes(), next);
    expect(next).toHaveBeenCalled();
  });
  it('401s when anonymous (the CE-spoof curl no longer works)', () => {
    const res = makeRes(); const next = vi.fn();
    requireAuth({ user: null }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
