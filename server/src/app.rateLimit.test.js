// Rate-limiter behaviour: req.ip is the forwarded client IP behind trust proxy;
// the global limiter keys on IP only (rotating x-user-id can't bypass it); the
// login limiter throttles per IP+identity.
//
// These tests bind a real ephemeral-port server because req.ip / trust-proxy
// resolution needs the HTTP layer. To stay deterministic under the FULL suite
// (where many files run in parallel) each test:
//   • gets its own express app + its own freshly-created limiter (a per-test
//     in-memory store — never a module singleton shared across files), and
//   • is fully torn down in afterEach: every server is close()d (awaited) with
//     its sockets force-closed, and every limiter store is cleared, so nothing
//     leaks into or contends with the next test.
// testTimeout is raised here (per-file), not globally.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import { createApiLimiter, createLoginLimiter, rateLimitBypassed } from './app.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const servers = [];
const limiters = [];

/** Register a per-test limiter so afterEach can clear its store. */
const track = (limiter) => { limiters.push(limiter); return limiter; };

// Best-effort: drop the limiter's bucket + its prune interval so a per-test
// store leaves nothing behind (no live timer, no carried-over count).
function resetLimiterStore(limiter) {
  try { limiter?.resetKey?.(); } catch { /* no resetKey on this version */ }
  try { limiter?.store?.shutdown?.(); } catch { /* no exposed store */ }
}

afterEach(async () => {
  for (const l of limiters.splice(0)) resetLimiterStore(l);
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); });
  }
});

// The vitest env sets ALLOW_DEMO_AUTH=true for the whole suite (so demo-header
// auth works). These tests exercise the limiter itself, so clear the
// load-test/demo bypass flags first; the per-test env snapshot restores them.
beforeEach(() => {
  delete process.env.ALLOW_DEMO_AUTH;
  delete process.env.LOAD_TEST;
});

function boot(buildRoutes) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  buildRoutes(app);
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
    servers.push(s);
  });
}

const get = (base, path, headers) => fetch(`${base}${path}`, { headers });
const postJson = (base, path, headers, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('trust proxy', () => {
  it('resolves req.ip to the forwarded client IP', async () => {
    const base = await boot((app) => app.get('/whoami', (req, res) => res.json({ ip: req.ip })));
    const res = await get(base, '/whoami', { 'X-Forwarded-For': '9.9.9.9' });
    expect(await res.json()).toEqual({ ip: '9.9.9.9' });
  });
});

describe('global API limiter (IP-only key)', () => {
  it('rotating x-user-id does NOT raise the ceiling', async () => {
    const limiter = track(createApiLimiter({ max: 2 }));
    const base = await boot((app) => {
      app.use('/api', limiter);
      app.get('/api/x', (_req, res) => res.json({ ok: true }));
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const r = await get(base, '/api/x', { 'X-Forwarded-For': '5.5.5.5', 'x-user-id': `rotate-${i}` });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 429]); // 3rd throttled despite a fresh x-user-id

    // A different client IP has its own bucket.
    const other = await get(base, '/api/x', { 'X-Forwarded-For': '6.6.6.6' });
    expect(other.status).toBe(200);
  });

  it('each createApiLimiter() owns an independent store (no shared singleton)', async () => {
    const base1 = await boot((app) => {
      app.use('/api', track(createApiLimiter({ max: 1 })));
      app.get('/api/x', (_req, res) => res.json({ ok: true }));
    });
    const base2 = await boot((app) => {
      app.use('/api', track(createApiLimiter({ max: 1 })));
      app.get('/api/x', (_req, res) => res.json({ ok: true }));
    });
    // Exhaust the first limiter from one IP.
    expect((await get(base1, '/api/x', { 'X-Forwarded-For': '1.2.3.4' })).status).toBe(200);
    expect((await get(base1, '/api/x', { 'X-Forwarded-For': '1.2.3.4' })).status).toBe(429);
    // The second app's limiter is a separate store — the SAME IP is fresh there.
    expect((await get(base2, '/api/x', { 'X-Forwarded-For': '1.2.3.4' })).status).toBe(200);
  });
});

describe('login limiter (IP + identity)', () => {
  it('throttles repeated attempts for the same IP+identity but not a different identity', async () => {
    const limiter = track(createLoginLimiter({ max: 2 }));
    const base = await boot((app) => {
      app.use('/api/auth/login', limiter);
      app.post('/api/auth/login', (_req, res) => res.json({ ok: true }));
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const r = await postJson(base, '/api/auth/login', { 'X-Forwarded-For': '7.7.7.7' }, { username: 'ada@x' });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 429]);

    // Same IP, different identity → separate bucket, not throttled.
    const other = await postJson(base, '/api/auth/login', { 'X-Forwarded-For': '7.7.7.7' }, { username: 'grace@x' });
    expect(other.status).toBe(200);
  });
});

describe('load-test / demo bypass', () => {
  it('reports bypassed when LOAD_TEST or ALLOW_DEMO_AUTH is set, otherwise not', () => {
    expect(rateLimitBypassed()).toBe(false); // beforeEach cleared both flags
    process.env.LOAD_TEST = 'true';
    expect(rateLimitBypassed()).toBe(true);
    delete process.env.LOAD_TEST;
    process.env.ALLOW_DEMO_AUTH = 'true';
    expect(rateLimitBypassed()).toBe(true);
  });

  it('LOAD_TEST=true skips the IP limiter (uncapped — measures real capacity)', async () => {
    process.env.LOAD_TEST = 'true';
    const limiter = track(createApiLimiter({ max: 1 }));
    const base = await boot((app) => {
      app.use('/api', limiter);
      app.get('/api/x', (_req, res) => res.json({ ok: true }));
    });
    const a = await get(base, '/api/x', { 'X-Forwarded-For': '5.5.5.5' });
    const b = await get(base, '/api/x', { 'X-Forwarded-For': '5.5.5.5' });
    expect([a.status, b.status]).toEqual([200, 200]); // 2nd NOT throttled despite max:1
  });

  it('ALLOW_DEMO_AUTH=true skips the IP limiter too', async () => {
    process.env.ALLOW_DEMO_AUTH = 'true';
    const limiter = track(createApiLimiter({ max: 1 }));
    const base = await boot((app) => {
      app.use('/api', limiter);
      app.get('/api/x', (_req, res) => res.json({ ok: true }));
    });
    const a = await get(base, '/api/x', { 'X-Forwarded-For': '6.6.6.6' });
    const b = await get(base, '/api/x', { 'X-Forwarded-For': '6.6.6.6' });
    expect([a.status, b.status]).toEqual([200, 200]);
  });
});
