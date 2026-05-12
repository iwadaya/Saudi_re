// tests/smoke.test.js
// "Does the server load at all" — fast safety net that catches import
// errors, missing exports, and circular deps before they hit prod.
//
// Skips the actual DB connection because Vitest unit runs shouldn't
// need a Postgres instance. The DB pool gets constructed lazily so
// importing the modules is safe even without DATABASE_URL set.

import { describe, it, expect } from 'vitest';

describe('server module smoke test', () => {
  it('app.js imports cleanly', async () => {
    const mod = await import('../src/app.js');
    expect(mod.createApp).toBeTypeOf('function');
  });

  it('all route modules import without errors', async () => {
    await Promise.all([
      import('../src/routes/quotes.js'),
      import('../src/routes/treaties.js'),
      import('../src/routes/auth.js'),
      import('../src/routes/lookups.js'),
      import('../src/routes/nonProp.js'),
      import('../src/routes/treatyData.js'),
      import('../src/routes/facultative.js'),
      import('../src/routes/dashboard.js'),
      import('../src/routes/home.js'),
      import('../src/routes/ai.js'),
      import('../src/routes/quoteLifecycle.js'),
      import('../src/routes/assignments.js'),
      import('../src/routes/pricing.js'),
    ]);
    // If any of the above threw, vitest fails this test with the message.
    expect(true).toBe(true);
  });

  it('middleware modules export the expected shapes', async () => {
    const { errorHandler, notFoundHandler } = await import('../src/middleware/errorHandler.js');
    const { attachRequestId } = await import('../src/middleware/requestId.js');
    const { attachRequestContext } = await import('../src/middleware/requestContext.js');
    const { requestTimeout } = await import('../src/middleware/requestTimeout.js');
    const { cacheHeaders, jsonCache, sendCached } = await import('../src/middleware/httpCache.js');

    expect(errorHandler).toBeTypeOf('function');
    expect(notFoundHandler).toBeTypeOf('function');
    expect(attachRequestId).toBeTypeOf('function');
    expect(attachRequestContext).toBeTypeOf('function');
    expect(requestTimeout(1000)).toBeTypeOf('function');
    expect(cacheHeaders(60)).toBeTypeOf('function');
    expect(jsonCache).toBeTypeOf('function');
    expect(sendCached).toBeTypeOf('function');
  });

  it('createApp() builds an Express app with the expected wiring', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    // Express app is a function with a .listen method
    expect(app).toBeTypeOf('function');
    expect(app.listen).toBeTypeOf('function');
    expect(app.use).toBeTypeOf('function');
  });
});
