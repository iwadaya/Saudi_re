// server/src/lib/authCookies.js
// One place that owns the auth + CSRF cookie contract, so login, logout, the
// verify-on-boot refresh, and the auth/CSRF middleware all agree on names,
// paths, and security attributes.
//
//   auth_token : the signed bearer token. httpOnly (never reaches JS, so XSS
//                cannot steal it), Path=/api (only sent to the API), SameSite=
//                Strict, Secure in production. This replaces localStorage.
//   csrf_token : the signed double-submit token. NOT httpOnly (the SPA reads it
//                via document.cookie and echoes it in X-CSRF-Token), Path=/ so
//                it is readable from every SPA route, otherwise same attributes.
import { env } from '../config/env.js';
import { AUTH_TOKEN_TTL_SECONDS } from './authToken.js';
import { issueCsrfToken } from './csrf.js';

export const AUTH_COOKIE = 'auth_token';
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

const TTL_MS = AUTH_TOKEN_TTL_SECONDS * 1000;

// Secure only in production so the cookie still works over http://localhost in
// dev. SameSite=Strict: the SPA and API are same-origin in production, so a
// cross-site context never legitimately needs the cookie.
function baseOpts() {
  return { secure: env.isProduction, sameSite: 'strict' };
}

/**
 * Set the httpOnly auth cookie + the JS-readable CSRF cookie on a login/refresh
 * response, with Max-Age matching the token TTL.
 * @returns {string} the issued CSRF token (handy for callers/tests).
 */
export function setAuthCookies(res, token) {
  const csrf = issueCsrfToken();
  res.cookie(AUTH_COOKIE, token, { ...baseOpts(), httpOnly: true, path: '/api', maxAge: TTL_MS });
  res.cookie(CSRF_COOKIE, csrf, { ...baseOpts(), httpOnly: false, path: '/', maxAge: TTL_MS });
  return csrf;
}

/** Clear both cookies on logout — Path must mirror the set call to actually clear. */
export function clearAuthCookies(res) {
  res.clearCookie(AUTH_COOKIE, { ...baseOpts(), httpOnly: true, path: '/api' });
  res.clearCookie(CSRF_COOKIE, { ...baseOpts(), httpOnly: false, path: '/' });
}

/** Read one cookie value from the raw Cookie header (no cookie-parser dependency).
 *  `name` is always an internal constant, so the dynamic RegExp is injection-safe. */
export function readCookie(req, name) {
  const cookie = req.headers && req.headers.cookie;
  if (!cookie) return null;
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
