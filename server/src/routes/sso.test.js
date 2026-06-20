// server/src/routes/sso.js unit tests.
//
// Exercises the real Express handlers with the OIDC network layer (oidcClient)
// mocked, so we test the app's own logic: the SSO-off 404 guard, the login
// redirect + state cookie, the callback's in-app ACR enforcement (D2), JIT
// provisioning + session issue on success, and the bad-state-cookie path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

let completeLoginResult = {};
vi.mock('../services/identity/oidcClient.js', () => ({
  startLogin: vi.fn(async () => ({
    authorizationUrl: 'https://idp.example/authorize?client_id=x', state: 'st', nonce: 'no', codeVerifier: 'cv',
  })),
  completeLogin: vi.fn(async () => completeLoginResult),
}));
vi.mock('../services/audit.js', () => ({ logAudit: vi.fn(() => Promise.resolve()) }));
const alertMock = vi.fn();
vi.mock('../services/securityAlerts.js', () => ({ emitSecurityAlert: (...a) => alertMock(...a) }));

// Fake pg: pool.query (unused on happy path) + pool.connect → tx client.
function fakeClientQuery(sql, params = []) {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [] });
  if (sql.includes('FROM public.uw_role WHERE role_code')) return Promise.resolve({ rows: [{ role_id: 'role-tuw' }] });
  if (sql.includes('FROM public.uw_user WHERE idp_subject')) return Promise.resolve({ rows: [] });
  if (sql.includes('SELECT 1 FROM public.uw_user WHERE username')) return Promise.resolve({ rows: [] });
  if (sql.includes('INSERT INTO public.uw_user')) return Promise.resolve({ rows: [{ user_id: 'sso-1', username: params[0] }] });
  if (sql.includes('INSERT INTO public.user_mandate')) return Promise.resolve({ rows: [] });
  if (sql.includes('INSERT INTO public.auth_session')) return Promise.resolve({ rows: [{ session_id: 'sess-sso', expires_at: '2026-06-20T08:00:00Z' }] });
  if (sql.includes('SELECT session_epoch FROM public.uw_user')) return Promise.resolve({ rows: [{ session_epoch: 0 }] });
  return Promise.resolve({ rows: [] });
}
vi.mock('../db/pool.js', () => ({
  pool: {
    query: vi.fn(fakeClientQuery),
    connect: vi.fn(() => Promise.resolve({ query: vi.fn(fakeClientQuery), release: vi.fn() })),
  },
}));

const { default: ssoRouter } = await import('./sso.js');
const { signSsoState } = await import('../lib/ssoStateCookie.js');

function buildApp() {
  const app = express();
  app.use(ssoRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  return app;
}

function call(app, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), { method, url: path, headers: { ...headers } });
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app, statusCode: 200, cookies: [], locationHeader: null,
      setHeader() { return res; }, getHeader() { return undefined; },
      cookie(name, value, options) { res.cookies.push({ name, value, options: options || {} }); return res; },
      clearCookie(name, options) { res.cookies.push({ name, value: '', options: options || {}, cleared: true }); return res; },
      status(code) { res.statusCode = code; return res; },
      redirect(url) { res.statusCode = 302; res.locationHeader = url; res.end(); },
      json(payload) { chunks.push(JSON.stringify(payload)); res.end(); },
      end() { resolve({ status: res.statusCode, location: res.locationHeader, body: chunks.length ? JSON.parse(chunks.join('')) : null, cookies: res.cookies }); },
    });
    res.req = req; req.res = res;
    try { app.handle(req, res, (err) => { if (err) reject(err); }); } catch (e) { reject(e); }
  });
}

const SSO_ON = {
  IDENTITY_SSO_ENABLED: 'true',
  IDENTITY_ISSUER: 'https://idp.example',
  IDENTITY_CLIENT_ID: 'reins',
  IDENTITY_CLIENT_SECRET: 'shh',
  IDENTITY_REDIRECT_URI: 'https://app.example/api/auth/sso/callback',
};
const setEnv = (o) => Object.assign(process.env, o);
const clearEnv = () => ['IDENTITY_SSO_ENABLED', 'IDENTITY_ISSUER', 'IDENTITY_CLIENT_ID', 'IDENTITY_CLIENT_SECRET', 'IDENTITY_REDIRECT_URI', 'IDENTITY_REQUIRED_ACR', 'IDENTITY_ROLE_MAP']
  .forEach((k) => delete process.env[k]);

beforeEach(() => { clearEnv(); alertMock.mockClear(); completeLoginResult = { sub: 'idp|1', email: 'a@b.com', name: 'A B' }; });

describe('GET /auth/sso/login', () => {
  it('404 when SSO is disabled (default posture)', async () => {
    const res = await call(buildApp(), { path: '/auth/sso/login' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SSO_DISABLED');
  });

  it('redirects to the IdP and sets the signed state cookie', async () => {
    setEnv(SSO_ON);
    const res = await call(buildApp(), { path: '/auth/sso/login?returnTo=/quotes' });
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/idp\.example\/authorize/);
    const tx = res.cookies.find((c) => c.name === 'sso_tx');
    expect(tx).toBeTruthy();
    expect(tx.options.httpOnly).toBe(true);
    expect(tx.options.sameSite).toBe('lax');
  });
});

describe('GET /auth/sso/callback', () => {
  const withState = (returnTo = '/') => ({ cookie: `sso_tx=${signSsoState({ state: 'st', nonce: 'no', codeVerifier: 'cv', returnTo })}` });

  it('404 when SSO is disabled', async () => {
    const res = await call(buildApp(), { path: '/auth/sso/callback?code=abc&state=st' });
    expect(res.status).toBe(404);
  });

  it('400 when the state cookie is missing/invalid', async () => {
    setEnv(SSO_ON);
    const res = await call(buildApp(), { path: '/auth/sso/callback?code=abc&state=st' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SSO_STATE_INVALID');
  });

  it('happy path: provisions, issues a session cookie, redirects to returnTo', async () => {
    setEnv(SSO_ON);
    const res = await call(buildApp(), { path: '/auth/sso/callback?code=abc&state=st', headers: withState('/quotes') });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/quotes');
    expect(res.cookies.some((c) => c.name === 'auth_token' && !c.cleared)).toBe(true);
    // tx cookie cleared.
    expect(res.cookies.some((c) => c.name === 'sso_tx' && c.cleared)).toBe(true);
  });

  it('D2: denies 403 when required ACR is not satisfied + raises an alert', async () => {
    setEnv({ ...SSO_ON, IDENTITY_REQUIRED_ACR: 'mfa-strong' });
    completeLoginResult = { sub: 'idp|1', email: 'a@b.com', acr: 'pwd-only' };
    const res = await call(buildApp(), { path: '/auth/sso/callback?code=abc&state=st', headers: withState() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SSO_MFA_REQUIRED');
    expect(alertMock).toHaveBeenCalledWith('SSO_ACR_DENIED', expect.objectContaining({ sub: 'idp|1' }));
    expect(res.cookies.some((c) => c.name === 'auth_token' && !c.cleared)).toBe(false);
  });

  it('open-redirect guard: an absolute returnTo collapses to "/"', async () => {
    setEnv(SSO_ON);
    const res = await call(buildApp(), { path: '/auth/sso/callback?code=abc&state=st', headers: withState('https://evil.example') });
    expect(res.status).toBe(302);
    expect(res.location).toBe('/');
  });
});
