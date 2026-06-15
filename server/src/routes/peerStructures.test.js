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

const { default: peerStructuresRouter } = await import('./peerStructures.js');

function buildApp() {
  const app = express();
  app.use('/api', peerStructuresRouter);
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

const UUID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  queryHandlers.length = 0;
});

describe('GET /api/treaties/:contractId/peer-structures', () => {
  it('rejects a non-UUID contract id with 400 VALIDATION_FAILED', async () => {
    const app = buildApp();
    const r = await call(app, '/api/treaties/not-a-uuid/peer-structures');
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown scope with 400', async () => {
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=sector`);
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe('VALIDATION_FAILED');
  });

  it('404s when neither a contract nor a quote resolves the source id', async () => {
    pushHandler((sql) => {
      // Both lookups return empty: contract first, then quote fallback.
      if (sql.includes('WHERE c.contract_id = $1')) return { rows: [] };
      if (sql.includes('WHERE q.quote_id = $1')) return { rows: [] };
      return undefined;
    });
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country`);
    expect(r.status).toBe(404);
    expect(r.body?.error).toBe('Contract not found');
  });

  it('falls back to public.quote when the id is not in public.contract', async () => {
    pushHandler((sql) => {
      if (sql.includes('WHERE c.contract_id = $1')) return { rows: [] };
      if (sql.includes('WHERE q.quote_id = $1')) {
        return { rows: [{
          source_id: UUID, source_kind: 'quote',
          country_id: 'cn-1', uw_year: 2025,
          country_code: 'KSA', country_name: 'Saudi Arabia', region: 'Middle East',
        }] };
      }
      if (sql.includes('WITH peer_contracts AS')) {
        return { rows: [{
          contract_id: 'p1', uw_year: 2025,
          country_code: 'KSA', country_name: 'Saudi Arabia', region: 'Middle East',
          cedant_name: 'Cedant Alpha',
          total_limit: '10000000', total_egnpi: '20000000',
          primary_attachment: '1000000', weighted_rol: '0.05',
          layer_count: 2, cob_name: 'Marine',
        }] };
      }
      return undefined;
    });
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country`);
    expect(r.status).toBe(200);
    expect(r.body.sourceContract).toMatchObject({
      contractId: UUID,
      sourceKind: 'quote',
      countryCode: 'KSA',
    });
    expect(r.body.peerCount).toBe(1);
    expect(r.body.peers[0]).toMatchObject({ id: 'p1', cob: 'Marine' });
  });

  it('returns an empty peer set with a note when the source has no country_id (country scope)', async () => {
    pushHandler((sql) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{
          source_id: UUID, source_kind: 'contract',
          country_id: null, uw_year: 2025,
          country_code: null, country_name: null, region: null,
        }] };
      }
      return undefined;
    });
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country`);
    expect(r.status).toBe(200);
    expect(r.body.peerCount).toBe(0);
    expect(r.body.peers).toEqual([]);
    expect(r.body.note).toMatch(/no country_id/);
  });

  it('returns peers with computed metrics in country scope', async () => {
    pushHandler((sql) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{
          source_id: UUID, source_kind: 'contract',
          country_id: 'cn-1', uw_year: 2025,
          country_code: 'KSA', country_name: 'Saudi Arabia', region: 'Middle East',
        }] };
      }
      if (sql.includes('WITH peer_contracts AS')) {
        return { rows: [
          {
            contract_id: 'p1', uw_year: 2025,
            country_code: 'KSA', country_name: 'Saudi Arabia', region: 'Middle East',
            cedant_name: 'Cedant Alpha',
            total_limit: '50000000', total_egnpi: '100000000',
            primary_attachment: '5000000', weighted_rol: '0.052',
            layer_count: 3, cob_name: 'Property',
          },
          {
            contract_id: 'p2', uw_year: 2024,
            country_code: 'KSA', country_name: 'Saudi Arabia', region: 'Middle East',
            cedant_name: null,
            total_limit: '0', total_egnpi: '0',
            primary_attachment: null, weighted_rol: null,
            layer_count: 1, cob_name: null,
          },
        ] };
      }
      return undefined;
    });
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country`);
    expect(r.status).toBe(200);
    expect(r.body.peerCount).toBe(2);
    expect(r.body.peers[0]).toMatchObject({
      id: 'p1',
      cedant: 'Cedant Alpha',
      country: 'KSA',
      cob: 'Property',
      limit: 50000000,
      ded: 5000000,
      egnpi: 100000000,
      rolPct: 5.2,
    });
    // null defaults flow through to zeros so the modal's median / pRank
    // helpers can still ingest the row.
    expect(r.body.peers[1]).toMatchObject({
      id: 'p2',
      cedant: 'Unknown',
      cob: 'Unclassified',
      limit: 0,
      ded: 0,
      egnpi: 0,
      rolPct: 0,
    });
    expect(r.body.sourceContract).toMatchObject({
      contractId: UUID,
      sourceKind: 'contract',
      countryCode: 'KSA',
      region: 'Middle East',
    });
  });

  it('drops invalid UUIDs from cobIds before issuing the query', async () => {
    let capturedSql = null;
    let capturedParams = null;
    pushHandler((sql, params) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{
          source_id: UUID, source_kind: 'contract',
          country_id: 'cn-1', uw_year: 2025,
          country_code: 'KSA', country_name: 'KSA', region: 'ME',
        }] };
      }
      if (sql.includes('WITH peer_contracts AS')) {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      }
      return undefined;
    });
    const app = buildApp();
    const goodCob = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country&cobIds=${goodCob},not-a-uuid`);
    expect(r.status).toBe(200);
    expect(capturedSql).toContain('contract_class_of_business');
    // Only the valid UUID survives the filter — the rejected token never
    // reaches the params array.
    expect(capturedParams).toEqual(expect.arrayContaining([[goodCob]]));
    expect(JSON.stringify(capturedParams)).not.toContain('not-a-uuid');
  });

  it('unions contract + quote NP branches and restricts to the source treaty type', async () => {
    let capturedSql = null;
    let capturedParams = null;
    pushHandler((sql, params) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{
          source_id: UUID, source_kind: 'contract',
          country_id: 'cn-1', uw_year: 2025, treaty_type_id: 'tt-9',
          country_code: 'KSA', country_name: 'Saudi Arabia', region: 'Middle East',
        }] };
      }
      if (sql.includes('WITH peer_contracts AS')) {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [
          { contract_id: 'c1', uw_year: 2025, country_code: 'KSA', country_name: 'KSA', region: 'ME',
            cedant_name: 'Bound Re', total_limit: '10000000', total_egnpi: '20000000',
            primary_attachment: '1000000', weighted_rol: '0.05', layer_count: 2, cob_name: 'Property' },
          { contract_id: 'q1', uw_year: 2024, country_code: 'KSA', country_name: 'KSA', region: 'ME',
            cedant_name: 'Quoted Re', total_limit: '5000000', total_egnpi: '8000000',
            primary_attachment: '500000', weighted_rol: '0.07', layer_count: 1, cob_name: 'Marine' },
        ] };
      }
      return undefined;
    });
    const app = buildApp();
    const cob = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country&cobIds=${cob}`);
    expect(r.status).toBe(200);
    // Both a bound (contract) and an open quote-stage NP peer flow through the union.
    expect(r.body.peers.map((p) => p.id)).toEqual(['c1', 'q1']);
    // Same treaty type required on BOTH branches, bound to the source's id.
    expect(capturedSql).toContain('c.treaty_type_id = $');
    expect(capturedSql).toContain('q.treaty_type_id = $');
    expect(capturedParams).toContain('tt-9');
    // Quote branch unioned in, NP-only.
    expect(capturedSql).toContain('UNION ALL');
    expect(capturedSql).toContain('public.quote_np_details');
    // No status filter — NTU / Declined / Quoted / Signed / Bound all eligible.
    expect(capturedSql).not.toMatch(/status/i);
    // De-dup: a quote whose bound contract is in the pool is dropped (not double-counted).
    expect(capturedSql).toContain('NOT EXISTS');
    expect(capturedSql).toContain('q.parent_contract_id');
  });

  it('requires COB overlap (≥1 shared class) on both branches via EXISTS … ANY()', async () => {
    let capturedSql = null;
    let capturedParams = null;
    pushHandler((sql, params) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{ source_id: UUID, source_kind: 'contract', country_id: 'cn-1', uw_year: 2025, treaty_type_id: 'tt-9', country_code: 'KSA', country_name: 'KSA', region: 'ME' }] };
      }
      if (sql.includes('WITH peer_contracts AS')) { capturedSql = sql; capturedParams = params; return { rows: [] }; }
      return undefined;
    });
    const app = buildApp();
    const cobA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const cobB = 'ffffffff-1111-2222-3333-444444444444';
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country&cobIds=${cobA},${cobB}`);
    expect(r.status).toBe(200);
    // A peer carrying ≥1 of these classes satisfies EXISTS … ANY() (included); one
    // sharing none fails it (excluded). Both branches use their own class table.
    expect(capturedSql).toContain('contract_class_of_business');
    expect(capturedSql).toContain('quote_class_of_business');
    expect(capturedSql).toMatch(/class_of_business_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(capturedParams).toEqual(expect.arrayContaining([[cobA, cobB]]));
  });

  it('derives the source COB set when cobIds is omitted', async () => {
    let capturedParams = null;
    pushHandler((sql, params) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{ source_id: UUID, source_kind: 'contract', country_id: 'cn-1', uw_year: 2025, treaty_type_id: 'tt-9', country_code: 'KSA', country_name: 'KSA', region: 'ME' }] };
      }
      if (sql.includes('FROM public.contract_class_of_business WHERE contract_id = $1')) {
        return { rows: [{ class_of_business_id: 'src-cob-1' }, { class_of_business_id: 'src-cob-2' }] };
      }
      if (sql.includes('WITH peer_contracts AS')) { capturedParams = params; return { rows: [] }; }
      return undefined;
    });
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country`);
    expect(r.status).toBe(200);
    // The source's own classes become the required overlap set.
    expect(capturedParams).toEqual(expect.arrayContaining([['src-cob-1', 'src-cob-2']]));
    expect(r.body.note).toBeUndefined(); // both treaty type and classes resolved
  });

  it('skips treaty-type / COB filters with a note when the source has neither', async () => {
    let capturedSql = null;
    pushHandler((sql) => {
      if (sql.includes('WHERE c.contract_id = $1')) {
        return { rows: [{ source_id: UUID, source_kind: 'contract', country_id: 'cn-1', uw_year: 2025, treaty_type_id: null, country_code: 'KSA', country_name: 'KSA', region: 'ME' }] };
      }
      if (sql.includes('FROM public.contract_class_of_business WHERE contract_id = $1')) return { rows: [] };
      if (sql.includes('WITH peer_contracts AS')) { capturedSql = sql; return { rows: [] }; }
      return undefined;
    });
    const app = buildApp();
    const r = await call(app, `/api/treaties/${UUID}/peer-structures?scope=country`);
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/no treaty type/);
    expect(r.body.note).toMatch(/no classes/);
    expect(capturedSql).not.toContain('treaty_type_id = $');
    expect(capturedSql).not.toContain('class_of_business_id = ANY');
  });
});
