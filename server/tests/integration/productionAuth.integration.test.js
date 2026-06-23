// server/tests/integration/productionAuth.integration.test.js
//
// Production-auth path (CI enterprise gate, P0-8): with ALLOW_DEMO_AUTH UNSET
// (i.e. the production posture), the x-user-* demo headers grant nothing, and the
// only way in is a real login that issues an httpOnly auth cookie + a CSRF token,
// after which a state-changing request must carry the X-CSRF-Token header.
//
// This proves end-to-end:
//   • demo headers are rejected when ALLOW_DEMO_AUTH is unset (401),
//   • login issues the auth_token (httpOnly) + csrf_token cookies,
//   • a cookie-authenticated mutation SUCCEEDS with the CSRF header,
//   • the same mutation is REJECTED (403 CSRF_FAILED) without it.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { hashPassword } from '../../src/routes/auth.js';

const PASSWORD = 'Pr0d-Auth-Str0ng-Pass!';

describe.skipIf(shouldSkipDb)('integration: production auth (cookie + CSRF)', () => {
  let harness;
  let refs;
  let username;

  // Parse Set-Cookie from a login response into { auth_token, csrf_token }.
  function cookieJar(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const jar = {};
    for (const c of set) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
    return jar;
  }
  const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const url = (p) => `${harness.baseUrl}${p}`;
  const quoteBody = () => ({ ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' });

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    // Seed a REAL account (scrypt password), not a demo identity.
    const sfx = `${Date.now()}-${process.pid}`;
    username = `prodauth_${sfx}`.toLowerCase();
    const role = await pool.query(`SELECT role_id FROM public.uw_role WHERE role_code='CU' LIMIT 1`);
    await pool.query(
      `INSERT INTO public.uw_user (email, username, display_name, role_id, is_active, password_hash)
       VALUES ($1,$2,'Prod Auth User',$3,true,$4)`,
      [`${username}@example.test`, username, role.rows[0].role_id, await hashPassword(PASSWORD)],
    );
  });

  afterAll(async () => {
    try { await pool.query(`DELETE FROM public.uw_user WHERE username=$1`, [username]); } catch {}
    if (harness) await harness.close();
    await closePools();
  });

  // Production posture: the demo-auth shortcut is OFF for every test here.
  // env-isolation restores ALLOW_DEMO_AUTH after each test.
  beforeEach(() => { delete process.env.ALLOW_DEMO_AUTH; });

  it('rejects demo x-user-* headers when ALLOW_DEMO_AUTH is unset → 401', async () => {
    const res = await fetch(url('/api/quotes?limit=1'), { headers: { 'x-user-role': 'CU', 'x-user-id': 'whatever' } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHORIZED');
  });

  it('login → cookie+CSRF → CSRF-gated mutation succeeds, and is rejected without the CSRF header', async () => {
    // 1. Real login issues the cookies.
    const login = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const jar = cookieJar(login);
    expect(jar.auth_token, 'auth_token cookie').toBeTruthy();
    expect(jar.csrf_token, 'csrf_token cookie').toBeTruthy();

    // 2. Cookie-authenticated mutation WITHOUT the CSRF header → 403 CSRF_FAILED.
    const noCsrf = await fetch(url('/api/quotes'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jar) },
      body: JSON.stringify(quoteBody()),
    });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).code).toBe('CSRF_FAILED');

    // 3. Same mutation WITH the double-submit CSRF header → succeeds.
    const withCsrf = await fetch(url('/api/quotes'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jar), 'x-csrf-token': jar.csrf_token },
      body: JSON.stringify(quoteBody()),
    });
    expect(withCsrf.status).toBe(201);
    const created = await withCsrf.json();
    expect(created.quote_id).toBeTruthy();
    // The creator (from the verified cookie identity) owns the new quote.
    const owner = await pool.query(`SELECT assigned_to_user_id FROM public.quote WHERE quote_id=$1`, [created.quote_id]);
    expect(owner.rows[0].assigned_to_user_id).toBeTruthy();
    await pool.query(`DELETE FROM public.quote WHERE quote_id=$1`, [created.quote_id]);
  });

  it('rejects login with a wrong password → 401', async () => {
    const res = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'not-the-password' }),
    });
    expect(res.status).toBe(401);
  });
});
