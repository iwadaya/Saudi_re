// Unit tests for isReadOnlyError — the detector the pricing editors use to flip
// themselves read-only on a 403 READ_ONLY and STOP re-POSTing.
import { describe, it, expect } from 'vitest';
import { isReadOnlyError } from './readOnlyError.js';

const httpError = ({ status, body }) => Object.assign(new Error(body?.error || 'err'), { status, body });

describe('isReadOnlyError', () => {
  it('detects the server READ_ONLY code (httpClient error.body)', () => {
    expect(isReadOnlyError(httpError({ status: 403, body: { error: 'read-only', code: 'READ_ONLY' } }))).toBe(true);
  });

  it('detects READ_ONLY even when the body is a JSON string', () => {
    expect(isReadOnlyError({ status: 403, body: JSON.stringify({ code: 'READ_ONLY' }) })).toBe(true);
  });

  it('detects READ_ONLY from an axios-style response.data', () => {
    expect(isReadOnlyError({ response: { status: 403, data: { code: 'READ_ONLY' } } })).toBe(true);
  });

  it('falls back to a 403 whose message says read-only (non-JSON body)', () => {
    expect(isReadOnlyError({ status: 403, body: 'This treaty is read-only.' })).toBe(true);
  });

  it('is false for other authz / transient errors', () => {
    expect(isReadOnlyError(httpError({ status: 403, body: { error: 'forbidden', code: 'FORBIDDEN' } }))).toBe(false);
    expect(isReadOnlyError(httpError({ status: 409, body: { code: 'STALE_WRITE' } }))).toBe(false);
    expect(isReadOnlyError(httpError({ status: 500, body: { error: 'boom' } }))).toBe(false);
    expect(isReadOnlyError(new Error('network'))).toBe(false);
    expect(isReadOnlyError(null)).toBe(false);
    expect(isReadOnlyError(undefined)).toBe(false);
  });
});
