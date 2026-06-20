// JIT SSO provisioning unit tests (no DB — a fake transaction client).
//
// Covers: first-seen subject → create (low-priv default role + SSO link),
// returning subject with an unchanged role, a role re-map across logins
// (roleChanged=true), username de-duplication, and the role-not-found guard.

import { describe, it, expect, vi } from 'vitest';
import { provisionFromClaims } from './provisioning.js';
import { getIdentityConfig } from '../../config/identity.js';

// Map a 'groups' claim → roles so we can exercise mapClaimsToRole through here.
const cfg = getIdentityConfig({ IDENTITY_ROLE_CLAIM: 'groups', IDENTITY_ROLE_MAP: '{"chiefs":"CU"}' });

// Build a fake pg client. `roleByCode` resolves the uw_role lookup; `existing`
// is the current uw_user row for the subject (null = first-seen); takenUsernames
// forces username de-dup. Records inserts/updates for assertions.
function fakeClient({ roleByCode = { TUW: 'role-tuw', CU: 'role-cu' }, existing = null, takenUsernames = [] } = {}) {
  const calls = { insertUser: null, updateUser: null, insertMandate: null };
  const client = {
    calls,
    query: vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM public.uw_role WHERE role_code')) {
        return { rows: roleByCode[params[0]] ? [{ role_id: roleByCode[params[0]] }] : [] };
      }
      if (sql.includes('FROM public.uw_user WHERE idp_subject')) {
        return { rows: existing ? [existing] : [] };
      }
      if (sql.includes('UPDATE public.uw_user')) {
        calls.updateUser = { userId: params[0], roleId: params[1], displayName: params[2], email: params[3] };
        return { rows: [] };
      }
      if (sql.startsWith('\n') && sql.includes('SELECT 1 FROM public.uw_user WHERE username')) {
        return { rows: takenUsernames.includes(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('SELECT 1 FROM public.uw_user WHERE username')) {
        return { rows: takenUsernames.includes(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('INSERT INTO public.uw_user')) {
        calls.insertUser = { username: params[0], displayName: params[1], email: params[2], roleId: params[3], passwordHash: params[5], idpSubject: params[6] };
        return { rows: [{ user_id: 'new-sso-user', username: params[0] }] };
      }
      if (sql.includes('INSERT INTO public.user_mandate')) {
        calls.insertMandate = { userId: params[0] };
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return client;
}

describe('provisionFromClaims', () => {
  it('first-seen subject → creates an SSO-linked, low-privilege user (D3)', async () => {
    const cl = fakeClient();
    const claims = { sub: 'idp|abc', email: 'New.User@corp.com', name: 'New User', groups: ['unmapped'] };
    const out = await provisionFromClaims(cl, claims, cfg);

    expect(out.created).toBe(true);
    expect(out.roleChanged).toBe(false);
    expect(out.roleCode).toBe('TUW');                 // unmapped → default low-priv
    expect(cl.calls.insertUser.idpSubject).toBe('idp|abc');
    expect(cl.calls.insertUser.roleId).toBe('role-tuw');
    expect(cl.calls.insertUser.username).toBe('new.user'); // from email local-part
    expect(cl.calls.insertUser.passwordHash.startsWith('scrypt$')).toBe(false); // no usable local password
    expect(cl.calls.insertMandate.userId).toBe('new-sso-user');
  });

  it('maps an elevated role from the configured claim', async () => {
    const cl = fakeClient();
    const out = await provisionFromClaims(cl, { sub: 's1', email: 'c@x.com', groups: ['chiefs'] }, cfg);
    expect(out.roleCode).toBe('CU');
    expect(cl.calls.insertUser.roleId).toBe('role-cu');
  });

  it('returning subject, same role → update, roleChanged=false', async () => {
    const cl = fakeClient({ existing: { user_id: 'u1', username: 'c.user', role_id: 'role-cu', is_active: true } });
    const out = await provisionFromClaims(cl, { sub: 's1', email: 'c@x.com', groups: ['chiefs'] }, cfg);
    expect(out.created).toBe(false);
    expect(out.roleChanged).toBe(false);
    expect(cl.calls.updateUser.userId).toBe('u1');
    expect(cl.calls.updateUser.roleId).toBe('role-cu');
  });

  it('returning subject, role re-mapped → roleChanged=true (forces re-login upstream)', async () => {
    const cl = fakeClient({ existing: { user_id: 'u1', username: 'c.user', role_id: 'role-tuw', is_active: true } });
    const out = await provisionFromClaims(cl, { sub: 's1', email: 'c@x.com', groups: ['chiefs'] }, cfg);
    expect(out.roleChanged).toBe(true);
    expect(cl.calls.updateUser.roleId).toBe('role-cu');
  });

  it('de-duplicates the derived username against a different user', async () => {
    const cl = fakeClient({ takenUsernames: ['new.user'] });
    const out = await provisionFromClaims(cl, { sub: 'idp|abc', email: 'New.User@corp.com' }, cfg);
    expect(out.username).toBe('new.user2');
  });

  it('throws when claims lack a subject', async () => {
    await expect(provisionFromClaims(fakeClient(), {}, cfg)).rejects.toThrow(/sub is required/);
  });

  it('throws when the mapped role is missing from uw_role', async () => {
    const cl = fakeClient({ roleByCode: {} });
    await expect(provisionFromClaims(cl, { sub: 's1' }, cfg)).rejects.toThrow(/not found in uw_role/);
  });
});
