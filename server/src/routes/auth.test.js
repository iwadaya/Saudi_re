// server/src/routes/auth.js unit tests.
//
// Mocks the pg pool with canned, SQL-fragment-keyed responses so the real
// Express handlers run without a database. Covers the Add-user creation flow
// (scrypt password capture), login password verification (real hash + demo
// fallback), and the people-dropdown listing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const queryLog = [];
// Per-test knobs consumed by fakeQuery.
let scenario = {};

function fakeQuery(sql, params = []) {
  queryLog.push({ sql, params });

  if (sql.includes('FROM public.uw_role WHERE role_code')) {
    return Promise.resolve({ rows: scenario.roleId === null ? [] : [{ role_id: scenario.roleId || 'role-uw' }] });
  }
  if (sql.includes('SELECT 1 FROM public.uw_user WHERE username')) {
    const taken = scenario.takenUsernames || [];
    return Promise.resolve({ rows: taken.includes(params[0]) ? [{ exists: 1 }] : [] });
  }
  // A5 target-seniority lookup (getUserHierarchyLevel): the target user's level.
  if (sql.includes('SELECT r.hierarchy_level FROM public.uw_user u JOIN public.uw_role r')) {
    return Promise.resolve({ rows: scenario.targetLevel != null ? [{ hierarchy_level: scenario.targetLevel }] : [] });
  }
  // A5 role-seniority lookup (getRoleHierarchyLevel): the assigned role's level.
  if (sql.includes('SELECT hierarchy_level FROM public.uw_role WHERE role_id')) {
    return Promise.resolve({ rows: scenario.newRoleLevel != null ? [{ hierarchy_level: scenario.newRoleLevel }] : [] });
  }
  if (sql.includes('INSERT INTO public.uw_user')) {
    return Promise.resolve({ rows: [{
      user_id: 'new-user-1', username: params[0], display_name: params[1], email: params[2],
      role_id: params[3], office: params[4], password_hash: params[7], created_at: '2026-06-13T00:00:00.000Z',
    }] });
  }
  // PUT /auth/mandates upsert returns the row (RETURNING *); the default-mandate
  // insert on user-create has no RETURNING and just resolves empty.
  if (sql.includes('INSERT INTO public.user_mandate') && sql.includes('RETURNING *')) {
    return Promise.resolve({ rows: [{
      user_id: params[0], treaty_limit_usd: params[1], single_risk_limit_usd: params[2],
      limit_currency: params[3], allowed_cob_ids: params[4], restricted_cob_ids: params[5],
      allowed_country_ids: params[6], treaty_type_scope: params[7], approvals_required: params[8],
    }] });
  }
  if (sql.includes('INSERT INTO public.user_mandate')) return Promise.resolve({ rows: [] });
  // PATCH /auth/users snapshot (FOR UPDATE) + the user_mandate snapshot.
  if (sql.includes('SELECT role_id, is_active FROM public.uw_user')) {
    return Promise.resolve({ rows: scenario.userBefore ? [scenario.userBefore] : [] });
  }
  if (sql.includes('FROM public.user_mandate WHERE user_id') && sql.includes('FOR UPDATE')) {
    return Promise.resolve({ rows: scenario.mandateBefore ? [scenario.mandateBefore] : [] });
  }
  if (sql.includes('UPDATE public.uw_user SET') && sql.includes('RETURNING user_id, display_name, email, role_id, office, is_active')) {
    // PATCH /auth/users update — echo the patched columns back.
    const out = { user_id: scenario.patchId || 'u-target', display_name: 'X', email: 'x@y.z', role_id: 'role-uw', office: 'Riyadh', is_active: true, ...(scenario.userAfter || {}) };
    return Promise.resolve({ rows: [out] });
  }
  if (sql.includes('FROM public.v_user_mandate vm')) {
    return Promise.resolve({ rows: scenario.loginUser ? [scenario.loginUser] : [] });
  }
  // Name-login display-name lookup (passwordless pilot).
  if (sql.includes('lower(display_name)')) {
    return Promise.resolve({ rows: scenario.nameUser ? [scenario.nameUser] : [] });
  }
  if (sql.includes('FROM public.v_user_mandate WHERE user_id')) {
    return Promise.resolve({ rows: scenario.mandateRow ? [{ user_id: params[0], ...scenario.mandateRow }] : [] });
  }
  // GET /auth/users — matches both the authenticated (full, mandate-join) and
  // unauthenticated (minimal) projections.
  if (sql.includes('FROM public.uw_user u') && sql.includes('ORDER BY u.display_name')) {
    return Promise.resolve({ rows: scenario.usersList || [] });
  }
  if (sql.includes('UPDATE public.uw_user SET failed_attempts')) return Promise.resolve({ rows: [] });
  // Phase 0a: login creates a server-side session (INSERT) + reads the epoch.
  if (sql.includes('INSERT INTO public.auth_session')) {
    return Promise.resolve({ rows: [{ session_id: 'sess-test-1', expires_at: '2026-06-20T08:00:00.000Z' }] });
  }
  if (sql.includes('SELECT session_epoch FROM public.uw_user')) {
    return Promise.resolve({ rows: [{ session_epoch: 0 }] });
  }
  // change-password: load the caller's stored hash, then persist the new one.
  if (sql.includes('password_hash FROM public.uw_user WHERE user_id')) {
    return Promise.resolve({ rows: scenario.pwHash !== undefined ? [{ password_hash: scenario.pwHash }] : [] });
  }
  if (sql.includes('UPDATE public.uw_user') && sql.includes('password_changed_at')) {
    scenario.pwUpdate = { userId: params[0], newHash: params[1], clearsForceFlag: sql.includes('must_change_password = false') };
    return Promise.resolve({ rows: [] });
  }
  return Promise.resolve({ rows: [] });
}

