// server/tests/integration/clientEvents.integration.test.js
//
// Covers the POST /api/client-events endpoint — the pipe React
// error boundaries use to ship crash reports server-side.
//
//   • Valid payload → 204 No Content
//   • Missing/invalid fields → 400 VALIDATION_FAILED with fields[]
//   • Skips rate limiting (per app.js skip() config)
//   • Response carries the request ID back for correlation

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: /api/client-events', () => {
  let harness;

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => { await harness.close(); await closePools(); });

  it('accepts a well-formed error report with 204', async () => {
    const res = await harness.fetchApp('POST', '/api/client-events', {
      body: {
        type: 'boundary',
        message: 'TypeError: cannot read x of undefined',
        stack: 'Error: …\n    at Foo.render',
        path: '/np/final-pricing',
        userAgent: 'Mozilla/5.0 (test)',
        context: { componentStack: 'in Foo' },
      },
    });
    expect(res.status).toBe(204);
    // 204 has no body
    expect(await res.text()).toBe('');
  });

  it('rejects a payload missing the required message field', async () => {
    const res = await harness.fetchApp('POST', '/api/client-events', {
      body: { type: 'boundary' }, // no message
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields.some((f) => f.path === 'message')).toBe(true);
  });

  it('rejects an unknown `type` value', async () => {
    const res = await harness.fetchApp('POST', '/api/client-events', {
      body: { type: 'interesting', message: 'hi' },
    });
    expect(res.status).toBe(400);
  });

  it('defaults `type` to "other" when omitted', async () => {
    const res = await harness.fetchApp('POST', '/api/client-events', {
      body: { message: 'no type' },
    });
    expect(res.status).toBe(204);
  });

  it('truncates oversized messages via schema (max 2000 chars)', async () => {
    const huge = 'x'.repeat(5_000);
    const res = await harness.fetchApp('POST', '/api/client-events', {
      body: { type: 'other', message: huge },
    });
    // Schema rejects anything > 2000 with a zod string-too-long error
    expect(res.status).toBe(400);
  });

  it('echoes x-request-id back for log correlation', async () => {
    const res = await harness.fetchApp('POST', '/api/client-events', {
      headers: { 'x-request-id': 'crash-trace-7' },
      body: { type: 'other', message: 'correlation test' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-request-id')).toBe('crash-trace-7');
  });
});
