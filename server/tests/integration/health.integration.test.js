// server/tests/integration/health.integration.test.js
//
// Integration tests for the health endpoints. Gated by TEST_WITH_DB=1 so
// the default `npm test` run stays fast + zero-infrastructure. Run with:
//   TEST_WITH_DB=1 DATABASE_URL=postgres://... npm run test:server

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: /api/health', () => {
  let harness;

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => { await harness.close(); await closePools(); });

  it('GET /api/health returns ok without a DB round-trip', async () => {
    const res = await harness.fetchApp('GET', '/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    // The light health check does NOT include a db block
    expect(body.db).toBeUndefined();
  });

  it('GET /api/health/deep includes pool stats', async () => {
    const res = await harness.fetchApp('GET', '/api/health/deep');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.db.ok).toBe(true);
    expect(body.db.pool).toMatchObject({
      max: expect.any(Number),
      idleCount: expect.any(Number),
    });
    // X-Pool-Waiting header is always present on this endpoint
    expect(res.headers.get('x-pool-waiting')).toBeDefined();
  });

  it('echoes x-request-id back to the caller', async () => {
    // The client sets this header; server reuses it so the trace
    // correlates across tiers. Also generates one when missing.
    const res = await harness.fetchApp('GET', '/api/health', {
      headers: { 'x-request-id': 'test-trace-42' },
    });
    expect(res.headers.get('x-request-id')).toBe('test-trace-42');
  });

  it('generates a request id when the caller omits one', async () => {
    const res = await harness.fetchApp('GET', '/api/health');
    const id = res.headers.get('x-request-id');
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThan(8);
  });
});
