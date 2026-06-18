// Comprehensive edit-lock coverage: guardApiMutations 403s a non-assignee on
// every in-scope nested mutator (and DB-resolved ones), lets the assignee
// through, leaves reads + approval-workflow endpoints alone; plus a registry
// check that no mutating route in the four routers falls through unguarded.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { guardApiMutations, classifyMutationPath } = await import('./permissions.js');

const P = (rows) => Promise.resolve({ rows });
poolMock.query.mockImplementation((sql) => {
  if (sql.includes('fac_document WHERE document_id')) return P([{ id: 'risk-9' }]);
  if (sql.includes('fac_ai_recommendation WHERE recommendation_id')) return P([{ id: 'risk-9' }]);
  if (sql.includes('pricing_component_snapshots WHERE id')) return P([{ id: 'contract-9' }]);
  if (sql.includes('contract_document')) return P([{ id: 'contract-9', entity_type: 'CONTRACT' }]);
  if (sql.includes('owner_level')) return P([{ assigned_to_user_id: 'owner', owner_level: 5, assigned_to_name: 'Owner' }]);
  return P([]);
});

// Some tests boot more than one server; track every one and tear them ALL down
// (sockets forced closed, close awaited) after each test so a leaked listener
// never lingers to contend with the rest of the full-suite run. Timeout is
// raised here (per-file) rather than globally — these bind a real port.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); });
  }
});

function boot(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { userId, roleCode: 'TUW', hierarchyLevel: 5 }; next(); });
  app.use('/api', guardApiMutations);
  app.all('/api/*splat', (_req, res) => res.json({ reached: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
    servers.push(s);
  });
}
const send = (base, method, p, body) =>
  fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const GUARDED = [
  ['PUT', '/api/quotes/q1/dev-factors/risk'],
  ['POST', '/api/quotes/q1/triangles/large'],
  ['POST', '/api/quotes/q1/documents'],
  ['PUT', '/api/quotes/q1/pricing-outputs'],
  ['DELETE', '/api/fac/documents/d1'],
  ['POST', '/api/fac/recommendation/r1/accept'],
  ['POST', '/api/fac/risks/f1/clauses-checklist'],
  ['POST', '/api/fac/risks/f1/submit-for-approval'],
  ['DELETE', '/api/pricing/component-snapshot/s1'],
  ['DELETE', '/api/documents/d1'],
  ['PUT', '/api/contracts/c1/ldf-blend/CLAIMS_PAID'],
];

describe('guardApiMutations — non-assignee is blocked', () => {
  it('403s every in-scope nested/resolved mutator', async () => {
    const base = await boot('attacker');
    for (const [method, p] of GUARDED) {
      const res = await send(base, method, p, {});
      expect(res.status, `${method} ${p}`).toBe(403);
      expect((await res.json()).code).toBe('READ_ONLY');
    }
  });
});

describe('guardApiMutations — assignee + reads + workflow pass', () => {
  it('lets the assignee through, leaves reads and approval decisions alone', async () => {
    const base = await boot('owner');
    // assignee edits
    expect((await send(base, 'PUT', '/api/quotes/q1/dev-factors/risk', {})).status).toBe(200);
    expect((await send(base, 'DELETE', '/api/fac/documents/d1')).status).toBe(200);
    // reads never gated (even for a non-owner)
    const ro = await boot('attacker');
    expect((await send(ro, 'GET', '/api/quotes/q1/dev-factors/risk')).status).toBe(200);
    // approval-workflow decision is an approver action — not assignee-gated
    expect((await send(ro, 'POST', '/api/treaties/c1/offer/peer-decision', {})).status).toBe(200);
    expect((await send(ro, 'POST', '/api/contracts/c1/assign', {})).status).toBe(200); // assignment service owns authority
    expect((await send(ro, 'POST', '/api/quotes/q1/renew', {})).status).toBe(200); // create
  });
});

describe('registry: no mutating route falls through unguarded', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const routesDir = path.resolve(dir, '../routes');
  const files = [
    'ai.js',
    'aiCedant.js',
    'aiMarket.js',
    'assignments.js',
    'clientEvents.js',
    'facultative.js',
    'lookups.js',
    'ldfBlending.js',
    'nonProp.js',
    'pricing.js',
    'quoteLifecycle.js',
    'quotes.js',
    'renewalPackImport.js',
    'treaties.js',
    'treatyData.js',
    'workbench.js',
  ];
  const explicitlyOwnedElsewhere = new Set([
    // Auth is registered before the blanket mutation guard and self-gates.
    'POST /auth/users (auth.js)',
    'PATCH /auth/users/:id (auth.js)',
    'PUT /auth/mandates/:userId (auth.js)',
    // Role-gated formula governance, not treaty/quote edit-lock territory.
    'POST /workbench/parameters (workbench.js)',
    'PUT /workbench/parameters/:id/approve (workbench.js)',
    'PUT /workbench/parameters/:id/reject (workbench.js)',
    'POST /workbench/comments (workbench.js)',
    // Operational/reference endpoints with their own route-level semantics.
    'POST /client-events (clientEvents.js)',
    'DELETE /ref/cache (lookups.js)',
    'PUT /ref/exchange-rates/:code (lookups.js)',
    // AI/reference routes are authenticated tools, not direct entity mutators.
    'POST /ai/slip-ingest (ai.js)',
    'POST /ai/complete (ai.js)',
    'POST /ai/analyse-json (ai.js)',
    'POST /ai/fac/analyse-document (ai.js)',
    'POST /ai/cedant/:cedantId/portfolio-recommendations (aiCedant.js)',
    'POST /ai/cedant/recommendation/:rec_id/reject (aiCedant.js)',
    'POST /cedants/:cedantId/staging (aiCedant.js)',
    'POST /cedants/:cedantId/staging/:staging_id/discard (aiCedant.js)',
    'POST /cedants/:cedantId/staging/commit-all (aiCedant.js)',
    'POST /ai/market/generate-report (aiMarket.js)',
    'POST /ai/market/treaty-recommendations (aiMarket.js)',
    'POST /ai/market/recommendation/:rec_id/stage (aiMarket.js)',
    'POST /ai/market/recommendation/:rec_id/reject (aiMarket.js)',
    'POST /ai/market/log-view (aiMarket.js)',
    'POST /ai/market/structure-commentary (aiMarket.js)',
  ]);
  const re = /router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;

  it('every POST/PUT/PATCH/DELETE classifies as guarded, exempt, or create', () => {
    const unmatched = [];
    for (const f of files) {
      const src = readFileSync(path.join(routesDir, f), 'utf8');
      let m;
      while ((m = re.exec(src)) !== null) {
        const cls = classifyMutationPath(m[2]);
        const label = `${m[1].toUpperCase()} ${m[2]} (${f})`;
        if (cls === null && !explicitlyOwnedElsewhere.has(label)) unmatched.push(label);
      }
    }
    expect(unmatched).toEqual([]);
  });
});
