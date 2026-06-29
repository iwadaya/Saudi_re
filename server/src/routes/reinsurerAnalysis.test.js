import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(fakeQuery) },
}));

const { default: reinsurerAnalysisRouter } = await import('./reinsurerAnalysis.js');

function buildApp() {
  const app = express();
  app.use('/api', reinsurerAnalysisRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

async function call(app, path) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), { method: 'GET', url: path, headers: {} });
    const resHeaders = {};
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app,
      statusCode: 200,
      setHeader(k, v) { resHeaders[k] = v; return res; },
      getHeader(k) { return resHeaders[k]; },
      status(code) { res.statusCode = code; return res; },
      json(payload) { chunks.push(JSON.stringify(payload)); res.end(); },
      end() {
        resolve({
          status: res.statusCode,
          body: chunks.length ? JSON.parse(chunks.join('')) : null,
        });
      },
    });
    res.req = req;
    req.res = res;
    try {
      app.handle(req, res, (err) => err ? reject(err) : resolve({ status: res.statusCode, body: null }));
    } catch (e) {
      reject(e);
    }
  });
}

// A pool of NP layers spanning two reinsurers. Swiss Re leads two treaties
// (3 layers), Munich Re one (1 layer), so Swiss Re must sort first by treaty
// count. COBs and treaty types span duplicates across rows to exercise the
// distinct-sorted facet lists.
const POOL_ROWS = [
  {
    contract_id: 'c1', layer_id: 'c1l1', layer_number: 1, lead_reinsurer: 'Swiss Re',
    cedant_name: 'Cedant Alpha', country_name: 'Saudi Arabia', region: 'Middle East',
    uw_year: 2025, treaty_type: 'Per Risk XL', peril_scope: 'RISK',
    attachment: '1000000', layer_limit: '5000000', egnpi: '20000000', rol: '0.05',
    cob_names: ['Property', 'Marine'],
  },
  {
    contract_id: 'c1', layer_id: 'c1l2', layer_number: 2, lead_reinsurer: 'Swiss Re',
    cedant_name: 'Cedant Alpha', country_name: 'Saudi Arabia', region: 'Middle East',
    uw_year: 2025, treaty_type: 'Per Risk XL', peril_scope: 'RISK',
    attachment: '6000000', layer_limit: '10000000', egnpi: '20000000', rol: '0.025',
    cob_names: ['Property', 'Marine'],
  },
  {
    contract_id: 'c2', layer_id: 'c2l1', layer_number: 1, lead_reinsurer: 'Swiss Re',
    cedant_name: 'Cedant Beta', country_name: 'UAE', region: 'Middle East',
    uw_year: 2024, treaty_type: 'Per Risk XL', peril_scope: 'RISK',
    attachment: '2000000', layer_limit: '8000000', egnpi: '15000000', rol: '0.04',
    cob_names: ['Property'],
  },
  {
    contract_id: 'c3', layer_id: 'c3l1', layer_number: 1, lead_reinsurer: 'Munich Re',
    cedant_name: 'Cedant Gamma', country_name: 'Qatar', region: 'Middle East',
    uw_year: 2025, treaty_type: 'Cat XL', peril_scope: 'CAT',
    attachment: '3000000', layer_limit: '12000000', egnpi: '30000000', rol: '0.10',
    cob_names: ['Aviation', 'Energy'],
  },
];

beforeEach(() => {
  queryHandlers.length = 0;
});

describe('GET /api/reinsurer-analysis', () => {
  it('converts the stored ROL fraction to a percent on each point', async () => {
    pushHandler((sql) => (sql.includes('pricing_leads') ? { rows: POOL_ROWS } : undefined));
    const app = buildApp();
    const r = await call(app, '/api/reinsurer-analysis');
    expect(r.status).toBe(200);
    const p1 = r.body.points.find((p) => p.id === 'c1:c1l1');
    expect(p1.rolPct).toBeCloseTo(5, 6);        // 0.05 → 5%
    expect(p1.contractId).toBe('c1');
    expect(p1.layerId).toBe('c1l1');
    expect(p1.limit).toBe(5000000);
    expect(p1.attachment).toBe(1000000);
    expect(p1.egnpi).toBe(20000000);
    expect(p1.cob).toBe('Property');           // first element of cobs[]
    expect(p1.cobs).toEqual(['Property', 'Marine']);
    const p3 = r.body.points.find((p) => p.id === 'c3:c3l1');
    expect(p3.rolPct).toBeCloseTo(10, 6);       // 0.10 → 10%
  });

  it('builds the reinsurer index sorted by treatyCount desc with correct treaty/layer counts', async () => {
    pushHandler((sql) => (sql.includes('pricing_leads') ? { rows: POOL_ROWS } : undefined));
    const app = buildApp();
    const r = await call(app, '/api/reinsurer-analysis');
    expect(r.status).toBe(200);
    expect(r.body.reinsurers).toEqual([
      { name: 'Swiss Re', treatyCount: 2, layerCount: 3 },
      { name: 'Munich Re', treatyCount: 1, layerCount: 1 },
    ]);
    expect(r.body.pointCount).toBe(4);
    expect(r.body.treatyCount).toBe(3);         // c1, c2, c3
    expect(r.body.truncated).toBe(false);
  });

  it('returns distinct, sorted cobs and treatyTypes', async () => {
    pushHandler((sql) => (sql.includes('pricing_leads') ? { rows: POOL_ROWS } : undefined));
    const app = buildApp();
    const r = await call(app, '/api/reinsurer-analysis');
    expect(r.status).toBe(200);
    expect(r.body.cobs).toEqual(['Aviation', 'Energy', 'Marine', 'Property']);
    expect(r.body.treatyTypes).toEqual(['Cat XL', 'Per Risk XL']);
  });

  it('returns distinct, sorted countries and regions', async () => {
    pushHandler((sql) => (sql.includes('pricing_leads') ? { rows: POOL_ROWS } : undefined));
    const app = buildApp();
    const r = await call(app, '/api/reinsurer-analysis');
    expect(r.status).toBe(200);
    expect(r.body.countries).toEqual(['Qatar', 'Saudi Arabia', 'UAE']);
    expect(r.body.regions).toEqual(['Middle East']);
  });

  it('returns empty facets and zero counts for an empty pool', async () => {
    pushHandler((sql) => (sql.includes('pricing_leads') ? { rows: [] } : undefined));
    const app = buildApp();
    const r = await call(app, '/api/reinsurer-analysis');
    expect(r.status).toBe(200);
    expect(r.body.points).toEqual([]);
    expect(r.body.reinsurers).toEqual([]);
    expect(r.body.cobs).toEqual([]);
    expect(r.body.treatyTypes).toEqual([]);
    expect(r.body.countries).toEqual([]);
    expect(r.body.regions).toEqual([]);
    expect(r.body.pointCount).toBe(0);
    expect(r.body.treatyCount).toBe(0);
    expect(r.body.truncated).toBe(false);
    expect(typeof r.body.generatedAt).toBe('string');
  });
});