// Transactional handlers (change-password, PATCH users, PUT mandates) acquire a
// client via pool.connect(). The fake client delegates to fakeQuery (so the same
// scenario knobs/queryLog apply) and no-ops BEGIN/COMMIT/ROLLBACK + release.
function makeClient() {
  return {
    query: vi.fn((sql, params) => (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)
      ? Promise.resolve({ rows: [] })
      : fakeQuery(sql, params))),
    release: vi.fn(),
  };
}

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(fakeQuery), connect: vi.fn(() => Promise.resolve(makeClient())) },
}));
vi.mock('../services/audit.js', () => ({ logAudit: vi.fn(() => Promise.resolve()) }));
const alertMock = vi.fn();
vi.mock('../services/securityAlerts.js', () => ({ emitSecurityAlert: (...a) => alertMock(...a) }));

const { default: authRouter, hashPassword, verifyPassword, validatePasswordStrength } = await import('./auth.js');
const { logAudit: logAuditMock } = await import('../services/audit.js');

// Stand-in for authenticate(): the verified identity for the request, set
// per-test. null = anonymous (matches the open-registration / login paths).
let currentUser = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(authRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  return app;
}

async function call(app, { method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), {
      method, url: path,
      headers: { 'content-type': 'application/json', ...headers },
      body: body || {},
    });
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app, statusCode: 200, cookies: [],
      setHeader() { return res; },
      getHeader() { return undefined; },
      // Capture cookie writes so tests can assert the auth/CSRF cookie contract
      // without standing up real Express header plumbing.
      cookie(name, value, options) { res.cookies.push({ name, value, options: options || {} }); return res; },
      clearCookie(name, options) { res.cookies.push({ name, value: '', options: options || {}, cleared: true }); return res; },
      status(code) { res.statusCode = code; return res; },
      json(payload) { chunks.push(JSON.stringify(payload)); res.end(); },
      end() { resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(chunks.join('')) : null, cookies: res.cookies }); },
    });
    res.req = req; req.res = res;
    try {
      app.handle(req, res, (err) => { if (err) reject(err); else resolve({ status: res.statusCode, body: null }); });
    } catch (e) { reject(e); }
  });
}

// Phase 0b assertion helpers (revocation + audit on the verified id).
const revokeAllQuery = (uid) => queryLog.find(
  (q) => q.sql.includes('UPDATE public.auth_session') && q.sql.includes('revoked_reason') && (q.params || [])[0] === uid,
);
const epochBumpQuery = (uid) => queryLog.find(
  (q) => q.sql.includes('session_epoch = session_epoch + 1') && (q.params || [])[0] === uid,
);
const auditEventsFor = (entityId) => logAuditMock.mock.calls
  .map((c) => c[1])
  .filter((e) => e && e.entityId === entityId);

beforeEach(() => {
  queryLog.length = 0;
  scenario = {};
  currentUser = null;
  logAuditMock.mockClear();
  alertMock.mockClear();
  // Identity/SSO config is read from process.env per call — keep the default
  // posture (SSO off) so unrelated tests behave as before; SSO-gate tests opt in.
  delete process.env.IDENTITY_SSO_ENABLED;
  delete process.env.IDENTITY_BREAK_GLASS_USERS;
  process.env.ALLOW_DEMO_AUTH = 'true'; // test default (mirrors vitest env); some tests unset it
  // Open self-registration is FAIL-CLOSED (P1-identity D4): it is OFF unless the
  // flag is explicitly 'true'. The Add-user form tests opt in here; the gate
  // tests below override to 'false'/unset to assert the closed door.
  process.env.ALLOW_OPEN_REGISTRATION = 'true';
});

describe('privileged auth gates (verified req.user)', () => {
  const ADD_USER = { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'correcthorse12', confirm_password: 'correcthorse12' };

  it('POST /auth/users by an authenticated Underwriter → 403', async () => {
    currentUser = { userId: 'u-uw', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'UW' };
    const res = await call(buildApp(), { method: 'POST', path: '/auth/users', body: ADD_USER });
    expect(res.status).toBe(403);
  });

  it('POST /auth/users by a CU → 201', async () => {
    currentUser = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };
    const res = await call(buildApp(), { method: 'POST', path: '/auth/users', body: ADD_USER });
    expect(res.status).toBe(201);
  });

  it('PUT /auth/mandates/:id by an Underwriter → 403, by a CU → not 403', async () => {
    currentUser = { userId: 'u-uw', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'UW' };
    const denied = await call(buildApp(), { method: 'PUT', path: '/auth/mandates/u-x', body: { treaty_limit_usd: 1 } });
    expect(denied.status).toBe(403);

    currentUser = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };
    const ok = await call(buildApp(), { method: 'PUT', path: '/auth/mandates/u-x', body: { treaty_limit_usd: 1 } });
    expect(ok.status).not.toBe(403);
  });
});

