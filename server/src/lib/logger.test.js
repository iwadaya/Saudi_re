// server/src/lib/logger.js unit tests.
//
// The logger serializes { ts, level, message, ...meta } to a single JSON line on
// console.log (info/debug) or console.error (warn/error). These tests focus on
// the G3 secret/PII redaction pass in that serialization path.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from './logger.js';

afterEach(() => vi.restoreAllMocks());

// Run `fn` with console.log/console.error captured, and return the parsed JSON
// payload of the first line written (whichever stream the level uses).
function capture(fn) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  fn();
  const line = (logSpy.mock.calls[0] || errSpy.mock.calls[0] || [])[0];
  return line ? JSON.parse(line) : null;
}

const DENYLIST = ['password', 'pass', 'token', 'secret', 'authorization', 'cookie', 'api_key', 'apikey', 'jwt', 'session', 'ssn', 'otp'];

describe('logger redaction (G3)', () => {
  it('replaces every denylisted key value with [REDACTED]', () => {
    const meta = Object.fromEntries(DENYLIST.map((k) => [k, 'super-secret-value']));
    meta.keep = 'visible';
    const payload = capture(() => logger.info('login', meta));
    for (const k of DENYLIST) expect(payload[k]).toBe('[REDACTED]');
    // Non-sensitive keys pass through untouched.
    expect(payload.keep).toBe('visible');
    expect(payload.message).toBe('login');
  });

  it('matches denylisted keys case-insensitively', () => {
    const payload = capture(() => logger.warn('m', { Password: 'x', AUTHORIZATION: 'Bearer abc.def.ghi', ApiKey: 'k' }));
    expect(payload.Password).toBe('[REDACTED]');
    expect(payload.AUTHORIZATION).toBe('[REDACTED]');
    expect(payload.ApiKey).toBe('[REDACTED]');
  });

  it('redacts recursively through nested objects and arrays', () => {
    const payload = capture(() => logger.info('m', {
      outer: { inner: { token: 'abc', ok: 1 } },
      list: [{ secret: 's', name: 'n' }],
    }));
    expect(payload.outer.inner.token).toBe('[REDACTED]');
    expect(payload.outer.inner.ok).toBe(1);
    expect(payload.list[0].secret).toBe('[REDACTED]');
    expect(payload.list[0].name).toBe('n');
  });

  it('leaves non-sensitive payloads unchanged (no behavior change)', () => {
    const payload = capture(() => logger.info('m', { userId: 'u1', count: 3, nested: { name: 'x' } }));
    expect(payload.userId).toBe('u1');
    expect(payload.count).toBe(3);
    expect(payload.nested.name).toBe('x');
  });

  it('redaction survives the child() logger too', () => {
    const payload = capture(() => logger.child({ requestId: 'r1' }).error('boom', { password: 'p', ok: true }));
    expect(payload.requestId).toBe('r1');
    expect(payload.password).toBe('[REDACTED]');
    expect(payload.ok).toBe(true);
  });
});
