// Logs in once and caches the browser storage state, so repeated capture runs
// reuse one session instead of tripping the login rate limiter (5 attempts per
// 15 minutes, keyed on IP + username — see server/src/app.js).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CHROME   = process.env.MANUAL_CHROME || undefined;   // undefined ⇒ Playwright's own chromium
export const BASE     = process.env.MANUAL_BASE_URL || 'http://localhost:4000';
export const USERNAME = process.env.MANUAL_USER || 'chief.underwriter';
export const PASSWORD = process.env.MANUAL_PASSWORD || 'demo2026';
export const STATE    = path.join(HERE, '.auth-state.json');

const launchOpts = () => (CHROME ? { executablePath: CHROME } : {});

export async function loginState() {
  if (fs.existsSync(STATE)) {
    const b = await chromium.launch(launchOpts());
    const c = await b.newContext({ storageState: STATE });
    const p = await c.newPage();
    const r = await p.goto(`${BASE}/api/auth/me`, { waitUntil: 'domcontentloaded' });
    const ok = r && r.status() === 200;
    await b.close();
    if (ok) return STATE;
  }
  const b = await chromium.launch(launchOpts());
  const c = await b.newContext();
  const p = await c.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const res = await p.evaluate(async ([u, pw]) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ username: u, password: pw }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const s = { ...j.session }; delete s.token;
    localStorage.setItem('UNIVERSE3_SESSION_V2', JSON.stringify(s));
    return { ok: true };
  }, [USERNAME, PASSWORD]);
  if (!res.ok) { await b.close(); throw new Error(`login failed (${res.status})`); }
  await c.storageState({ path: STATE });
  await b.close();
  return STATE;
}
