import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { authenticate, csrfProtection, requireAuth } = await import('./requestContext.js');
const { signAuthToken } = await import('../lib/authToken.js');
const { issueCsrfToken } = await import('../lib/csrf.js');

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const servers = [];

beforeEach(() => {
  delete process.env.ALLOW_DEMO_AUTH;
  poolMock.query.mockReset();
  poolMock.query.mockResolvedValue({
    rows: [{
      user_id: 'u-cookie',
      display_name: 'Cookie User',
      role_code: 'CU',
      hierarchy_level: 2,
      effective_limit_usd: null,
      restricted_cob_ids: [],
      treaty_type_scope: 'BOTH',
      must_change_password: false,
    }],
  });
});

afterEach(async () => {
  delete process.env.ALLOW_DEMO_AUTH;
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); });
  }
});

function boot() {
  const app = express();
  app.use(express.json());
  app.use(authenticate);
  app.use(csrfProtection);
  app.use(requireAuth);
  app.post('/mutate', (req, res) => res.json({ ok: true, userId: req.user.userId }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
    servers.push(s);
  });
}

function cookieHeader({ token = signAuthToken({ sub: 'u-cookie' }), csrf } = {}) {
  return [
    `auth_token=${encodeURIComponent(token)}`,
    csrf ? `csrf_token=${encodeURIComponent(csrf)}` : null,
  ].filter(Boolean).join('; ');
}

describe('cookie auth + CSRF over HTTP', () => {
  it('rejects a cookie-authenticated mutation without a CSRF token', async () => {
    const base = await boot();
    const res = await fetch(`${base}/mutate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(),
      },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'CSRF_FAILED' });
  });

  it('accepts a cookie-authenticated mutation with a matching signed CSRF token', async () => {
    const base = await boot();
    const csrf = issueCsrfToken();
    const res = await fetch(`${base}/mutate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader({ csrf }),
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, userId: 'u-cookie' });
  });

  it('does not accept demo headers when ALLOW_DEMO_AUTH is disabled', async () => {
    const base = await boot();
    const res = await fetch(`${base}/mutate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-role': 'CU',
        'x-user-id': 'spoofed',
      },
      body: JSON.stringify({ ok: true }),
    });
    expect(res.status).toBe(401);
  });
});
