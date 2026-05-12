// server/tests/integration/lookups.integration.test.js
//
// Verifies the in-memory ref cache + ETag flow on the lookup
// endpoints. These are the hottest reads in the app (every treaty
// detail screen open fires 5+ of them) so the cache + 304 behaviour
// is a real scalability lever.
//
// Covers:
//   • First GET populates the cache and emits an ETag
//   • If-None-Match with the same ETag → 304 Not Modified
//   • DELETE /api/ref/cache flushes + forces a re-compute
//   • Cache-Control header is set so browsers cache too

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: /api lookup cache + ETag', () => {
  let harness;

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => { await harness.close(); await closePools(); });

  it.each([
    '/api/brokers',
    '/api/reinsurers',
    '/api/treaty-types',
    '/api/class-of-business',
    '/api/ref/lists/country/items',
    '/api/ref/lists/currency/items',
  ])('%s returns an ETag + Cache-Control on the first hit', async (path) => {
    const res = await harness.fetchApp('GET', path);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\//);
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
  });

  it('If-None-Match with the cached ETag → 304 Not Modified', async () => {
    const first = await harness.fetchApp('GET', '/api/brokers');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await harness.fetchApp('GET', '/api/brokers', {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    // 304 has no body — text() should return ''
    const body = await second.text();
    expect(body).toBe('');
  });

  it('DELETE /api/ref/cache clears the in-memory store', async () => {
    // Warm the cache
    await harness.fetchApp('GET', '/api/brokers');
    // Flush
    const flushRes = await harness.fetchApp('DELETE', '/api/ref/cache');
    expect(flushRes.status).toBe(200);
    const flushBody = await flushRes.json();
    expect(flushBody.cleared).toBe(true);

    // Next GET should still 200 and produce an ETag (re-hydrated from DB)
    const again = await harness.fetchApp('GET', '/api/brokers');
    expect(again.status).toBe(200);
    expect(again.headers.get('etag')).toBeTruthy();
  });

  it('ETag is stable while data is cached (same content → same ETag)', async () => {
    const first  = await harness.fetchApp('GET', '/api/treaty-types');
    const second = await harness.fetchApp('GET', '/api/treaty-types');
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
  });
});