describe('A5 — privilege-escalation guards on user/mandate admin', () => {
  const cu = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };

  it('PATCH /auth/users cannot assign a role senior to the actor (403)', async () => {
    currentUser = cu;
    scenario.newRoleLevel = 1; // CE — senior to the CU actor (level 2)
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-target', body: { role_id: 'role-ce' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/senior/i);
  });

  it('PATCH /auth/users cannot modify a target user senior to the actor (403)', async () => {
    currentUser = cu;
    scenario.targetLevel = 1; // the target is a CE
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-boss', body: { office: 'Dubai' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/senior/i);
  });

  it('PATCH /auth/users cannot modify the actor OWN account — no self-promotion (403)', async () => {
    currentUser = cu;
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-cu', body: { role_id: 'role-ce' } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/your own account/i);
  });

  it('PATCH /auth/users allows a peer/junior role change on a junior target (200)', async () => {
    currentUser = cu;
    scenario.newRoleLevel = 5; // assigning an Underwriter role
    scenario.targetLevel = 5;  // target is a junior Underwriter
    scenario.userBefore = { role_id: 'role-old', is_active: true };
    scenario.userAfter = { role_id: 'role-uw', is_active: true };
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-target', body: { role_id: 'role-uw' } });
    expect(res.status).toBe(200);
  });

  it('PUT /auth/mandates cannot raise the actor OWN mandate (403)', async () => {
    currentUser = cu;
    const res = await call(buildApp(), { method: 'PUT', path: '/auth/mandates/u-cu', body: { treaty_limit_usd: 999999999 } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/your own mandate/i);
  });

  it('PUT /auth/mandates cannot modify the mandate of a senior user (403)', async () => {
    currentUser = cu;
    scenario.targetLevel = 1; // senior target
    const res = await call(buildApp(), { method: 'PUT', path: '/auth/mandates/u-boss', body: { treaty_limit_usd: 1 } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/senior/i);
  });
});

describe('password hashing helpers', () => {
  it('hashPassword produces a scrypt$ string that verifyPassword accepts', async () => {
    const stored = await hashPassword('secret1');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('secret1', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });
  it('verifyPassword rejects non-scrypt / malformed stored values', async () => {
    expect(await verifyPassword('x', 'DEMO_HASH_2026')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$only')).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });
  it('verifyPassword still accepts a legacy scrypt$salt$hash row (backward compatible)', async () => {
    // A legacy hash produced by the old scryptSync(plain, saltHex, 64) at N=2^14.
    const { scryptSync } = await import('node:crypto');
    const salt = 'a'.repeat(32);
    const legacy = `scrypt$${salt}$${scryptSync('legacypass1', salt, 64).toString('hex')}`;
    expect(await verifyPassword('legacypass1', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
  });
});

describe('validatePasswordStrength (single shared policy)', () => {
  it('accepts a reasonable 12+ char password', () => {
    expect(validatePasswordStrength('correcthorse12')).toBeNull();
    expect(validatePasswordStrength('brandnewpass12')).toBeNull();
  });
  it('rejects anything shorter than 12 chars (incl. an 11-char near-miss)', () => {
    expect(validatePasswordStrength('short7!')).toMatch(/at least 12/i);
    expect(validatePasswordStrength('elevenchars')).toMatch(/at least 12/i); // 11 chars
    expect(validatePasswordStrength('')).toMatch(/at least 12/i);
  });
  it("rejects the shared seeded temp password 'Universe#1234' (13 chars, passes length)", () => {
    expect(validatePasswordStrength('Universe#1234')).toMatch(/temporary password/i);
  });
  it('rejects obvious weak/common values, all-same-char, and all-digit (at 12+ length)', () => {
    expect(validatePasswordStrength('password1234')).toMatch(/too common|weak/i);
    expect(validatePasswordStrength('qwertyuiop12')).toMatch(/too common|weak/i);
    expect(validatePasswordStrength('aaaaaaaaaaaa')).toMatch(/weak/i);          // 12 same chars
    expect(validatePasswordStrength('123456789012')).toBeTruthy();              // 12 all-digit
  });
});

describe('POST /auth/users (Add-user form)', () => {
  it('creates a real person: 201, composed display_name, scrypt password_hash', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'correcthorse12', confirm_password: 'correcthorse12' },
    });
    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('Ada Lovelace');
    expect(res.body.username).toBe('ada.lovelace');
    expect(res.body.email).toBe('ada.lovelace@universe3.app');
    expect(typeof res.body.password_hash).toBe('string');
    expect(res.body.password_hash.startsWith('scrypt$')).toBe(true);
    expect(res.body.password_hash).not.toBe('DEMO_HASH_2026');
  });

  it('rejects a mismatched confirm with 400 "Passwords do not match"', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'secret1', confirm_password: 'secret2' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Passwords do not match');
  });

  it('rejects a password shorter than the shared 12-char minimum', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'short7!', confirm_password: 'short7!' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 12/i);
  });

  it("rejects the seeded temp password 'Universe#1234' on create (rejected everywhere)", async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'Universe#1234', confirm_password: 'Universe#1234' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/temporary password/i);
  });

  it('rejects an obviously weak common password on create', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'password1234', confirm_password: 'password1234' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too common|weak/i);
  });

  it('dedupes the derived username with a numeric suffix on conflict', async () => {
    scenario.takenUsernames = ['ada.lovelace'];
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'correcthorse12', confirm_password: 'correcthorse12' },
    });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('ada.lovelace2');
  });

  it('admin create with NO password mints a scrypt temp + must_change_password — never DEMO_HASH_2026', async () => {
    currentUser = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/users',
      body: { username: 'aturing', display_name: 'Alan Turing', email: 'alan@universe3.app', role_id: 'role-uw' },
    });
    expect(res.status).toBe(201);
    const insert = queryLog.find((q) => q.sql.includes('INSERT INTO public.uw_user'));
    // A real scrypt hash was persisted (params[7]) — never the demo sentinel…
    expect(insert.params[7].startsWith('scrypt$')).toBe(true);
    expect(insert.params[7]).not.toBe('DEMO_HASH_2026');
    // …with the force-change flag (params[8]) set.
    expect(insert.params[8]).toBe(true);
    // The generated temp is returned to the admin and verifies against the hash,
    // and is NOT the shared seeded literal.
    expect(typeof res.body.temp_password).toBe('string');
    expect(res.body.temp_password.length).toBeGreaterThanOrEqual(12);
    expect(res.body.temp_password).not.toBe('Universe#1234');
    expect(await verifyPassword(res.body.temp_password, insert.params[7])).toBe(true);
  });

  it('blocks open registration when disabled and there is no caller', async () => {
    process.env.ALLOW_OPEN_REGISTRATION = 'false';
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'secret1', confirm_password: 'secret1' },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /auth/login', () => {
  const adaRow = (hash) => ({
    user_id: 'u-ada', username: 'ada.lovelace', display_name: 'Ada Lovelace', email: 'ada.lovelace@universe3.app',
    office: 'Riyadh', role_id: 'role-uw', role_code: 'UW', role_name: 'Underwriter', hierarchy_level: 4,
    can_override_below: false, effective_limit_usd: 25000000, treaty_type_scope: 'BOTH', approvals_required: 1,
    is_active: true, locked_until: null, password_hash: hash,
  });

  // Find the captured auth/CSRF cookies on a login (or logout) response.
  const authCookieOf = (res) => (res.cookies || []).find((c) => c.name === 'auth_token');
  const csrfCookieOf = (res) => (res.cookies || []).find((c) => c.name === 'csrf_token');

  it('logs in a real account with the correct password (200 session)', async () => {
    scenario.loginUser = adaRow(await hashPassword('secret1'));
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'secret1' } });
    expect(res.status).toBe(200);
    expect(res.body.session.displayName).toBe('Ada Lovelace');
    expect(res.body.session.userId).toBe('u-ada');
  });

  it('rejects a wrong password with 401', async () => {
    scenario.loginUser = adaRow(await hashPassword('secret1'));
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'nope' } });
    expect(res.status).toBe(401);
  });

  // A4 — no user-enumeration oracle.
  it('an unknown username returns the SAME generic 401 as a bad password (no enumeration)', async () => {
    scenario.loginUser = null; // v_user_mandate finds nothing
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ghost', password: 'whatever12345' } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials.' });
  });

  it('a locked account returns a uniform generic 401 (lock state not disclosed) and issues no session', async () => {
    scenario.loginUser = { ...adaRow(await hashPassword('realpass1')), locked_until: new Date(Date.now() + 3600e3).toISOString() };
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'realpass1' } });
    // Same status + body as a bad password — no "Account locked" message, no 403.
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials.' });
    // The lock is enforced: even the correct password grants no auth cookie.
    expect((res.cookies || []).some((c) => c.name === 'auth_token' && !c.cleared)).toBe(false);
  });

  it('still accepts demo accounts with demo2026 when ALLOW_DEMO_AUTH=true', async () => {
    scenario.loginUser = { ...adaRow('DEMO_HASH_2026'), user_id: 'u-cuo', username: 'cuo', display_name: 'Chief Underwriting Officer', role_code: 'CU', hierarchy_level: 2 };
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/auth/login', body: { username: 'cuo', password: 'demo2026' } });
    expect(res.status).toBe(200);
    expect(res.body.session.username).toBe('cuo');
  });

  it('REJECTS demo2026 in production mode (ALLOW_DEMO_AUTH unset) — only the real scrypt password works', async () => {
    delete process.env.ALLOW_DEMO_AUTH;
    scenario.loginUser = adaRow(await hashPassword('realpass1')); // real password, not demo2026
    // demo backdoor refused
    const bad = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'demo2026' } });
    expect(bad.status).toBe(401);
    // real scrypt password still authenticates without the demo flag
    const ok = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'realpass1' } });
    expect(ok.status).toBe(200);
    expect(ok.body.session.token).toBeUndefined();          // token never in the body
    expect(authCookieOf(ok).value).toMatch(/.+\..+/);       // it lives in the cookie
  });

  it('sets an httpOnly Secure-capable SameSite auth cookie + a readable CSRF cookie, and never returns the token in the body', async () => {
    scenario.loginUser = adaRow(await hashPassword('realpass1'));
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'realpass1' } });
    expect(res.status).toBe(200);

    // Token is in the httpOnly cookie, not the JSON body.
    expect(res.body.session.token).toBeUndefined();
    const auth = authCookieOf(res);
    expect(auth.value).toMatch(/.+\..+/);                   // signed token shape
    expect(auth.options.httpOnly).toBe(true);
    expect(auth.options.sameSite).toBe('strict');
    expect(auth.options.path).toBe('/api');
    expect(auth.options).toHaveProperty('secure');          // gated to prod at runtime

    // CSRF token is a readable (non-httpOnly) double-submit cookie.
    const csrf = csrfCookieOf(res);
    expect(csrf.value).toMatch(/.+\..+/);
    expect(csrf.options.httpOnly).toBe(false);
    expect(csrf.options.path).toBe('/');
  });

  it('still authenticates (via cookie) AND flags mustChangePassword for a forced-change user', async () => {
    scenario.loginUser = { ...adaRow(await hashPassword('Universe#1234')), must_change_password: true };
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'Universe#1234' } });
    expect(res.status).toBe(200);
    expect(res.body.session.token).toBeUndefined();
    expect(authCookieOf(res).value).toMatch(/.+\..+/);
    expect(res.body.session.mustChangePassword).toBe(true);
  });

  it('POST /auth/logout clears the auth + CSRF cookies', async () => {
    const res = await call(buildApp(), { method: 'POST', path: '/auth/logout' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cleared = (res.cookies || []).filter((c) => c.cleared);
    expect(cleared.some((c) => c.name === 'auth_token' && c.options.path === '/api')).toBe(true);
    expect(cleared.some((c) => c.name === 'csrf_token' && c.options.path === '/')).toBe(true);
  });

  it('does not flag mustChangePassword for a normal user', async () => {
    scenario.loginUser = adaRow(await hashPassword('realpass1'));
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'realpass1' } });
    expect(res.body.session.mustChangePassword).toBe(false);
  });
});

