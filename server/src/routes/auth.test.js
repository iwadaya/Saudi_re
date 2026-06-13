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
  if (sql.includes('FROM public.uw_user u') && sql.includes('LEFT JOIN public.user_mandate')) {
    return Promise.resolve({ rows: scenario.usersList || [] });
  }
  if (sql.includes('UPDATE public.uw_user SET failed_attempts')) return Promise.resolve({ rows: [] });
  return Promise.resolve({ rows: [] });
}

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(fakeQuery), connect: vi.fn() },
}));
vi.mock('../services/audit.js', () => ({ logAudit: vi.fn(() => Promise.resolve()) }));

const { default: authRouter, hashPassword, verifyPassword } = await import('./auth.js');

function buildApp() {
  const app = express();
  app.use(express.json());
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
      app, statusCode: 200,
      setHeader() { return res; },
      getHeader() { return undefined; },
      status(code) { res.statusCode = code; return res; },
      json(payload) { chunks.push(JSON.stringify(payload)); res.end(); },
      end() { resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(chunks.join('')) : null }); },
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
  delete process.env.ALLOW_OPEN_REGISTRATION; // default-on in test env (NODE_ENV !== 'production')
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

describe('POST /auth/users (Add-user form)', () => {
  it('creates a real person: 201, composed display_name, scrypt password_hash', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'secret1', confirm_password: 'secret1' },
    });
    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('Ada Lovelace');
    expect(res.body.username).toBe('ada.lovelace');
    expect(res.body.email).toBe('ada.lovelace@universe3.app');
    expect(typeof res.body.password_hash).toBe('string');
    expect(res.body.password_hash.startsWith('scrypt$')).toBe(true);
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

  it('rejects a password shorter than 6 chars', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'abc', confirm_password: 'abc' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 6/i);
  });

  it('dedupes the derived username with a numeric suffix on conflict', async () => {
    scenario.takenUsernames = ['ada.lovelace'];
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/auth/users',
      body: { first_name: 'Ada', surname: 'Lovelace', role_code: 'UW', password: 'secret1', confirm_password: 'secret1' },
    });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('ada.lovelace2');
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

  it('still accepts demo accounts with demo2026', async () => {
    scenario.loginUser = { ...adaRow('DEMO_HASH_2026'), user_id: 'u-cuo', username: 'cuo', display_name: 'Chief Underwriting Officer', role_code: 'CU', hierarchy_level: 2 };
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/auth/login', body: { username: 'cuo', password: 'demo2026' } });
    expect(res.status).toBe(200);
    expect(res.body.session.username).toBe('cuo');
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
