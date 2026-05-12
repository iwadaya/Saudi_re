import { describe, it, expect, vi } from 'vitest';
import { requestTimeout } from './requestTimeout.js';

function mkRes() {
  const handlers = {};
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    locals: { requestId: 'req-1' },
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
    on(event, fn) { handlers[event] = fn; },
    _emit(event)  { handlers[event] && handlers[event](); },
  };
}

describe('requestTimeout', () => {
  it('lets fast handlers through untouched', () => {
    const next = vi.fn();
    const res = mkRes();
    requestTimeout(1000)({ path: '/api/foo', method: 'GET' }, res, next);
    res._emit('finish');
    expect(next).toHaveBeenCalled();
    expect(res.body).toBe(null);
  });

  it('returns 503 REQUEST_TIMEOUT after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const res = mkRes();
      const next = vi.fn();
      requestTimeout(50)({ path: '/api/foo', method: 'POST', originalUrl: '/api/foo' }, res, next);
      vi.advanceTimersByTime(60);
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ code: 'REQUEST_TIMEOUT', requestId: 'req-1' });
    } finally { vi.useRealTimers(); }
  });

  it('does nothing if the response has already started', async () => {
    vi.useFakeTimers();
    try {
      const res = mkRes();
      res.headersSent = true;
      requestTimeout(10)({ path: '/api/foo', method: 'GET' }, res, vi.fn());
      vi.advanceTimersByTime(50);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(null);
    } finally { vi.useRealTimers(); }
  });

  it('skips the timer for /api/ai/*, mounted /ai/*, and /documents/*', () => {
    vi.useFakeTimers();
    try {
      // If the timer were installed, advancing would fire it. The path
      // skips it entirely, so res stays clean.
      const res = mkRes();
      requestTimeout(5)({ path: '/api/ai/slip-ingest', method: 'POST' }, res, vi.fn());
      vi.advanceTimersByTime(100);
      expect(res.statusCode).toBe(200);

      const mountedRes = mkRes();
      requestTimeout(5)({
        path: '/ai/slip-ingest',
        originalUrl: '/api/ai/slip-ingest',
        method: 'POST',
      }, mountedRes, vi.fn());
      vi.advanceTimersByTime(100);
      expect(mountedRes.statusCode).toBe(200);

      const res2 = mkRes();
      requestTimeout(5)({ path: '/api/treaties/123/documents', method: 'POST' }, res2, vi.fn());
      vi.advanceTimersByTime(100);
      expect(res2.statusCode).toBe(200);
    } finally { vi.useRealTimers(); }
  });
});
