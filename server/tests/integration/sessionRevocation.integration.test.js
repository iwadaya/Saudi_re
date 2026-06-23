// server/tests/integration/sessionRevocation.integration.test.js
//
// P1-identity Phase 0a — server-side session revocation (denial tests).
// A login creates an auth_session row; the cookie token carries its `sid` + the
// user's `epoch`. authenticate() validates the live session + epoch on every
// request. This proves:
//   • end-to-end: HTTP login authenticates; HTTP logout revokes THIS session →
//     the same cookie is dead immediately;
//   • per-device: revoking one session leaves another session alive;
//   • revokeAllForUser (epoch bump) kills every outstanding token at once;
//   • an expired session row is rejected.
//
// The multi-session cases mint sessions directly through the service (so they
// don't trip the login brute-force limiter), but still go through the REAL
// authenticate() middleware on each /auth/me call. Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { hashPassword } from '../../src/routes/auth.js';
import { createSession, revokeSession, revokeAllForUser } from '../../src/services/sessions.js';
import { signAuthToken } from '../../src/lib/authToken.js';

const PASSWORD = 'S3ssion-Rev0cation-Pass!';

describe.skipIf(shouldSkipDb)('integration: session revocation (Phase 0a)', () => {
  let harness;
  let username;
  let userId;

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
  // /api/auth/me is a clean authenticated read: 200 while the session is live, 401 once not.
  const meStatus = async (jar) => (await fetch(url('/api/auth/me'), { headers: { cookie: cookieHeader(jar) } })).status;

  // Mint a real session + cookie token directly (no login endpoint → no limiter).
  async function mintSession() {
    const sess = await createSession({ userId, authMethod: 'PASSWORD' });
    const token = signAuthToken({ sub: userId, sid: sess.sessionId, epoch: sess.epoch });
    return { jar: { auth_token: token }, sessionId: sess.sessionId };
  }

  beforeAll(async () => {
    harness = await bootApp();
    const sfx = `${Date.now()}-${process.pid}`;
    username = `sessrev_${sfx}`.toLowerCase();
    const role = await pool.query(`SELECT role_id FROM public.uw_role WHERE role_code='CU' LIMIT 1`);
    const ins = await pool.query(
      `INSERT INTO public.uw_user (email, username, display_name, role_id, is_active, password_hash)
       VALUES ($1,$2,'Session Revocation User',$3,true,$4) RETURNING user_id`,
      [`${username}@example.test`, username, role.rows[0].role_id, await hashPassword(PASSWORD)],
    );
    userId = ins.rows[0].user_id;
  });

  afterAll(async () => {
    try { await pool.query(`DELETE FROM public.uw_user WHERE user_id=$1`, [userId]); } catch {}
    if (harness) await harness.close();
    await closePools();
  });

  it('end-to-end: HTTP login authenticates; HTTP logout kills the SAME cookie (401)', async () => {
    const login = await fetch(url('/api/auth/login'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const jar = cookieJar(login);
    expect(jar.auth_token).toBeTruthy();
    expect(await meStatus(jar)).toBe(200);

    const logout = await fetch(url('/api/auth/logout'), { method: 'POST', headers: { cookie: cookieHeader(jar) } });
    expect(logout.status).toBe(200);
    expect(await meStatus(jar)).toBe(401); // session row revoked → cookie dead
  });

  it('per-device: revoking one session leaves another alive', async () => {
    const a = await mintSession();
    const b = await mintSession();
    expect(await meStatus(a.jar)).toBe(200);
    expect(await meStatus(b.jar)).toBe(200);

    expect(await revokeSession(a.sessionId, 'LOGOUT')).toBe(true);
    expect(await meStatus(a.jar)).toBe(401); // device A revoked
    expect(await meStatus(b.jar)).toBe(200); // device B unaffected
  });

  it('revokeAllForUser (epoch bump) kills every outstanding session at once', async () => {
    const a = await mintSession();
    const b = await mintSession();
    expect(await meStatus(a.jar)).toBe(200);
    expect(await meStatus(b.jar)).toBe(200);

    const revoked = await revokeAllForUser(userId, 'ROLE_CHANGE');
    expect(revoked).toBeGreaterThanOrEqual(2);

    expect(await meStatus(a.jar)).toBe(401); // epoch bumped → stale token
    expect(await meStatus(b.jar)).toBe(401);
  });

  it('an expired session row is rejected', async () => {
    const a = await mintSession();
    expect(await meStatus(a.jar)).toBe(200);
    await pool.query(`UPDATE public.auth_session SET expires_at = now() - interval '1 hour' WHERE session_id=$1`, [a.sessionId]);
    expect(await meStatus(a.jar)).toBe(401);
  });

  it('a token without a session id (legacy/forged-shape) is rejected', async () => {
    const token = signAuthToken({ sub: userId }); // no sid
    expect(await meStatus({ auth_token: token })).toBe(401);
  });
});