describe('POST /auth/name-login — passwordless name sign-in (Saudi Re pilot)', () => {
  const isheRow = () => ({
    user_id: 'u-ishe', username: 'ishe.wadaya', display_name: 'Ishe Wadaya', email: 'ishe.wadaya@universe3.app',
    office: 'Riyadh', role_id: 'role-uw', role_code: 'TUW', role_name: 'Treaty Underwriter', hierarchy_level: 5,
    can_override_below: false, effective_limit_usd: 10000000, treaty_type_scope: 'BOTH', approvals_required: 1,
    is_active: true, locked_until: null, password_hash: 'scrypt$x$y', must_change_password: false,
  });
  const nameLogin = (body) => call(buildApp(), { method: 'POST', path: '/auth/name-login', body });
  const authCookieOf = (res) => (res.cookies || []).find((c) => c.name === 'auth_token');

  it('is FAIL-CLOSED: 404 when ALLOW_NAME_AUTH is unset', async () => {
    delete process.env.ALLOW_NAME_AUTH;
    const res = await nameLogin({ first_name: 'Ishe', surname: 'Wadaya' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NAME_AUTH_DISABLED');
  });

  it('is FAIL-CLOSED: 404 for any non-"true" value', async () => {
    process.env.ALLOW_NAME_AUTH = '1';
    const res = await nameLogin({ first_name: 'Ishe', surname: 'Wadaya' });
    expect(res.status).toBe(404);
  });

  it('signs an EXISTING user in by name — cookie session, no password, no new account', async () => {
    process.env.ALLOW_NAME_AUTH = 'true';
    scenario.nameUser = isheRow();
    const res = await nameLogin({ first_name: 'Ishe', surname: 'Wadaya' });
    expect(res.status).toBe(200);
    expect(res.body.session.userId).toBe('u-ishe');
    expect(res.body.session.displayName).toBe('Ishe Wadaya');
    expect(res.body.session.token).toBeUndefined();          // token never in the body
    const auth = authCookieOf(res);
    expect(auth.value).toMatch(/.+\..+/);                    // signed token in httpOnly cookie
    expect(auth.options.httpOnly).toBe(true);
    // No account was minted for a known person.
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO public.uw_user'))).toBe(false);
    // A real server-side session was created (revocable, same as password login).
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO public.auth_session'))).toBe(true);
  });

  it('rejects shared/demo personas and senior accounts (password login required)', async () => {
    process.env.ALLOW_NAME_AUTH = 'true';
    scenario.nameUser = {
      ...isheRow(),
      user_id: 'u-chief',
      username: 'chief.underwriter',
      display_name: 'Chief Underwriter',
      role_code: 'CU',
      role_name: 'Chief Underwriter',
      hierarchy_level: 2,
    };
    const res = await nameLogin({ first_name: 'Chief', surname: 'Underwriter' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_LOGIN_REQUIRED');
    expect((res.cookies || []).some((c) => c.name === 'auth_token' && !c.cleared)).toBe(false);
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO public.auth_session'))).toBe(false);
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO public.uw_user'))).toBe(false);
  });

  it('creates the account on FIRST name-login (TUW role, default mandate, unusable scrypt password) then signs in', async () => {
    process.env.ALLOW_NAME_AUTH = 'true';
    scenario.nameUser = null;                 // unknown display name
    scenario.mandateRow = isheRow();          // re-select after create
    const res = await nameLogin({ first_name: 'Ishe', surname: 'Wadaya' });
    expect(res.status).toBe(200);
    expect(res.body.session.displayName).toBe('Ishe Wadaya');
    expect(authCookieOf(res).value).toMatch(/.+\..+/);

    const insert = queryLog.find((q) => q.sql.includes('INSERT INTO public.uw_user'));
    expect(insert).toBeTruthy();
    expect(insert.params[0]).toBe('ishe.wadaya');            // derived username
    expect(insert.params[1]).toBe('Ishe Wadaya');            // display name
    expect(insert.params[7]).toMatch(/^scrypt\$/);           // random, unusable scrypt hash
    expect(insert.params[8]).toBe(false);                    // no forced password change
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO public.user_mandate'))).toBe(true);
  });

  it('rejects a missing or junk-shaped name with 400', async () => {
    process.env.ALLOW_NAME_AUTH = 'true';
    expect((await nameLogin({ first_name: 'Ishe' })).status).toBe(400);
    expect((await nameLogin({ first_name: 'Robert;DROP TABLE', surname: 'Users' })).status).toBe(400);
    expect((await nameLogin({ first_name: '12345', surname: 'Wadaya' })).status).toBe(400);
  });

  it('honours an account lock with the same generic 401 as password login', async () => {
    process.env.ALLOW_NAME_AUTH = 'true';
    scenario.nameUser = { ...isheRow(), locked_until: new Date(Date.now() + 3600e3).toISOString() };
    const res = await nameLogin({ first_name: 'Ishe', surname: 'Wadaya' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials.' });
    expect((res.cookies || []).some((c) => c.name === 'auth_token' && !c.cleared)).toBe(false);
  });

  it('GET /auth/name-login/status reports the posture without leaking anything else', async () => {
    delete process.env.ALLOW_NAME_AUTH;
    expect((await call(buildApp(), { path: '/auth/name-login/status' })).body).toEqual({ enabled: false });
    process.env.ALLOW_NAME_AUTH = 'true';
    expect((await call(buildApp(), { path: '/auth/name-login/status' })).body).toEqual({ enabled: true });
  });
});

describe('POST /auth/login — SSO-posture gate (Phase 0c, tolerant while SSO off)', () => {
  const row = (hash, username = 'ada.lovelace') => ({
    user_id: 'u-ada', username, display_name: 'Ada Lovelace', email: `${username}@universe3.app`,
    office: 'Riyadh', role_id: 'role-uw', role_code: 'UW', role_name: 'Underwriter', hierarchy_level: 4,
    can_override_below: false, effective_limit_usd: 1, treaty_type_scope: 'BOTH', approvals_required: 1,
    is_active: true, locked_until: null, password_hash: hash,
  });
  const login = (username = 'ada.lovelace') => call(buildApp(), { method: 'POST', path: '/auth/login', body: { username, password: 'realpass1' } });
  const auditTypes = () => logAuditMock.mock.calls.map((c) => c[1]?.eventType);

  it('SSO OFF (default): local login works unchanged — no gate, no alert', async () => {
    scenario.loginUser = row(await hashPassword('realpass1'));
    const res = await login();
    expect(res.status).toBe(200);
    expect(alertMock).not.toHaveBeenCalled();
    expect(auditTypes()).not.toContain('LOCAL_LOGIN_BLOCKED');
  });

  it('SSO ON: a non-break-glass local login is refused 403 SSO_REQUIRED + audited', async () => {
    process.env.IDENTITY_SSO_ENABLED = 'true';
    scenario.loginUser = row(await hashPassword('realpass1'));
    const res = await login();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SSO_REQUIRED');
    expect(auditTypes()).toContain('LOCAL_LOGIN_BLOCKED');
    // No session cookie is issued on a blocked login.
    expect((res.cookies || []).some((c) => c.name === 'auth_token' && !c.cleared)).toBe(false);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('SSO ON: a configured break-glass user logs in (200), audited BREAK_GLASS_LOGIN + alert raised', async () => {
    process.env.IDENTITY_SSO_ENABLED = 'true';
    process.env.IDENTITY_BREAK_GLASS_USERS = 'root.admin, ada.lovelace';
    scenario.loginUser = row(await hashPassword('realpass1'));
    const res = await login();
    expect(res.status).toBe(200);
    expect(auditTypes()).toContain('BREAK_GLASS_LOGIN');
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock.mock.calls[0][0]).toBe('BREAK_GLASS_LOGIN');
    // The wrong password still fails BEFORE the posture gate (no alert leak).
    expect((res.cookies || []).some((c) => c.name === 'auth_token' && !c.cleared)).toBe(true);
  });

  it('SSO ON: a wrong password is rejected 401 before the gate (no posture disclosure)', async () => {
    process.env.IDENTITY_SSO_ENABLED = 'true';
    scenario.loginUser = row(await hashPassword('realpass1'));
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'WRONG' } });
    expect(res.status).toBe(401);
    expect(auditTypes()).not.toContain('LOCAL_LOGIN_BLOCKED');
    expect(alertMock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/change-password — self-service, verified identity only', () => {
  const me = { userId: 'u-me', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'Me' };

  it('changes the password with the correct current password (200 ok); new hash verifies, old does not, force-flag cleared', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Persisted a fresh scrypt of the NEW password against the verified id…
    expect(scenario.pwUpdate.userId).toBe('u-me');
    expect(await verifyPassword('brandnewpass12', scenario.pwUpdate.newHash)).toBe(true);
    expect(await verifyPassword('oldpass1', scenario.pwUpdate.newHash)).toBe(false);
    // …and cleared must_change_password in the same write.
    expect(scenario.pwUpdate.clearsForceFlag).toBe(true);
  });

  it('rejects the forced-change temp password (Universe#1234) as the new password → 400', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'Universe#1234', confirmPassword: 'Universe#1234' },
    });
    expect(res.status).toBe(400);
    expect(scenario.pwUpdate).toBeUndefined();
  });

  it('rejects a wrong current password with 401 and writes nothing', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'WRONG', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Current password is incorrect.');
    expect(scenario.pwUpdate).toBeUndefined();
  });

  it('rejects a mismatched confirm with 400 "Passwords do not match"', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'brandnewpass12', confirmPassword: 'different2' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Passwords do not match');
    expect(scenario.pwUpdate).toBeUndefined();
  });

  it('rejects new === current with 400 "New password must differ"', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('samepasslong12');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'samepasslong12', newPassword: 'samepasslong12', confirmPassword: 'samepasslong12' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('New password must differ');
  });

  it('rejects a new password shorter than 8 chars with 400', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'short7!', confirmPassword: 'short7!' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 12/i);
  });

  it('rejects a missing field with 400', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'brandnewpass12' }, // no confirmPassword
    });
    expect(res.status).toBe(400);
  });

  it('does NOT accept the demo password as current when the stored hash is legacy/demo → 401', async () => {
    currentUser = me;
    scenario.pwHash = 'DEMO_HASH_2026'; // non-scrypt stored value
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'demo2026', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12' },
    });
    expect(res.status).toBe(401);
    expect(scenario.pwUpdate).toBeUndefined();
  });

  it('ignores any body/param user id — only ever mutates req.user own hash', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: {
        userId: 'u-victim', user_id: 'u-victim', id: 'u-victim',
        currentPassword: 'oldpass1', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12',
      },
    });
    expect(res.status).toBe(200);
    expect(scenario.pwUpdate.userId).toBe('u-me');
    // No query ever ran against the spoofed victim id.
    expect(queryLog.filter((q) => (q.params || []).includes('u-victim'))).toHaveLength(0);
  });

  it('rejects an anonymous caller with 401 (no token → router gate / requireAuth)', async () => {
    currentUser = null;
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'x', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12' },
    });
    expect(res.status).toBe(401);
    expect(scenario.pwUpdate).toBeUndefined();
  });
});

