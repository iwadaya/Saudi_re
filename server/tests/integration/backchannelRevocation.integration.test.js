// server/tests/integration/backchannelRevocation.integration.test.js
//
// P1-identity Phase 1b — the IdP-session-targeted revocation primitives that the
// back-channel logout endpoint drives. Mints real sessions carrying idp_sid /
// idp_sub (as createSession does for SSO logins) and proves:
//   • revokeSessionsByIdpSid kills exactly the matching device session;
//   • revokeSessionsByIdpSub kills every session for the IdP subject;
// each verified through the REAL authenticate() middleware (200 → 401). DB-gated.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { hashPassword } from '../../src/routes/auth.js';
import { createSession, revokeSessionsByIdpSid, revokeSessionsByIdpSub } from '../../src/services/sessions.js';
import { signAuthToken } from '../../src/lib/authToken.js';

describe.skipIf(shouldSkipDb)('integration: back-channel session revocation (Phase 1b)', () => {
  let harness;
  const createdUserIds = [];

  const url = (p) => `${harness.baseUrl}${p}`;
  const meStatus = async (token) => (await fetch(url('/api/auth/me'), { headers: { cookie: `auth_token=${token}` } })).status;

  async function makeUser() {
    const sfx = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    const username = `p1b_${sfx}`.toLowerCase();
    const role = await pool.query(`SELECT role_id FROM public.uw_role WHERE role_code='CU' LIMIT 1`);
    const ins = await pool.query(
      `INSERT INTO public.uw_user (email, username, display_name, role_id, is_active, password_hash, auth_provider, idp_subject)
       VALUES ($1,$2,'P1b User',$3,true,$4,'SSO',$5) RETURNING user_id`,
      [`${username}@example.test`, username, role.rows[0].role_id, await hashPassword('x-not-used'), `idp|${username}`],
    );
    const id = ins.rows[0].user_id;
    createdUserIds.push(id);
    return { id, idpSub: `idp|${username}` };
  }

  // Mint a real SSO-style session carrying idp_sid/idp_sub + its cookie token.
  async function mintSsoSession(userId, idpSub, idpSid) {
    const sess = await createSession({ userId, authMethod: 'SSO_OIDC', idpSub, idpSid });
    return signAuthToken({ sub: userId, sid: sess.sessionId, epoch: sess.epoch });
  }

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => {
    for (const id of createdUserIds) { try { await pool.query(`DELETE FROM public.uw_user WHERE user_id=$1`, [id]); } catch {} }
    if (harness) await harness.close();
    await closePools();
  });

  it('revokeSessionsByIdpSid kills only the matching IdP session', async () => {
    const { id, idpSub } = await makeUser();
    const a = await mintSsoSession(id, idpSub, 'idp-sid-A');
    const b = await mintSsoSession(id, idpSub, 'idp-sid-B');
    expect(await meStatus(a)).toBe(200);
    expect(await meStatus(b)).toBe(200);

    const n = await revokeSessionsByIdpSid('idp-sid-A');
    expect(n).toBe(1);
    expect(await meStatus(a)).toBe(401); // A's IdP session ended
    expect(await meStatus(b)).toBe(200); // B untouched
  });

  it('revokeSessionsByIdpSub kills every session for the subject', async () => {
    const { id, idpSub } = await makeUser();
    const a = await mintSsoSession(id, idpSub, 'sid-1');
    const b = await mintSsoSession(id, idpSub, 'sid-2');
    expect(await meStatus(a)).toBe(200);
    expect(await meStatus(b)).toBe(200);

    const n = await revokeSessionsByIdpSub(idpSub);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await meStatus(a)).toBe(401);
    expect(await meStatus(b)).toBe(401);
  });
});
