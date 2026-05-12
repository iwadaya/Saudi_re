// server/tests/integration/helpers.js
// Shared utilities for integration tests. All tests in this folder
// share the same pattern: build the Express app once, spin up an
// ephemeral listener, hit it with native Node 20 fetch, tear down.
//
// The helpers here centralise that pattern so individual test files
// stay focused on assertions, not plumbing.

import { createApp } from '../../src/app.js';
import { closePools, verifyDatabaseConnection } from '../../src/db/pool.js';

/**
 * Boot the app on an ephemeral port. Returns an object with:
 *   fetch(method, path, opts?)  — makes a request, returns Response
 *   close()                     — stops the listener
 *   baseUrl                     — the ephemeral URL
 *
 * @param {object} [opts]
 * @param {boolean} [opts.verifyDb] — run verifyDatabaseConnection first
 *                                    (default true). Skip when the caller
 *                                    needs to test the DB-less path.
 */
export async function bootApp({ verifyDb = true } = {}) {
  if (verifyDb) await verifyDatabaseConnection();
  const app = createApp();
  const listener = await new Promise((resolve) => {
    const l = app.listen(0, () => resolve(l));
  });
  const { port } = listener.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function fetchApp(method, path, { body, headers } = {}) {
    const init = {
      method,
      headers: {
        // Default role — tests that want pre-auth should override
        'x-user-role': 'CU',
        'x-user-id':   '00000000-0000-0000-0000-000000000001',
        ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body == null
        ? undefined
        : (body instanceof FormData ? body : JSON.stringify(body)),
    };
    return await fetch(`${baseUrl}${path}`, init);
  }

  async function close() {
    await new Promise((r) => listener.close(r));
  }

  return { fetchApp, baseUrl, close, app };
}

/**
 * Run a test body only when TEST_WITH_DB=1. Gate every integration
 * test through this so the default `npm test` stays zero-infra.
 */
export const shouldSkipDb = process.env.TEST_WITH_DB !== '1';

/**
 * Close the process-wide pg pool. Call once at the end of the last
 * test file's afterAll — otherwise vitest hangs waiting for the pool
 * to drain. In a multi-file run, each file that boots the app should
 * `close()` its listener but only the last should `closePools()`.
 */
export { closePools };
