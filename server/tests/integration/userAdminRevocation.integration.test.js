// server/tests/integration/userAdminRevocation.integration.test.js
//
// P1-identity Phase 0b — revoke-on-(password-change / role-change / deactivation /
// mandate-change), critical user-admin audit, and fail-closed registration.
//
// Builds on Phase 0a (server-side sessions + epoch). Each privilege change must:
//   • revoke EVERY outstanding session for the affected user (epoch bump), so a
//     stale token can't keep acting — proven by minting a real session and
//     watching /auth/me flip 200 → 401 across the change;
//   • on a self-service password change, keep the CURRENT device alive by
//     re-issuing its session (the response carries a fresh auth cookie);
//   • write a CRITICAL audit row (USER eventType) in the SAME transaction.
//
// Open self-registration is fail-closed: an anonymous create is 403 unless the
// explicit dev flag is set. Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { hashPassword } from '../../src/routes/auth.js';
import { createSession } from '../../src/services/sessions.js';
import { signAuthToken } from '../../src/lib/authToken.js';

const STRONG_PW = 'Phase0b-Adm1n-Rev0ke!';

describe.skipIf(shouldSkipDb)('integration: user-admin revocation + audit (Phase 0b)', () => {
  let harness;
  let tuwRoleId;
  let tdRoleId;
  const createdUserIds = [];

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
  const meStatus = async (jar) => (await fetch(url('/api/auth/me'), { headers: { cookie: cookieHeader(jar) } })).status;

  // A real DB user with a known password; returns its id + username.
  async function makeUser(roleId = tuwRoleId) {
    const sfx = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    const username = `p0b_${sfx}`.toLowerCase();
    const ins = await pool.query(
      `INSERT INTO public.uw_user (email, username, display_name, role_id, is_active, password_hash)
       VALUES ($1,$2,'Phase0b User',$3,true,$4) RETURNING user_id`,
      [`${username}@example.test`, username, roleId, hashPassword(STRONG_PW)],
    );
    const id = ins.rows[0].user_id;
    createdUserIds.push(id);
    return { id, username };
  }

  // Mint a real session + cookie for a user (no login endpoint → no rate limiter).
  async function mintSession(userId) {
    const sess = await createSession({ userId, authMethod: 'PASSWORD' });
    return { auth_token: signAuthToken({ sub: userId, sid: sess.sessionId, epoch: sess.epoch }) };
  }

  // Admin action as the demo Chief Underwriter (header auth → no CSRF needed).
  const adminFetch = (method, path, body) => harness.fetchApp(method, path, { headers: { 'x-user-role': 'CU' }, body });

  async function auditEventTypes(entityId) {
    const { rows } = await pool.query(
      `SELECT event_type, payload FROM public.audit_log WHERE entity_type='USER' AND entity_id=$1 ORDER BY created_at`,
      [entityId],
    );
    return rows;
  }

  beforeAll(async () => {
    harness = await bootApp();
    const roles = await pool.query(`SELECT role_id, role_code FROM public.uw_role WHERE role_code IN ('TUW','UW','TD')`);
    tuwRoleId = (roles.rows.find((r) => r.role_code === 'TUW' || r.role_code === 'UW') || roles.rows[0]).role_id;
    tdRoleId = (roles.rows.find((r) => r.role_code === 'TD') || roles.rows[0]).role_id;
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      try { await pool.query(`DELETE FROM public.uw_user WHERE user_id=$1`, [id]); } catch {}
    }
    if (harness) await harness.close();
    await closePools();
  });

  it('change-password revokes OTHER sessions but keeps THIS device alive, and writes a critical PASSWORD_CHANGED row', async () => {
    const { id, username } = await makeUser();

    // Device A logs in over HTTP (gets auth + csrf cookies); device B is a second
    // real session minted directly.
    const login = await fetch(url('/api/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: STRONG_PW }),
    });
    expect(login.status).toBe(200);
    const jarA = cookieJar(login);
    const deviceB = await mintSession(id);
    expect(await meStatus(jarA)).toBe(200);
    expect(await meStatus(deviceB)).toBe(200);

    // Device A changes its own password (double-submit CSRF from the login cookie).
    const newPw = 'Phase0b-N3w-Passw0rd!';
    const res = await fetch(url('/api/auth/change-password'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(jarA), 'x-csrf-token': jarA.csrf_token },
      body: JSON.stringify({ currentPassword: STRONG_PW, newPassword: newPw, confirmPassword: newPw }),
    });
    expect(res.status).toBe(200);

    // The response re-issues device A's session in a fresh auth cookie.
    const jarA2 = { ...jarA, ...cookieJar(res) };
    expect(jarA2.auth_token).toBeTruthy();
    expect(jarA2.auth_token).not.toBe(jarA.auth_token);

    expect(await meStatus(jarA2)).toBe(200);    // current device stays logged in
    expect(await meStatus(jarA)).toBe(401);     // the pre-change token is dead
    expect(await meStatus(deviceB)).toBe(401);  // every other device forced out

    const events = await auditEventTypes(id);
    const pw = events.find((e) => e.event_type === 'PASSWORD_CHANGED');
    expect(pw).toBeTruthy();
    expect(pw.payload?.sessions_revoked).toBe(true);
  });

  it('PATCH /auth/users role change forces re-login + writes USER_ROLE_CHANGED', async () => {
    const { id } = await makeUser();
    const sess = await mintSession(id);
    expect(await meStatus(sess)).toBe(200);

    const res = await adminFetch('PATCH', `/api/auth/users/${id}`, { role_id: tdRoleId });
    expect(res.status).toBe(200);

    expect(await meStatus(sess)).toBe(401); // epoch bumped → token dead
    const events = await auditEventTypes(id);
    expect(events.some((e) => e.event_type === 'USER_ROLE_CHANGED')).toBe(true);
  });

  it('PATCH /auth/users deactivation forces re-login + writes USER_DEACTIVATED', async () => {
    const { id } = await makeUser();
    const sess = await mintSession(id);
    expect(await meStatus(sess)).toBe(200);

    const res = await adminFetch('PATCH', `/api/auth/users/${id}`, { is_active: false });
    expect(res.status).toBe(200);

    expect(await meStatus(sess)).toBe(401);
    const events = await auditEventTypes(id);
    expect(events.some((e) => e.event_type === 'USER_DEACTIVATED')).toBe(true);
  });

  it('PATCH /auth/users benign change (office) keeps the session alive + writes USER_UPDATED', async () => {
    const { id } = await makeUser();
    const sess = await mintSession(id);
    expect(await meStatus(sess)).toBe(200);

    const res = await adminFetch('PATCH', `/api/auth/users/${id}`, { office: 'Dubai' });
    expect(res.status).toBe(200);

    expect(await meStatus(sess)).toBe(200); // no authority change → session survives
    const events = await auditEventTypes(id);
    expect(events.some((e) => e.event_type === 'USER_UPDATED')).toBe(true);
  });

  it('PUT /auth/mandates authority change forces re-login + writes MANDATE_UPDATED', async () => {
    const { id } = await makeUser();
    const sess = await mintSession(id);
    expect(await meStatus(sess)).toBe(200);

    const res = await adminFetch('PUT', `/api/auth/mandates/${id}`, { treaty_limit_usd: 5_000_000 });
    expect(res.status).toBe(200);

    expect(await meStatus(sess)).toBe(401);
    const { rows } = await pool.query(
      `SELECT event_type, payload FROM public.audit_log WHERE entity_type='USER_MANDATE' AND entity_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(rows[0]?.event_type).toBe('MANDATE_UPDATED');
    expect(rows[0]?.payload?.changed_authority).toContain('treaty_limit_usd');
  });

  it('open self-registration is fail-closed: anonymous create → 403 without the dev flag', async () => {
    const prev = process.env.ALLOW_OPEN_REGISTRATION;
    delete process.env.ALLOW_OPEN_REGISTRATION;
    try {
      // No identity at all (blank role header → anonymous under ALLOW_DEMO_AUTH).
      const res = await harness.fetchApp('POST', '/api/auth/users', {
        headers: { 'x-user-role': '', 'x-user-id': '' },
        body: { first_name: 'Mal', surname: 'Lory', role_code: 'TUW', password: STRONG_PW, confirm_password: STRONG_PW },
      });
      expect(res.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_OPEN_REGISTRATION;
      else process.env.ALLOW_OPEN_REGISTRATION = prev;
    }
  });
});
