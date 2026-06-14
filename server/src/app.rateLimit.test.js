// Rate-limiter behaviour: req.ip is the forwarded client IP behind trust proxy;
// the global limiter keys on IP only (rotating x-user-id can't bypass it); the
// login limiter throttles per IP+identity.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createApiLimiter, createLoginLimiter } from './app.js';

let server = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function boot(buildRoutes) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  buildRoutes(app);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
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
    const base = await boot((app) => {
      app.use('/api', createApiLimiter({ max: 2 }));
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
});

describe('login limiter (IP + identity)', () => {
  it('throttles repeated attempts for the same IP+identity but not a different identity', async () => {
    const base = await boot((app) => {
      app.use('/api/auth/login', createLoginLimiter({ max: 2 }));
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