describe('P1-identity Phase 0b — revocation + critical audit on user-admin changes', () => {
  const me = { userId: 'u-me', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'Me' };
  const cu = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };

  it('change-password revokes ALL sessions, reissues THIS device, and audits PASSWORD_CHANGED', async () => {
    currentUser = me;
    scenario.pwHash = await hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12' },
    });
    expect(res.status).toBe(200);
    // Every outstanding session for the caller is revoked + the epoch is bumped…
    expect(revokeAllQuery('u-me')).toBeTruthy();
    expect(revokeAllQuery('u-me').params[1]).toBe('PASSWORD_CHANGE');
    expect(epochBumpQuery('u-me')).toBeTruthy();
    // …then a fresh session is minted (INSERT auth_session) and a new auth cookie set,
    // so the device that changed its password stays logged in.
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO public.auth_session'))).toBe(true);
    expect((res.cookies || []).some((c) => c.name === 'auth_token' && !c.cleared)).toBe(true);
    // Critical audit recorded against the verified id.
    const ev = auditEventsFor('u-me').find((e) => e.eventType === 'PASSWORD_CHANGED');
    expect(ev).toBeTruthy();
    expect(ev.payload.sessions_revoked).toBe(true);
  });

  it('PATCH /auth/users role change → revokes sessions + USER_ROLE_CHANGED audit', async () => {
    currentUser = cu;
    scenario.userBefore = { role_id: 'role-old', is_active: true };
    scenario.userAfter = { role_id: 'role-new', is_active: true };
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-target', body: { role_id: 'role-new' } });
    expect(res.status).toBe(200);
    expect(revokeAllQuery('u-target')).toBeTruthy();
    expect(revokeAllQuery('u-target').params[1]).toBe('ROLE_CHANGE');
    const ev = auditEventsFor('u-target').find((e) => e.eventType === 'USER_ROLE_CHANGED');
    expect(ev).toBeTruthy();
    expect(ev.payload.sessions_revoked).toBe(true);
  });

  it('PATCH /auth/users deactivation → revokes sessions + USER_DEACTIVATED audit', async () => {
    currentUser = cu;
    scenario.userBefore = { role_id: 'role-x', is_active: true };
    scenario.userAfter = { role_id: 'role-x', is_active: false };
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-target', body: { is_active: false } });
    expect(res.status).toBe(200);
    expect(revokeAllQuery('u-target')).toBeTruthy();
    expect(revokeAllQuery('u-target').params[1]).toBe('DEACTIVATED');
    expect(auditEventsFor('u-target').some((e) => e.eventType === 'USER_DEACTIVATED')).toBe(true);
  });

  it('PATCH /auth/users benign field (office) → NO revoke, USER_UPDATED audit', async () => {
    currentUser = cu;
    scenario.userBefore = { role_id: 'role-x', is_active: true };
    scenario.userAfter = { role_id: 'role-x', is_active: true };
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-target', body: { office: 'Dubai' } });
    expect(res.status).toBe(200);
    expect(revokeAllQuery('u-target')).toBeFalsy();           // authority unchanged → sessions live
    expect(auditEventsFor('u-target').some((e) => e.eventType === 'USER_UPDATED')).toBe(true);
  });

  it('PATCH /auth/users reactivation → USER_REACTIVATED audit (no revoke needed)', async () => {
    currentUser = cu;
    scenario.userBefore = { role_id: 'role-x', is_active: false };
    scenario.userAfter = { role_id: 'role-x', is_active: true };
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-target', body: { is_active: true } });
    expect(res.status).toBe(200);
    expect(revokeAllQuery('u-target')).toBeFalsy();
    expect(auditEventsFor('u-target').some((e) => e.eventType === 'USER_REACTIVATED')).toBe(true);
  });

  it('PATCH /auth/users on an unknown id → 404, no write/audit', async () => {
    currentUser = cu;
    scenario.userBefore = null; // FOR UPDATE finds nothing
    const res = await call(buildApp(), { method: 'PATCH', path: '/auth/users/u-ghost', body: { office: 'Dubai' } });
    expect(res.status).toBe(404);
    expect(auditEventsFor('u-ghost')).toHaveLength(0);
  });

  it('PUT /auth/mandates authority change → revokes sessions + MANDATE_UPDATED audit', async () => {
    currentUser = cu;
    scenario.mandateBefore = {
      treaty_limit_usd: 1000000, single_risk_limit_usd: null, allowed_cob_ids: [], restricted_cob_ids: [],
      allowed_country_ids: [], treaty_type_scope: 'BOTH', approvals_required: 1,
    };
    const res = await call(buildApp(), { method: 'PUT', path: '/auth/mandates/u-target', body: { treaty_limit_usd: 5000000 } });
    expect(res.status).toBe(200);
    expect(revokeAllQuery('u-target')).toBeTruthy();
    expect(revokeAllQuery('u-target').params[1]).toBe('MANDATE_CHANGE');
    const ev = auditEventsFor('u-target').find((e) => e.eventType === 'MANDATE_UPDATED');
    expect(ev).toBeTruthy();
    expect(ev.payload.changed_authority).toContain('treaty_limit_usd');
  });

  it('PUT /auth/mandates with no authority change (same values) → NO revoke', async () => {
    currentUser = cu;
    scenario.mandateBefore = {
      treaty_limit_usd: null, single_risk_limit_usd: null, allowed_cob_ids: [], restricted_cob_ids: [],
      allowed_country_ids: [], treaty_type_scope: 'BOTH', approvals_required: 1,
    };
    // Body omits every authority field → upsert writes the same defaults back.
    const res = await call(buildApp(), { method: 'PUT', path: '/auth/mandates/u-target', body: { notes: 'just a note' } });
    expect(res.status).toBe(200);
    expect(revokeAllQuery('u-target')).toBeFalsy();
    const ev = auditEventsFor('u-target').find((e) => e.eventType === 'MANDATE_UPDATED');
    expect(ev.payload.changed_authority).toEqual([]);
  });
});

