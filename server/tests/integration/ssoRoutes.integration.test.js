// server/tests/integration/ssoRoutes.integration.test.js
//
// P1-identity Phase 1a — proves the SSO router is mounted in the real app
// (through authenticate/CSRF/passwordGate) and is INERT while SSO is off: both
// public GET endpoints return 404 SSO_DISABLED in the default posture, with no
// auth required. Gated by TEST_WITH_DB=1 (uses the standard app harness).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: SSO routes (Phase 1a, inert while off)', () => {
  let harness;
  const prev = process.env.IDENTITY_SSO_ENABLED;

  beforeAll(async () => {
    delete process.env.IDENTITY_SSO_ENABLED; // default posture: SSO off
    harness = await bootApp();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.IDENTITY_SSO_ENABLED;
    else process.env.IDENTITY_SSO_ENABLED = prev;
    if (harness) await harness.close();
    await closePools();
  });

  const get = (p) => fetch(`${harness.baseUrl}${p}`, { redirect: 'manual' });

  it('GET /api/auth/sso/login → 404 SSO_DISABLED (no auth needed)', async () => {
    const res = await get('/api/auth/sso/login');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('SSO_DISABLED');
  });

  it('GET /api/auth/sso/callback → 404 SSO_DISABLED', async () => {
    const res = await get('/api/auth/sso/callback?code=x&state=y');
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('SSO_DISABLED');
  });
});
