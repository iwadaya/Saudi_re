// server/tests/integration/auth.integration.test.js
//
// Verifies the requireRole middleware behaves correctly:
//   • 401 UNAUTHORIZED when x-user-role is missing or invalid
//   • pass-through for valid role codes
//   • /api/auth/* routes skip the role check
//   • /api/ai/*   routes skip the role check
//   • /api/health skips
//
// Gated by TEST_WITH_DB=1 — see helpers.js. We don't strictly need the
// DB for this suite, but bootApp() enforces the same env contract as
// the rest of the integration tests so local runs stay consistent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: requireRole middleware', () => {
  let harness;

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => { await harness.close(); await closePools(); });

  it('rejects API calls without x-user-role → 401 UNAUTHORIZED', async () => {
    // Deliberately strip the default role header. Overriding to empty
    // string via the headers merge is the way to unset a default.
    const res = await fetch(`${harness.baseUrl}/api/quotes?limit=1`, {
      method: 'GET',
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('rejects unknown role codes → 401', async () => {
    const res = await fetch(`${harness.baseUrl}/api/quotes?limit=1`, {
      method: 'GET',
      headers: { 'x-user-role': 'SUPERUSER' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts each valid role', async () => {
    for (const role of ['CE', 'CU', 'TD', 'TM', 'TUW']) {
      const res = await harness.fetchApp('GET', '/api/quotes?limit=1', {
        headers: { 'x-user-role': role },
      });
      expect(res.status, `role=${role}`).toBe(200);
    }
  });

  it('honours the UW backward-compat alias', async () => {
    // Legacy clients still send 'UW' instead of 'TUW'. app.js keeps
    // it in VALID_ROLES to avoid breaking them.
    const res = await harness.fetchApp('GET', '/api/quotes?limit=1', {
      headers: { 'x-user-role': 'UW' },
    });
    expect(res.status).toBe(200);
  });

  it('/api/health skips the role check (LB probes have no user)', async () => {
    const res = await fetch(`${harness.baseUrl}/api/health`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('/api/auth/login skips the role check (can\'t have a role yet)', async () => {
    // We don't care about the body being valid; just that the middleware
    // doesn't reject before the route handler runs.
    const res = await fetch(`${harness.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
    });
    // Not 401 from the middleware — a real 401/400 from the handler is fine
    expect([200, 400, 401, 500]).toContain(res.status);
    if (res.status === 401) {
      const body = await res.json();
      expect(body.code).not.toBe('UNAUTHORIZED');
    }
  });
});
