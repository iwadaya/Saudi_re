import { describe, it, expect, vi } from 'vitest';
import express from 'express';

const queryHandlers = [];
function pushHandler(handler) { queryHandlers.push(handler); }
function fakeQuery(sql, params) {
  for (const h of queryHandlers) {
    const res = h(sql, params);
    if (res !== undefined) return Promise.resolve(res);
  }
  return Promise.resolve({ rows: [] });
}

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn(fakeQuery) } }));
vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { default: router } = await import('./portfolioInsights.js');

function buildApp() {
  const app = express();
  app.use('/api', router);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  return app;
}

async function call(app, path) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), { method: 'GET', url: path, headers: {} });
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app, statusCode: 200,
      setHeader() { return res; }, getHeader() {},
      status(code) { res.statusCode = code; return res; },
      json(payload) { chunks.push(JSON.stringify(payload)); res.end(); },
      end() { resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(chunks.join('')) : null }); },
    });
    res.req = req; req.res = res;
    try { app.handle(req, res, (err) => (err ? reject(err) : resolve({ status: res.statusCode, body: null }))); }
    catch (e) { reject(e); }
  });
}

// One PROP contract (balance-defined) and one NP contract (ROL-defined, two layers).
const DB_ROWS = [
  {
    contract_id: 'p1', status: 'SIGNED', uw_year: 2025,
    country_name: 'Saudi Arabia', region: 'Middle East',
    treaty_type: 'Quota Share', is_np: false, primary_cob: 'Property',
    rate_to_usd: '1.0',
    quota_share_epi: '8000000', surplus_epi: '2000000', total_capacity: '50000000',
    actuarial_margin: '0.18',
    np_prem_local: null, np_limit_local: null, np_wavg_rol: null, np_wavg_margin: null,
  },
  {
    contract_id: 'n1', status: 'DECLINED', uw_year: 2025,
    country_name: 'Kenya', region: 'Africa',
    treaty_type: 'Excess of Loss', is_np: true, primary_cob: 'Motor',
    rate_to_usd: '1.0',
    quota_share_epi: null, surplus_epi: null, total_capacity: null,
    actuarial_margin: null,
    np_prem_local: '1500000', np_limit_local: '5000000', np_wavg_rol: '0.30', np_wavg_margin: '-0.05',
  },
];

describe('GET /api/portfolio-insights', () => {
  it('emits one row per contract with derived balance/ROL/margin and meta', async () => {
    queryHandlers.length = 0;
    pushHandler((sql) => (/FROM public\.contract\b/.test(sql) ? { rows: DB_ROWS } : undefined));
    const app = buildApp();
    const { status, body } = await call(app, '/api/portfolio-insights');

    expect(status).toBe(200);
    expect(body.rows).toHaveLength(2);

    const prop = body.rows.find((r) => r.contractId === 'p1');
    expect(prop.kind).toBe('PROP');
    expect(prop.premium).toBe(10_000_000);          // (8m + 2m) × 1.0
    expect(prop.exposure).toBe(50_000_000);
    expect(prop.balance).toBeCloseTo(5, 6);          // 50m / 10m
    expect(prop.rol).toBeNull();                     // prop → no ROL
    expect(prop.margin).toBeCloseTo(0.18, 6);

    const np = body.rows.find((r) => r.contractId === 'n1');
    expect(np.kind).toBe('NP');
    expect(np.premium).toBe(1_500_000);
    expect(np.rol).toBeCloseTo(0.30, 6);             // np → ROL defined
    expect(np.balance).toBeNull();                   // np → no balance
    expect(np.margin).toBeCloseTo(-0.05, 6);

    expect(body.meta.count).toBe(2);
    expect(body.meta.scored).toBe(2);
    expect(body.meta.byKind).toEqual({ PROP: 1, NP: 1 });
    expect(body.meta.byStatus).toEqual({ SIGNED: 1, DECLINED: 1 });
  });

  it('passes a custom ?status filter through to the query params', async () => {
    queryHandlers.length = 0;
    let seenParams = null;
    pushHandler((sql, params) => {
      if (/FROM public\.contract\b/.test(sql)) { seenParams = params; return { rows: [] }; }
      return undefined;
    });
    const app = buildApp();
    await call(app, '/api/portfolio-insights?status=signed,ntu');
    expect(seenParams[0]).toEqual(['SIGNED', 'NTU']);
  });

  it('drops rows with neither margin nor premium signal', async () => {
    queryHandlers.length = 0;
    pushHandler((sql) => (/FROM public\.contract\b/.test(sql)
      ? { rows: [{ ...DB_ROWS[0], actuarial_margin: null, quota_share_epi: null, surplus_epi: null, total_capacity: null }, DB_ROWS[1]] }
      : undefined));
    const app = buildApp();
    const { body } = await call(app, '/api/portfolio-insights');
    expect(body.rows.map((r) => r.contractId)).toEqual(['n1']);
  });
});
