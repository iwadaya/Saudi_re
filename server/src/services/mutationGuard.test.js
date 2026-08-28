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
  // F81: amend MUTATES the source quote (flips it to SUPERSEDED — even out of
  // AWAITING_APPROVAL), so it takes the assignee edit-lock, not the old
  // 'create' free pass that let anyone supersede anyone's quote.
  ['POST', '/api/quotes/q1/amend'],
  ['DELETE', '/api/fac/documents/d1'],
  ['POST', '/api/fac/recommendation/r1/accept'],
  ['POST', '/api/fac/risks/f1/clauses-checklist'],
  ['POST', '/api/fac/risks/f1/submit-for-approval'],
  ['DELETE', '/api/pricing/component-snapshot/s1'],
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
    // the assignee may amend their own quote (F81 — the edit-lock, not a 403 wall)
    expect((await send(base, 'POST', '/api/quotes/q1/amend', {})).status).toBe(200);
    // reads never gated (even for a non-owner)
    const ro = await boot('attacker');
    expect((await send(ro, 'GET', '/api/quotes/q1/dev-factors/risk')).status).toBe(200);
    // approval-workflow decision is an approver action — not assignee-gated
    expect((await send(ro, 'POST', '/api/treaties/c1/offer/peer-decision', {})).status).toBe(200);
    expect((await send(ro, 'POST', '/api/quotes/q1/renew', {})).status).toBe(200); // create
  });
});

describe('classifyMutationPath — amend is entity-scoped, renew/bind stay create (F81)', () => {
  it('classifies /quotes/:id/amend against the SOURCE quote', () => {
    expect(classifyMutationPath('/quotes/q1/amend')).toEqual({ entityType: 'QUOTE', entityId: 'q1' });
  });
  it('renew and bind keep their create classification (bind takes assertCanEdit in its handler)', () => {
    expect(classifyMutationPath('/quotes/q1/renew')).toBe('create');
    expect(classifyMutationPath('/quotes/q1/bind')).toBe('create');
  });
});

describe('guardApiMutations — GEM compute is guarded only when persisting', () => {
  it('lets a non-assignee preview (persist falsy) but blocks a persisting write', async () => {
    const attacker = await boot('attacker');
    // preview compute writes nothing → read-like, not edit-locked
    expect((await send(attacker, 'POST', '/api/pricing/gem/c1/compute', {})).status).toBe(200);
    expect((await send(attacker, 'POST', '/api/pricing/gem/c1/compute', { persist: false })).status).toBe(200);
    // persisting compute mutates the contract scenario → edit-locked
    const blocked = await send(attacker, 'POST', '/api/pricing/gem/c1/compute', { persist: true });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe('READ_ONLY');
    // the assignee may persist
    const owner = await boot('owner');
    expect((await send(owner, 'POST', '/api/pricing/gem/c1/compute', { persist: true })).status).toBe(200);
  });
});

describe('registry: no mutating route falls through unguarded', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const routesDir = path.resolve(dir, '../routes');
  const files = ['quotes.js', 'treaties.js', 'pricing.js', 'facultative.js'];
  const re = /router\.(post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;

  it('every POST/PUT/PATCH/DELETE classifies as guarded, exempt, or create', () => {
    const unmatched = [];
    for (const f of files) {
      const src = readFileSync(path.join(routesDir, f), 'utf8');
      let m;
      while ((m = re.exec(src)) !== null) {
        const cls = classifyMutationPath(m[2]);
        if (cls === null) unmatched.push(`${m[1].toUpperCase()} ${m[2]} (${f})`);
      }
    }
    expect(unmatched).toEqual([]);
  });
});
