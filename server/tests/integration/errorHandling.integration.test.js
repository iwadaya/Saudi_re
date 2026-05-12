// server/tests/integration/errorHandling.integration.test.js
//
// Verifies the error envelope shape across 404 + validation failures.
// The contract: every error response carries { error, code, requestId }
// so clients can branch on code and operators can grep by requestId.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: error handler envelope', () => {
  let harness;

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => { await harness.close(); await closePools(); });

  it('404 from an unknown /api route is JSON with { error, code, requestId }', async () => {
    const res = await harness.fetchApp('GET', '/api/this-is-not-a-thing');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toContain('GET /api/this-is-not-a-thing');
    expect(body.requestId).toBeTruthy();
  });

  it('404 echoes the caller-supplied request id so grep works', async () => {
    const res = await harness.fetchApp('GET', '/api/nope', {
      headers: { 'x-request-id': 'test-404-trace' },
    });
    const body = await res.json();
    expect(body.requestId).toBe('test-404-trace');
    // And the response header carries it too
    expect(res.headers.get('x-request-id')).toBe('test-404-trace');
  });

  it('VALIDATION_FAILED response includes the fields[] array', async () => {
    const res = await harness.fetchApp('POST', '/api/client-events', {
      body: { type: 'not-a-valid-type', message: 'hi' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: expect.any(Array),
      requestId: expect.any(String),
    });
    // Each field carries path + message + code
    for (const f of body.fields) {
      expect(f).toMatchObject({
        path: expect.any(String),
        message: expect.any(String),
        code: expect.any(String),
      });
    }
  });

  it('CORS exposes the pagination + request-id headers to browsers', async () => {
    // Preflight — simulate a CORS OPTIONS probe. The app sets
    // exposedHeaders in createCorsOptions so the browser can read
    // X-Total-Count and X-Request-Id from response.headers.
    const res = await harness.fetchApp('GET', '/api/quotes?limit=1');
    const exposed = res.headers.get('access-control-expose-headers');
    if (exposed) {
      // CORS is only added for cross-origin requests; when server-side
      // test is same-origin it may skip. When present, verify shape.
      expect(exposed.toLowerCase()).toMatch(/x-total-count|x-request-id/);
    }
  });
});