describe('GET /auth/mandates/:userId — identity from token, no cross-user reads', () => {
  it('an Underwriter reads their OWN mandate', async () => {
    currentUser = { userId: 'u-uw', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'UW' };
    scenario.mandateRow = { role_code: 'TUW', hierarchy_level: 5 };
    const res = await call(buildApp(), { method: 'GET', path: '/auth/mandates/u-uw' });
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('u-uw');
  });

  it('an Underwriter requesting ANOTHER user mandate → 403', async () => {
    currentUser = { userId: 'u-uw', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'UW' };
    scenario.mandateRow = { role_code: 'CU', hierarchy_level: 2 };
    const res = await call(buildApp(), { method: 'GET', path: '/auth/mandates/u-someone-else' });
    expect(res.status).toBe(403);
  });

  it('a CU may read another user mandate via :userId', async () => {
    currentUser = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };
    scenario.mandateRow = { role_code: 'TUW', hierarchy_level: 5 };
    const res = await call(buildApp(), { method: 'GET', path: '/auth/mandates/u-target' });
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('u-target');
  });
});

describe('open registration gate (production default)', () => {
  it('returns 403 for an anonymous create when ALLOW_OPEN_REGISTRATION is unset in production', async () => {
    const prevNode = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_OPEN_REGISTRATION;
    currentUser = null; // anonymous (no token)
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'secret1', confirm_password: 'secret1' },
    });
    expect(res.status).toBe(403);
    process.env.NODE_ENV = prevNode;
  });
});

