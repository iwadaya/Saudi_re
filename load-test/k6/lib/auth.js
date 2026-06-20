// load-test/k6/lib/auth.js
//
// Real PRODUCTION login flow for k6 (cookie + CSRF), shared by every load
// script. After the auth hardening, identity comes from a verified httpOnly
// `auth_token` cookie (NOT x-user-* headers, which a production-config target
// ignores) and state-changing requests carry the double-submit `X-CSRF-Token`.
//
// k6 keeps a per-VU cookie jar, so once login() runs the auth_token cookie is
// auto-attached to every subsequent request to /api. This module returns the
// csrf token to put in the X-CSRF-Token header on mutations.
//
// Credentials come from env (a real account on the target — seed one in staging):
//   LOAD_USER=<username|email>  LOAD_PASS=<password>
//
// Usage:
//   import { login, authHeaders } from './lib/auth.js';
//   const csrf = login(BASE_URL);            // once per VU (and once in setup)
//   http.get(url, { headers: authHeaders(csrf) });        // cookie auto-sent
//   http.post(url, body, { headers: authHeaders(csrf) }); // + X-CSRF-Token

import http from 'k6/http';

/**
 * Log in against the real flow and return the CSRF token. Relies on the k6
 * cookie jar of the CURRENT context (VU or setup) to hold the auth cookie.
 * Throws a clear error if creds are missing or login fails — so a misconfigured
 * run fails fast instead of silently measuring 401s.
 */
export function login(baseUrl) {
  const user = __ENV.LOAD_USER;
  const pass = __ENV.LOAD_PASS;
  if (!user || !pass) {
    throw new Error(
      'LOAD_USER and LOAD_PASS are required: the production login flow needs a real account '
      + '(x-user-* demo headers are ignored when ALLOW_DEMO_AUTH is off). '
      + 'Seed a load-test user in staging and pass its credentials.',
    );
  }
  const res = http.post(`${baseUrl}/api/auth/login`, JSON.stringify({ username: user, password: pass }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'login' },
  });
  if (res.status !== 200) {
    throw new Error(`Login failed (HTTP ${res.status}) for "${user}" at ${baseUrl}. `
      + 'Check the credentials and that the target is reachable with the prod-auth build.');
  }
  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL(`${baseUrl}/`);
  const csrf = cookies.csrf_token && cookies.csrf_token[0];
  if (!csrf) {
    throw new Error('Login succeeded but no csrf_token cookie was set — is the target running the cookie+CSRF auth build?');
  }
  return csrf;
}

/** JSON headers + the CSRF double-submit header. The auth cookie rides the jar. */
export function authHeaders(csrf) {
  return { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
}
