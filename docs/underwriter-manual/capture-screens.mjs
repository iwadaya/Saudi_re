import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, BASE, STATE, loginState } from './auth.mjs';

// Full-height captures of every screen, written to raw/. build-manual.mjs
// resizes and slices them. The four entity ids below select which seeded
// records the wizards are walked against — override them for another dataset.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT  = process.env.MANUAL_RAW_DIR || path.join(HERE, 'raw');
fs.mkdirSync(OUT, { recursive: true });

const PROP = process.env.MANUAL_PROP_ID || '88d20b77-edf4-4e47-8236-9c1baa262132'; // Tawuniya Quota Share 2026
const NP   = process.env.MANUAL_NP_ID   || '7272d38e-d771-4170-b21f-b2fd8604bfd3'; // Al Rajhi Risk & CAT XL 2026
const NPSL = process.env.MANUAL_NPSL_ID || 'd4cc784d-d3e9-43b3-92b1-75e8ae06b72f'; // a Stop Loss treaty
const FAC  = process.env.MANUAL_FAC_ID  || '26cd1395-156e-4fa3-9c0d-16bdedf4896e'; // FAC-2026-0001

const EXPAND = `
 html,body{height:auto!important;overflow:visible!important}
 .app-shell{height:auto!important;min-height:0!important;overflow:visible!important}
 .app-shell__wizard-wrap{overflow:visible!important}
 .wizard-layout{overflow:visible!important;align-items:flex-start!important}
 nav.wizard-tabs{height:auto!important;max-height:none!important;overflow:visible!important;position:static!important}
 main.wizard-content{height:auto!important;max-height:none!important;overflow:visible!important;padding-bottom:40px!important}
`;

await loginState();
const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const c = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, storageState: STATE });
const p = await c.newPage();
const report = [];

async function expand() { try { await p.addStyleTag({ content: EXPAND }); } catch {} }
async function shot(name) {
  await p.waitForTimeout(2600);
  await expand();
  await p.waitForTimeout(900);
  await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const h = await p.evaluate(() => document.documentElement.scrollHeight);
  report.push({ name, url: p.url().replace(BASE, ''), h });
  console.log(`✓ ${name.padEnd(34)} ${p.url().replace(BASE,'').padEnd(30)} h=${h}`);
}
async function tab(label) {
  await p.locator('.wizard-tab', { hasText: new RegExp(`^${label}$`) }).first().click({ timeout: 25000 });
  await p.waitForTimeout(900);
}
async function setA(kind) {
  if (kind === 'fac') await p.evaluate(v => { localStorage.setItem('ACTIVE_FAC_RISK_ID', v); localStorage.setItem('FAC_QUOTE_MODE','0'); }, FAC);
  else await p.evaluate(v => { localStorage.setItem('ACTIVE_CONTRACT_ID_V1', v); localStorage.removeItem('ACTIVE_QUOTE_ID_V1'); },
                        kind === 'np' ? NP : kind === 'npsl' ? NPSL : PROP);
}

// login screen (log out first so it renders)
{
  const c2 = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);
  await p2.screenshot({ path: path.join(OUT, 'login.png'), fullPage: true });
  await c2.close();
  console.log('✓ login');
}

for (const [name, route] of [
  ['select','/select'],['home','/'],['dashboard','/dashboard'],['approvals','/approvals'],
  ['import','/import'],['admin-users','/admin/users'],['benchmark','/benchmark'],
  ['claims','/claims'],['finance','/finance'],['fac-home','/fac'],['workbench','/workbench'],
]) {
  try { await p.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 60000 }); await shot(name); }
  catch (e) { console.log(`✗ ${name} ${String(e).slice(0,90)}`); }
}

