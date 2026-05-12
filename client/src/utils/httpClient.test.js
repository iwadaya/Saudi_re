import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpFetch, HttpError, getLastRequestId } from './httpClient.js';

// We stub global.fetch per test. Keep `sleep` synchronous in tests so
// we don't actually wait for backoff.
const immediate = () => Promise.resolve();

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => { vi.restoreAllMocks(); });

function okResponse(body = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
function errResponse(status, body = '') {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

describe('httpFetch', () => {
  it('returns the Response on a successful call', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ ok: true }));
    const res = await httpFetch('/api/thing', { sleep: immediate });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('throws HttpError with status + path on non-OK', async () => {
    global.fetch.mockResolvedValueOnce(errResponse(404, 'gone'));
    try {
      await httpFetch('/api/missing', { sleep: immediate });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e.status).toBe(404);
      expect(e.path).toBe('/api/missing');
      expect(e.message).toContain('/api/missing');
      expect(e.message).toContain('404');
    }
  });

  describe('retry policy', () => {
    it('retries on 503 for GET, up to 3 attempts by default', async () => {
      global.fetch
        .mockResolvedValueOnce(errResponse(503))
        .mockResolvedValueOnce(errResponse(503))
        .mockResolvedValueOnce(okResponse({ ok: true }));
      const res = await httpFetch('/api/flaky', { sleep: immediate });
      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry on 400 (client error)', async () => {
      global.fetch.mockResolvedValueOnce(errResponse(400, 'bad'));
      await expect(httpFetch('/api/x', { sleep: immediate })).rejects.toBeInstanceOf(HttpError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a non-idempotent POST by default', async () => {
      global.fetch
        .mockResolvedValueOnce(errResponse(503))
        .mockResolvedValueOnce(okResponse());
      await expect(
        httpFetch('/api/x', { method: 'POST', sleep: immediate }),
      ).rejects.toBeInstanceOf(HttpError);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('caller can opt into POST retries when they know the op is idempotent', async () => {
      global.fetch
        .mockResolvedValueOnce(errResponse(502))
        .mockResolvedValueOnce(okResponse({ ok: true }));
      const res = await httpFetch('/api/idempotent-post', {
        method: 'POST',
        retry: { methods: new Set(['POST']) },
        sleep: immediate,
      });
      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after max attempts', async () => {
      global.fetch.mockResolvedValue(errResponse(503));
      await expect(
        httpFetch('/api/never-works', { retry: { attempts: 2 }, sleep: immediate }),
      ).rejects.toThrow(/503/);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries on generic network error for GET', async () => {
      global.fetch
        .mockRejectedValueOnce(new TypeError('NetworkError'))
        .mockResolvedValueOnce(okResponse({ ok: true }));
      const res = await httpFetch('/api/x', { sleep: immediate });
      expect(res.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeouts + aborts', () => {
    it('surfaces a TIMEOUT error when the server is too slow', async () => {
      global.fetch.mockImplementationOnce((_url, init) => {
        return new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        });
      });
      await expect(
        httpFetch('/api/slow', { timeoutMs: 10, retry: { attempts: 1 }, sleep: immediate }),
      ).rejects.toThrow(/timeout after 10ms/);
    });

    it('honours an external AbortSignal and does not retry', async () => {
      const ctrl = new AbortController();
      global.fetch.mockImplementationOnce((_url, init) => {
        return new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        });
      });
      const p = httpFetch('/api/long', { signal: ctrl.signal, sleep: immediate });
      ctrl.abort();
      await expect(p).rejects.toThrow();
      // Only one fetch — the abort from the caller suppressed retries
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAttempt', () => {
    it('fires once per attempt for observability', async () => {
      global.fetch
        .mockResolvedValueOnce(errResponse(503))
        .mockResolvedValueOnce(okResponse());
      const onAttempt = vi.fn();
      await httpFetch('/api/x', { onAttempt, sleep: immediate });
      expect(onAttempt).toHaveBeenCalledTimes(2);
      expect(onAttempt).toHaveBeenNthCalledWith(1, 1);
      expect(onAttempt).toHaveBeenNthCalledWith(2, 2);
    });
  });

  describe('X-Request-Id', () => {
    it('auto-generates and forwards a request id per call', async () => {
      global.fetch.mockResolvedValueOnce(okResponse());
      await httpFetch('/api/x', { sleep: immediate });
      const [, init] = global.fetch.mock.calls[0];
      const id = init.headers['X-Request-Id'];
      expect(id).toBeTypeOf('string');
      expect(id.length).toBeGreaterThan(8);
      expect(getLastRequestId()).toBe(id);
    });

    it('reuses the same id across retries (single trace, not N)', async () => {
      global.fetch
        .mockResolvedValueOnce(errResponse(503))
        .mockResolvedValueOnce(okResponse());
      await httpFetch('/api/flaky', { sleep: immediate });
      const firstId = global.fetch.mock.calls[0][1].headers['X-Request-Id'];
      const secondId = global.fetch.mock.calls[1][1].headers['X-Request-Id'];
      expect(firstId).toBe(secondId);
    });

    it('preserves a caller-supplied request id instead of generating one', async () => {
      global.fetch.mockResolvedValueOnce(okResponse());
      await httpFetch('/api/x', {
        headers: { 'X-Request-Id': 'caller-123' },
        sleep: immediate,
      });
      const id = global.fetch.mock.calls[0][1].headers['X-Request-Id'];
      expect(id).toBe('caller-123');
    });

    it('is case-insensitive when detecting a caller-supplied id', async () => {
      global.fetch.mockResolvedValueOnce(okResponse());
      await httpFetch('/api/x', {
        headers: { 'x-request-id': 'lower-case' },
        sleep: immediate,
      });
      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers['x-request-id']).toBe('lower-case');
      expect(headers['X-Request-Id']).toBeUndefined();
    });
  });
});
