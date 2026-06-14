// Content-Security-Policy (ENFORCING). Asserts the enforcing header ships with
// the expected directives + a per-request nonce, that NO report-only header is
// emitted anymore, that the served index.html carries that nonce on its inline
// bootstrap script (no un-nonced inline script remains), and that /csp-report
// still accepts violation reports for monitoring. Binds an ephemeral port; no DB
// needed (createApp builds middleware/routes without connecting).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from './app.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); });
  }
});

function boot() {
  const app = createApp();
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
    servers.push(s);
  });
}
const get = (base, p = '/') => fetch(`${base}${p}`, { headers: { connection: 'close' } });

describe('CSP — enforcing', () => {
  it('ships the ENFORCING Content-Security-Policy with the expected directives + nonce, and no report-only header', async () => {
    const base = await boot();
    const res = await get(base, '/__csp_probe__'); // any non-/api route passes through helmet
    const csp = res.headers.get('content-security-policy');
    expect(csp, 'enforcing header present').toBeTruthy();
    expect(res.headers.get('content-security-policy-report-only'), 'no longer report-only').toBeNull();
    for (const frag of [
      "default-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "img-src 'self' data: https://res.cloudinary.com",
      "frame-src 'self' https://res.cloudinary.com",
      "connect-src 'self'",
      "font-src 'self' https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'report-uri /csp-report',
    ]) {
      expect(csp, frag).toContain(frag);
    }
    // script-src is nonce-based, never 'unsafe-inline'.
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('issues a fresh nonce per request', async () => {
    const base = await boot();
    const a = (await get(base, '/__a__')).headers.get('content-security-policy');
    const b = (await get(base, '/__b__')).headers.get('content-security-policy');
    expect(a.match(/'nonce-([^']+)'/)[1]).not.toBe(b.match(/'nonce-([^']+)'/)[1]);
  });

  it('injects the CSP nonce into the served index.html inline script (when the SPA is built)', async () => {
    const base = await boot();
    const res = await get(base, '/');
    if (!(res.headers.get('content-type') || '').includes('text/html')) return; // no client/dist in this run
    const csp = res.headers.get('content-security-policy') || '';
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    const html = await res.text();
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}"`);
    // No inline <script> left without a nonce (would violate script-src).
    expect(html).not.toMatch(/<script(?![^>]*\b(?:src=|nonce=))/i);
  });

  it('accepts a CSP violation report at /csp-report (204)', async () => {
    const base = await boot();
    const res = await fetch(`${base}/csp-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report', connection: 'close' },
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'inline' } }),
    });
    expect(res.status).toBe(204);
  });
});
