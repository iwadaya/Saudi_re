import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonCache, sendCached, invalidateJsonCache, cacheStats, cacheHeaders } from './httpCache.js';

// Reset cache between tests since the module-level Map is shared.
beforeEach(() => invalidateJsonCache(''));

function mkRes() {
  return {
    headers: {},
    body: null,
    statusCode: 200,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b)  { this.body = b; return this; },
    end()    { this.ended = true; return this; },
  };
}
function mkReq(headers = {}) { return { headers }; }

describe('jsonCache', () => {
  it('calls the loader on a miss and caches the value', async () => {
    const loader = vi.fn().mockResolvedValue([{ id: 1 }]);
    const a = await jsonCache({ key: 'k', ttlMs: 1000, loader });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a.fromCache).toBe(false);
    expect(a.value).toEqual([{ id: 1 }]);
    expect(a.etag).toMatch(/^W\/".+"$/);

    const b = await jsonCache({ key: 'k', ttlMs: 1000, loader });
    expect(loader).toHaveBeenCalledTimes(1); // cache hit, no second call
    expect(b.fromCache).toBe(true);
    expect(b.etag).toBe(a.etag); // same value → same etag
  });

  it('honours TTL expiry', async () => {
    const loader = vi.fn().mockResolvedValueOnce(['v1']).mockResolvedValueOnce(['v2']);
    await jsonCache({ key: 'k', ttlMs: 1, loader });
    await new Promise(r => setTimeout(r, 5));
    const second = await jsonCache({ key: 'k', ttlMs: 1, loader });
    expect(second.value).toEqual(['v2']);
    expect(second.fromCache).toBe(false);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('produces different ETags for different values', async () => {
    const a = await jsonCache({ key: 'a', ttlMs: 1000, loader: () => Promise.resolve({ x: 1 }) });
    const b = await jsonCache({ key: 'b', ttlMs: 1000, loader: () => Promise.resolve({ x: 2 }) });
    expect(a.etag).not.toBe(b.etag);
  });
});

describe('invalidateJsonCache', () => {
  it('drops keys by prefix', async () => {
    await jsonCache({ key: 'broker:list', ttlMs: 60_000, loader: () => Promise.resolve([1]) });
    await jsonCache({ key: 'broker:42',   ttlMs: 60_000, loader: () => Promise.resolve({ id: 42 }) });
    await jsonCache({ key: 'country:list', ttlMs: 60_000, loader: () => Promise.resolve([2]) });

    invalidateJsonCache('broker:');

    const stats = cacheStats();
    expect(stats.size).toBe(1);
    expect(stats.sampleKeys).toContain('country:list');
  });

  it('drops everything when called with empty string', async () => {
    await jsonCache({ key: 'x', ttlMs: 60_000, loader: () => Promise.resolve(1) });
    invalidateJsonCache('');
    expect(cacheStats().size).toBe(0);
  });
});

describe('sendCached', () => {
  it('returns 304 when If-None-Match matches the ETag', () => {
    const cached = { value: { hello: 'world' }, etag: 'W/"abc"' };
    const req = mkReq({ 'if-none-match': 'W/"abc"' });
    const res = mkRes();
    sendCached(req, res, cached);
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe(null);
    expect(res.headers.ETag).toBe('W/"abc"');
  });

  it('writes JSON + ETag + Cache-Control on a fresh request', () => {
    const cached = { value: [1, 2, 3], etag: 'W/"def"' };
    const req = mkReq();
    const res = mkRes();
    sendCached(req, res, cached, 600);
    expect(res.body).toEqual([1, 2, 3]);
    expect(res.headers.ETag).toBe('W/"def"');
    expect(res.headers['Cache-Control']).toBe('public, max-age=600, stale-while-revalidate=60');
    expect(res.headers.Vary).toBe('Accept-Encoding');
  });
});

describe('cacheHeaders middleware', () => {
  it('sets Cache-Control and Vary, then calls next', () => {
    const res = mkRes();
    const next = vi.fn();
    cacheHeaders(120)(mkReq(), res, next);
    expect(res.headers['Cache-Control']).toBe('public, max-age=120, stale-while-revalidate=60');
    expect(res.headers.Vary).toBe('Accept-Encoding, x-user-role');
    expect(next).toHaveBeenCalled();
  });

  it('marks private when opts.private', () => {
    const res = mkRes();
    cacheHeaders(60, { private: true })(mkReq(), res, vi.fn());
    expect(res.headers['Cache-Control']).toMatch(/^private, max-age=60/);
  });
});
