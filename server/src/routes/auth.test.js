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
  // Caller authority gate.
  if (sql.includes('SELECT r.hierarchy_level FROM public.uw_user u JOIN public.uw_role r')) {
    return Promise.resolve({ rows: scenario.callerLevel != null ? [{ hierarchy_level: scenario.callerLevel }] : [] });
  }
  if (sql.includes('INSERT INTO public.uw_user')) {
    return Promise.resolve({ rows: [{
      user_id: 'new-user-1', username: params[0], display_name: params[1], email: params[2],
      role_id: params[3], office: params[4], password_hash: params[7], created_at: '2026-06-13T00:00:00.000Z',
    }] });
  }
  if (sql.includes('INSERT INTO public.user_mandate')) return Promise.resolve({ rows: [] });
  if (sql.includes('FROM public.v_user_mandate vm')) {
    return Promise.resolve({ rows: scenario.loginUser ? [scenario.loginUser] : [] });
  }
  if (sql.includes('FROM public.v_user_mandate WHERE user_id')) {
    return Promise.resolve({ rows: scenario.mandateRow ? [{ user_id: params[0], ...scenario.mandateRow }] : [] });
  }
  if (sql.includes('FROM public.uw_user u') && sql.includes('LEFT JOIN public.user_mandate')) {
    return Promise.resolve({ rows: scenario.usersList || [] });
  }
  if (sql.includes('UPDATE public.uw_user SET failed_attempts')) return Promise.resolve({ rows: [] });
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

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(fakeQuery), connect: vi.fn() },
}));
vi.mock('../services/audit.js', () => ({ logAudit: vi.fn(() => Promise.resolve()) }));

const { default: authRouter, hashPassword, verifyPassword, validatePasswordStrength } = await import('./auth.js');

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

beforeEach(() => {
  queryLog.length = 0;
  scenario = {};
  currentUser = null;
  process.env.ALLOW_DEMO_AUTH = 'true'; // test default (mirrors vitest env); some tests unset it
  delete process.env.ALLOW_OPEN_REGISTRATION; // default-on in test env (NODE_ENV !== 'production')
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

describe('password hashing helpers', () => {
  it('hashPassword produces a scrypt$ string that verifyPassword accepts', () => {
    const stored = hashPassword('secret1');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('secret1', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });
  it('verifyPassword rejects non-scrypt / malformed stored values', () => {
    expect(verifyPassword('x', 'DEMO_HASH_2026')).toBe(false);
    expect(verifyPassword('x', 'scrypt$only')).toBe(false);
    expect(verifyPassword('x', null)).toBe(false);
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
    expect(verifyPassword(res.body.temp_password, insert.params[7])).toBe(true);
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
    scenario.loginUser = adaRow(hashPassword('secret1'));
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'secret1' } });
    expect(res.status).toBe(200);
    expect(res.body.session.displayName).toBe('Ada Lovelace');
    expect(res.body.session.userId).toBe('u-ada');
  });

  it('rejects a wrong password with 401', async () => {
    scenario.loginUser = adaRow(hashPassword('secret1'));
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'nope' } });
    expect(res.status).toBe(401);
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
    scenario.loginUser = adaRow(hashPassword('realpass1')); // real password, not demo2026
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
    scenario.loginUser = adaRow(hashPassword('realpass1'));
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
    scenario.loginUser = { ...adaRow(hashPassword('Universe#1234')), must_change_password: true };
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
    scenario.loginUser = adaRow(hashPassword('realpass1'));
    const res = await call(buildApp(), { method: 'POST', path: '/auth/login', body: { username: 'ada.lovelace', password: 'realpass1' } });
    expect(res.body.session.mustChangePassword).toBe(false);
  });
});

describe('POST /auth/change-password — self-service, verified identity only', () => {
  const me = { userId: 'u-me', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'Me' };

  it('changes the password with the correct current password (200 ok); new hash verifies, old does not, force-flag cleared', async () => {
    currentUser = me;
    scenario.pwHash = hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'brandnewpass12', confirmPassword: 'brandnewpass12' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Persisted a fresh scrypt of the NEW password against the verified id…
    expect(scenario.pwUpdate.userId).toBe('u-me');
    expect(verifyPassword('brandnewpass12', scenario.pwUpdate.newHash)).toBe(true);
    expect(verifyPassword('oldpass1', scenario.pwUpdate.newHash)).toBe(false);
    // …and cleared must_change_password in the same write.
    expect(scenario.pwUpdate.clearsForceFlag).toBe(true);
  });

  it('rejects the forced-change temp password (Universe#1234) as the new password → 400', async () => {
    currentUser = me;
    scenario.pwHash = hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'Universe#1234', confirmPassword: 'Universe#1234' },
    });
    expect(res.status).toBe(400);
    expect(scenario.pwUpdate).toBeUndefined();
  });

  it('rejects a wrong current password with 401 and writes nothing', async () => {
    currentUser = me;
    scenario.pwHash = hashPassword('oldpass1');
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
    scenario.pwHash = hashPassword('oldpass1');
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
    scenario.pwHash = hashPassword('samepasslong12');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'samepasslong12', newPassword: 'samepasslong12', confirmPassword: 'samepasslong12' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('New password must differ');
  });

  it('rejects a new password shorter than 8 chars with 400', async () => {
    currentUser = me;
    scenario.pwHash = hashPassword('oldpass1');
    const res = await call(buildApp(), {
      method: 'POST', path: '/auth/change-password',
      body: { currentPassword: 'oldpass1', newPassword: 'short7!', confirmPassword: 'short7!' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 12/i);
  });

  it('rejects a missing field with 400', async () => {
    currentUser = me;
    scenario.pwHash = hashPassword('oldpass1');
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
    scenario.pwHash = hashPassword('oldpass1');
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
});
