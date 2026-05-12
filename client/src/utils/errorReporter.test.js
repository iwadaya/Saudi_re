import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportError, __internals__ } from './errorReporter.js';

beforeEach(() => {
  // Use 200 OK with an empty body: jsdom's Response rejects body
  // content for 204 status, which the real fetch allows.
  global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  // Reset module-level rate-limit state between tests
  __internals__.sent.length = 0;
  __internals__.recent.clear();
});

describe('reportError', () => {
  it('POSTs to /api/client-events with the error shape', async () => {
    await reportError('boundary', new Error('boom'));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/client-events$/);
    const body = JSON.parse(init.body);
    expect(body.type).toBe('boundary');
    expect(body.message).toBe('boom');
    expect(body.stack).toBeTypeOf('string');
    expect(init.keepalive).toBe(true);
  });

  it('serialises non-Error values safely', async () => {
    await reportError('other', 'string error');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.message).toBe('string error');
    expect(body.stack).toBeUndefined();
  });

  it('dedupes identical events within the window', async () => {
    // Same Error instance → identical stack → dedupe kicks in.
    // In production this is the typical shape: React re-renders an
    // error boundary, componentDidCatch fires with the same error.
    const err = new Error('dup');
    await reportError('boundary', err);
    await reportError('boundary', err);
    await reportError('boundary', err);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('treats different messages as different events', async () => {
    await reportError('boundary', new Error('a'));
    await reportError('boundary', new Error('b'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('caps at 20 posts per minute', async () => {
    for (let i = 0; i < 30; i++) {
      await reportError('other', new Error(`distinct-${i}`));
    }
    expect(global.fetch).toHaveBeenCalledTimes(20);
  });

  it('swallows fetch failures (fire-and-forget)', async () => {
    global.fetch.mockRejectedValueOnce(new TypeError('network'));
    const ok = await reportError('other', new Error('sadly'));
    expect(ok).toBe(false);
  });

  it('truncates extremely long messages', async () => {
    const long = 'x'.repeat(5_000);
    await reportError('other', new Error(long));
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.message.length).toBeLessThanOrEqual(2_000);
  });

  it('includes path + userAgent when available in jsdom', async () => {
    await reportError('other', new Error('x'));
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.path).toBeDefined();
    expect(body.userAgent).toBeDefined();
  });
});
