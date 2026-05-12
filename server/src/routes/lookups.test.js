import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { invalidateJsonCache } from '../middleware/httpCache.js';

const queryLog = [];

function fakeQuery(sql) {
  queryLog.push(sql);
  if (sql.includes('FROM public.brokers')) {
    return Promise.resolve({ rows: [{ id: 'broker-1', name: 'A Broker' }] });
  }
  return Promise.resolve({ rows: [] });
}

vi.mock('../db/pool.js', () => ({
  pool: {
    query: vi.fn(fakeQuery),
  },
}));

const { default: lookupsRouter } = await import('./lookups.js');

function buildApp() {
  const app = express();
  app.use('/api', lookupsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

async function call(app, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), {
      method,
      url: path,
      headers,
    });
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
          headers: resHeaders,
          body: chunks.length ? JSON.parse(chunks.join('')) : null,
        });
      },
    });
    res.req = req;
    req.res = res;
    try {
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: res.statusCode, headers: resHeaders, body: null });
      });
    } catch (e) {
      reject(e);
    }
  });
}

beforeEach(() => {
  queryLog.length = 0;
  invalidateJsonCache('ref:');
});

describe('lookup reference cache', () => {
  it('serves repeated broker lookups from the shared JSON cache with ETag support', async () => {
    const app = buildApp();

    const first = await call(app, { path: '/api/brokers' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual([{ id: 'broker-1', name: 'A Broker' }]);
    expect(first.headers.ETag).toMatch(/^W\/".+"$/);
    expect(queryLog).toHaveLength(1);

    const second = await call(app, { path: '/api/brokers' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(queryLog).toHaveLength(1);

    const notModified = await call(app, {
      path: '/api/brokers',
      headers: { 'if-none-match': first.headers.ETag },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBe(null);
    expect(queryLog).toHaveLength(1);
  });

  it('clears reference cache through DELETE /ref/cache', async () => {
    const app = buildApp();

    await call(app, { path: '/api/brokers' });
    expect(queryLog).toHaveLength(1);

    const cleared = await call(app, { method: 'DELETE', path: '/api/ref/cache' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ ok: true, cleared: true });

    await call(app, { path: '/api/brokers' });
    expect(queryLog).toHaveLength(2);
  });
});
