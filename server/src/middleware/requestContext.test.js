// Authentication middleware: identity from a verified token (role/level from
// the DB), the ALLOW_DEMO_AUTH header fallback, and anonymous-by-default with
// spoofed x-user-* headers granting NOTHING.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { authenticate, requireAuth, requireRole, requireMinLevel, csrfProtection } = await import('./requestContext.js');
const { signAuthToken, verifyAuthToken } = await import('../lib/authToken.js');
const { issueCsrfToken } = await import('../lib/csrf.js');

// CU row returned by loadUserFromDb's query — reused across token-path tests.
const CU_ROW = {
  user_id: 'u-cu', display_name: 'Chief', role_code: 'CU', hierarchy_level: 2,
  effective_limit_usd: null, restricted_cob_ids: [], treaty_type_scope: 'BOTH',
};

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
  it('rejects a token forged with the old hard-coded dev literal', async () => {
    const { createHmac } = await import('node:crypto');
    const body = Buffer.from(JSON.stringify({ sub: 'attacker', iat: 0, exp: 9999999999 })).toString('base64url');
    const sig = createHmac('sha256', 'dev-insecure-secret-change-me').update(body).digest('base64url');
    expect(verifyAuthToken(`${body}.${sig}`)).toBeNull();
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

  it('authenticates from the httpOnly auth_token cookie (authVia=cookie)', async () => {
    poolMock.query.mockResolvedValue({ rows: [CU_ROW] });
    const req = makeReq({ cookie: `auth_token=${signAuthToken({ sub: 'u-cu' })}` });
    const next = vi.fn();
    await authenticate(req, makeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ userId: 'u-cu', roleCode: 'CU', source: 'token' });
    expect(req.authVia).toBe('cookie');
  });

  it('in production (ALLOW_DEMO_AUTH off) a Bearer header is IGNORED — only the cookie authenticates', async () => {
    delete process.env.ALLOW_DEMO_AUTH;
    poolMock.query.mockResolvedValue({ rows: [CU_ROW] });
    const token = signAuthToken({ sub: 'u-cu' });
    // A valid Bearer header alone is no longer an auth path in prod.
    const bearerReq = makeReq({ authorization: `Bearer ${token}` });
    await authenticate(bearerReq, makeRes(), vi.fn());
    expect(bearerReq.user).toBeNull();
    expect(bearerReq.authVia).toBeNull();
    // The same token in the cookie does authenticate.
    const cookieReq = makeReq({ cookie: `auth_token=${token}` });
    await authenticate(cookieReq, makeRes(), vi.fn());
    expect(cookieReq.user).toMatchObject({ userId: 'u-cu' });
    expect(cookieReq.authVia).toBe('cookie');
  });

  it('the cookie wins over a Bearer header when both are present', async () => {
    poolMock.query.mockResolvedValue({ rows: [CU_ROW] });
    const req = makeReq({
      cookie: `auth_token=${signAuthToken({ sub: 'u-cu' })}`,
      authorization: `Bearer ${signAuthToken({ sub: 'someone-else' })}`,
    });
    await authenticate(req, makeRes(), vi.fn());
    expect(req.authVia).toBe('cookie');
    expect(req.user).toMatchObject({ userId: 'u-cu' });
  });
});

describe('csrfProtection (double-submit, cookie-auth only)', () => {
  // Build a req for the middleware: method/path/authVia + optional csrf cookie & header.
  function csrfReq({ method = 'POST', path = '/treaties', authVia = 'cookie', cookie, header }) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (header) headers['x-csrf-token'] = header;
    const req = makeReq(headers);
    req.method = method; req.path = path; req.authVia = authVia;
    return req;
  }

  it('lets safe methods through with no token', () => {
    const next = vi.fn();
    csrfProtection(csrfReq({ method: 'GET' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('403s a cookie-auth mutation with NO csrf token', () => {
    const res = makeRes(); const next = vi.fn();
    csrfProtection(csrfReq({}), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'CSRF_FAILED' });
  });

  it('passes when the header matches the cookie AND the token is validly signed', () => {
    const t = issueCsrfToken();
    const next = vi.fn();
    csrfProtection(csrfReq({ cookie: `csrf_token=${t}`, header: t }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('403s on a double-submit mismatch (header ≠ cookie)', () => {
    const res = makeRes();
    csrfProtection(csrfReq({ cookie: `csrf_token=${issueCsrfToken()}`, header: issueCsrfToken() }), res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it('403s a forged/unsigned token even when header === cookie', () => {
    const res = makeRes();
    csrfProtection(csrfReq({ cookie: 'csrf_token=forged.sig', header: 'forged.sig' }), res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it('skips CSRF for non-cookie auth (demo-header / bearer dev-test paths)', () => {
    for (const authVia of ['demo-header', 'bearer', null]) {
      const next = vi.fn();
      csrfProtection(csrfReq({ authVia }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    }
  });

  it('exempts the login + logout bootstrap routes', () => {
    for (const path of ['/auth/login', '/auth/logout']) {
      const next = vi.fn();
      csrfProtection(csrfReq({ path }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    }
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