await setA('prop');
await p.goto(`${BASE}/prop/treaty-detail`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await shot('prop-treaty-detail');
for (const [n, l] of [
  ['prop-documents','Documents'],['prop-premium-triangles','Premium Triangles'],
  ['prop-claims-paid-triangles','Claims Paid Triangles'],['prop-os-claims-triangles','OS Claims Triangles'],
  ['prop-incurred-claims-triangles','Incurred Claims Triangles'],
  ['prop-large-loss-list','Large Loss List'],['prop-large-loss-selection','Large Loss Selection'],
  ['prop-large-loss-pareto','Large Loss Pareto'],['prop-cat-loss-list','Cat Loss List'],
  ['prop-cat-loss-selection','Cat Loss Selection'],['prop-cat-loss-pareto','Cat Loss Pareto'],
  ['prop-premium-dev-factors','Premium Dev Factors'],['prop-paid-claims-dev-factors','Paid Claims Dev Factors'],
  ['prop-os-claims-dev-factors','OS Claims Dev Factors'],['prop-incurred-dev-factors','Incurred Dev Factors'],
  ['prop-projected-summary','Projected Summary'],['prop-quick-summary','Quick Summary'],
  ['prop-risk-profile','Risk Profile'],['prop-claims-profile','Claims Profile'],
  ['prop-cresta-aggregates','CRESTA Aggregates'],['prop-event-loss-tables','Event Loss Tables'],
  ['prop-pricing','Pricing'],
]) { try { await tab(l); await shot(n); } catch (e) { console.log(`✗ ${n} ${String(e).slice(0,90)}`); } }
try { await p.goto(`${BASE}/prop/history`, { waitUntil: 'domcontentloaded' }); await shot('prop-history'); } catch {}

await setA('np');
await p.goto(`${BASE}/np/treaty-detail`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await shot('np-treaty-detail');
for (const [n, l] of [
  ['np-documents','Documents'],['np-structure','Structure'],['np-premiums-table','Premiums Table'],
  ['np-large-loss-list','Large Loss List'],['np-large-loss-selection','Large Loss Selection'],
  ['np-large-loss-pareto','Large Loss Pareto'],['np-large-loss-dev-factors','Large Loss Dev Factors'],
  ['np-cat-loss-list','Cat Loss List'],['np-cat-loss-selection','Cat Loss Selection'],
  ['np-cat-loss-pareto','Cat Loss Pareto'],['np-cat-loss-dev-factors','Cat Loss Dev Factors'],
  ['np-excess-dev-factors','Excess Dev Factors'],['np-historical-performance','Historical Performance'],
  ['np-risk-profile','Risk Profile'],['np-claims-profile','Claims Profile'],
  ['np-cresta-aggregates','CRESTA Aggregates'],['np-event-loss-tables','Event Loss Tables'],
  ['np-final-pricing','Final Pricing'],
]) { try { await tab(l); await shot(n); } catch (e) { console.log(`✗ ${n} ${String(e).slice(0,90)}`); } }
try { await p.goto(`${BASE}/np/history`, { waitUntil: 'domcontentloaded' }); await shot('np-history'); } catch {}
try { await p.goto(`${BASE}/np/expiring-structure`, { waitUntil: 'domcontentloaded' }); await shot('np-expiring-structure'); } catch {}

await setA('npsl');
try {
  await p.goto(`${BASE}/np/treaty-detail`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2600);
  await tab('Stop Loss Pricing');
  await shot('np-stop-loss-pricing');
} catch (e) { console.log('✗ np-stop-loss-pricing', String(e).slice(0,90)); }

await setA('fac');
await p.goto(`${BASE}/fac/risk/detail`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await shot('fac-risk-detail');
for (const [n, l] of [
  ['fac-documents','Documents'],['fac-locations','Locations & SI'],['fac-cope','COPE Assessment'],
  ['fac-structure','Placement Structure'],['fac-deductibles','Deductibles & Terms'],
  ['fac-losses','Loss History'],['fac-pricing','Pricing'],['fac-summary','Summary & Approval'],
]) { try { await tab(l); await shot(n); } catch (e) { console.log(`✗ ${n} ${String(e).slice(0,90)}`); } }

// Straight Stats only joins the sidebar when the treaty says it has no
// triangulations, so flip the toggle, capture, and flip it back.
await setA('prop');
try {
  await p.goto(`${BASE}/prop/treaty-detail`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(4000);
  await p.locator('button', { hasText: /^NO$/ }).first().click({ timeout: 15000 });
  await p.waitForTimeout(1500);
  await tab('Experience (No Triangulation)');
  await shot('prop-no-triangulation');
  await tab('Treaty Detail');
  await p.waitForTimeout(2000);
  await p.locator('button', { hasText: /^YES$/ }).first().click({ timeout: 15000 });
  await p.waitForTimeout(2000);
} catch (e) { console.log('✗ prop-no-triangulation', String(e).slice(0, 90)); }

fs.writeFileSync(path.join(OUT, '_report.json'), JSON.stringify(report, null, 1));
await b.close();