describe('GET /auth/users', () => {
  it('returns all active users (incl. Ada) ordered for the people dropdown', async () => {
    scenario.usersList = [
      { user_id: 'u-ada', username: 'ada.lovelace', display_name: 'Ada Lovelace', email: 'ada.lovelace@universe3.app', role_code: 'UW', role_name: 'Underwriter', hierarchy_level: 4, authority_limit_usd: 25000000, treaty_limit_usd: null, is_active: true },
    ];
    const app = buildApp();
    const res = await call(app, { method: 'GET', path: '/auth/users' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((u) => u.display_name === 'Ada Lovelace')).toBe(true);
    // ordered by display_name (no CU/TUW filter applied here)
    expect(queryLog.some((q) => q.sql.includes('ORDER BY u.display_name'))).toBe(true);
  });

  it('unauthenticated callers get a MINIMAL projection — no email/office/limits/hierarchy leaked pre-auth', async () => {
    scenario.usersList = [{ user_id: 'u-ada', username: 'ada.lovelace', display_name: 'Ada Lovelace', role_code: 'UW', role_name: 'Underwriter' }];
    // No x-user-* headers → req.user is null → the public login-screen path.
    const res = await call(buildApp(), { method: 'GET', path: '/auth/users' });
    expect(res.status).toBe(200);
    const usersQuery = queryLog.find((q) => q.sql.includes('FROM public.uw_user u') && q.sql.includes('ORDER BY u.display_name'));
    expect(usersQuery).toBeTruthy();
    // The pre-auth query must not select PII / authority columns.
    expect(usersQuery.sql).not.toMatch(/user_mandate|treaty_limit_usd|single_risk_limit_usd|u\.email|u\.office|hierarchy_level/);
  });

  it('lists the migration-132 demo personas alongside real people (nothing filtered)', async () => {
    scenario.usersList = [
      { user_id: 'u-cuo', username: 'chief.underwriter', display_name: 'Chief Underwriter', role_code: 'CU', role_name: 'Chief Underwriter' },
      { user_id: 'u-uw1', username: 'underwriter1', display_name: 'Underwriter 1', role_code: 'UW', role_name: 'Underwriter' },
      { user_id: 'u-uw2', username: 'underwriter2', display_name: 'Underwriter 2', role_code: 'UW', role_name: 'Underwriter' },
      { user_id: 'u-ishe', username: 'ishe.wadaya', display_name: 'Ishe Wadaya', role_code: 'UW', role_name: 'Underwriter' },
    ];
    const anon = await call(buildApp(), { method: 'GET', path: '/auth/users' });
    expect(anon.status).toBe(200);
    expect(anon.body.map((u) => u.username)).toEqual(['chief.underwriter', 'underwriter1', 'underwriter2', 'ishe.wadaya']);
  });

  it('authenticated callers get the full record (mandate join) for the admin screen', async () => {
    currentUser = { userId: 'u-cu', roleCode: 'CU', hierarchyLevel: 2, displayName: 'CU' };
    scenario.usersList = [{ user_id: 'u-ada', username: 'ada.lovelace', display_name: 'Ada Lovelace', email: 'a@b.c', role_code: 'UW' }];
    const res = await call(buildApp(), { method: 'GET', path: '/auth/users' });
    expect(res.status).toBe(200);
    const usersQuery = queryLog.find((q) => q.sql.includes('FROM public.uw_user u') && q.sql.includes('LEFT JOIN public.user_mandate'));
    expect(usersQuery).toBeTruthy();
    expect(usersQuery.sql).toMatch(/treaty_limit_usd/);
  });
});
