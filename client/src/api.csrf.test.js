// api.ts request primitive — cookie auth + CSRF double-submit wiring.
// Mocks the httpFetch transport so we can assert exactly what init the client
// hands to fetch: credentials mode, the X-CSRF-Token header on mutations, and
// the absence of any Authorization header (the token lives only in the cookie).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { httpFetchMock } = vi.hoisted(() => ({ httpFetchMock: vi.fn() }));
vi.mock('./utils/httpClient.js', () => ({
  httpFetch: httpFetchMock,
  HttpError: class HttpError extends Error {},
}));

import { api } from './api';
import { setSession, clearSession } from './utils/auth';

function jsonRes(body) {
  return {
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  httpFetchMock.mockReset();
  httpFetchMock.mockResolvedValue(jsonRes({ ok: true }));
  localStorage.clear();
  clearSession();
  document.cookie = 'csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

describe('api request — cookie auth + CSRF double-submit', () => {
  it('sends credentials:include on every request (so the httpOnly cookie rides)', async () => {
    await api.getHomeSummary();
    const [, init] = httpFetchMock.mock.calls[0];
    expect(init.credentials).toBe('include');
  });

  it('attaches X-CSRF-Token from the readable csrf cookie on mutations', async () => {
    document.cookie = 'csrf_token=tok123.sig';
    await api.logout();
    const [url, init] = httpFetchMock.mock.calls[0];
    expect(url).toContain('/api/auth/logout');
    expect(init.headers['X-CSRF-Token']).toBe('tok123.sig');
    expect(init.credentials).toBe('include');
  });

  it('does NOT attach a CSRF header on GETs (the server exempts them)', async () => {
    document.cookie = 'csrf_token=tok123.sig';
    await api.getHomeSummary();
    const [, init] = httpFetchMock.mock.calls[0];
    expect(init.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('never sends an Authorization header, even if a token leaked into the session', async () => {
    setSession({ userId: 'u1', roleCode: 'CU', hierarchyLevel: 2, token: 'should-be-ignored' });
    await api.getHomeSummary();
    const [, init] = httpFetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    // …and the token never reached localStorage either.
    expect(JSON.stringify(localStorage)).not.toContain('should-be-ignored');
  });
});
