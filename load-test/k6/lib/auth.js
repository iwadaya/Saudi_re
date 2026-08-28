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
// High-VU runs: the login brute-force limiter is keyed per IP + submitted
// identity (5 attempts / 15 min), so 100 VUs sharing one LOAD_USER from one
// address get 429s after the fifth login. Seed a pool of accounts
// (server/scripts/seedLoadTestUsers.js) and fan the VUs across it instead:
//   LOAD_USER_PREFIX=loadtest LOAD_USER_COUNT=100 LOAD_PASS=<password>
// VU N then logs in as loadtest001..loadtest100 (LOAD_USER_PAD digits, default
// 3), one login per identity. LOAD_USER_PREFIX takes precedence over LOAD_USER.
//
// Usage:
//   import { login, authHeaders } from './lib/auth.js';
//   const csrf = login(BASE_URL);            // once per VU (and once in setup)
//   http.get(url, { headers: authHeaders(csrf) });        // cookie auto-sent
//   http.post(url, body, { headers: authHeaders(csrf) }); // + X-CSRF-Token

import http from 'k6/http';
import { sleep } from 'k6';

/** The username this VU should log in as: a pool member when LOAD_USER_PREFIX
 *  is set (VU N → prefix + zero-padded 1+((N-1) % count)), else the shared
 *  LOAD_USER. setup()/teardown() run as __VU 0 and get the reserved account
 *  ..000, so a setup login never spends a VU identity's 5-per-15-min budget. */
function resolveUser() {
  const prefix = __ENV.LOAD_USER_PREFIX;
  if (!prefix) return __ENV.LOAD_USER;
  const count = Math.max(1, Number(__ENV.LOAD_USER_COUNT || 100));
  const pad = Math.max(1, Number(__ENV.LOAD_USER_PAD || 3));
  const vu = Number(__VU) > 0 ? Number(__VU) : 0;
  const n = vu === 0 ? 0 : 1 + ((vu - 1) % count);
  return `${prefix}${String(n).padStart(pad, '0')}`;
}

/**
 * Log in against the real flow and return the CSRF token. Relies on the k6
 * cookie jar of the CURRENT context (VU or setup) to hold the auth cookie.
 * Throws a clear error if creds are missing or login fails — so a misconfigured
 * run fails fast instead of silently measuring 401s.
 */
export function login(baseUrl) {
  const user = resolveUser();
  const pass = __ENV.LOAD_PASS;
  if (!user || !pass) {
    throw new Error(
      'LOAD_USER (or LOAD_USER_PREFIX) and LOAD_PASS are required: the production login flow '
      + 'needs a real account (x-user-* demo headers are ignored when ALLOW_DEMO_AUTH is off). '
      + 'Seed load-test users (server/scripts/seedLoadTestUsers.js) and pass the credentials.',
    );
  }
  const res = http.post(`${baseUrl}/api/auth/login`, JSON.stringify({ username: user, password: pass }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'login' },
  });
  if (res.status !== 200) {
    // Back off before throwing. The throw aborts the iteration BEFORE its
    // think-time sleep, so without this a failed login retries in a tight
    // loop — hundreds of attempts/sec that instantly exhaust the identity's
    // login-limiter budget (5 per 15 min) and flood http_req_failed.
    sleep(5);
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
