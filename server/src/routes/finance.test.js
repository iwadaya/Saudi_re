// server/src/routes/finance.js unit tests.
//
// Exercises the acknowledge mutation without a live DB by mocking pg queries.
// This locks in the finance-approval gate so junior users cannot activate
// PENDING_SETUP entries.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const ENTRY_ID = '11111111-1111-1111-1111-111111111111';
const queryLog = [];
let entryStatus = 'PENDING_SETUP';

function fakeQuery(sql, params = []) {
  queryLog.push({ sql, params });

  if (sql.includes("UPDATE public.finance_treaty_entry") && sql.includes("SET status = 'ACTIVE'")) {
    const [entryId] = params;
    if (entryId !== ENTRY_ID || entryStatus !== 'PENDING_SETUP') return Promise.resolve({ rows: [] });
    entryStatus = 'ACTIVE';
    return Promise.resolve({ rows: [{ entry_id: ENTRY_ID, contract_id: 'c-1', status: 'ACTIVE' }] });
  }

  if (sql.includes('SELECT status FROM public.finance_treaty_entry WHERE entry_id=$1')) {
    return Promise.resolve(entryStatus ? { rows: [{ status: entryStatus }] } : { rows: [] });
  }

  return Promise.resolve({ rows: [] });
}

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(fakeQuery) },
}));

const logAuditMock = vi.fn(() => Promise.resolve());
vi.mock('../services/audit.js', () => ({
  logAudit: (...args) => logAuditMock(...args),
  resolveAuditActor: vi.fn(async (req) => ({
    actorUserId: req?.user?.userId ?? null,
    actorName: req?.user?.displayName ?? 'SYSTEM',
    actorRole: req?.user?.roleCode ?? null,
  })),
}));

const { default: financeRouter } = await import('./finance.js');

let currentUser = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(financeRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  });
  return app;
}

async function call(app, { method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), {
      method,
      url: path,
      headers: { 'content-type': 'application/json', ...headers },
      body: body || {},
    });
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app,
      statusCode: 200,
      setHeader() { return res; },
      getHeader() { return undefined; },
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
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: res.statusCode, body: null });
      });
    } catch (e) {
      reject(e);
    }
  });
}

beforeEach(() => {
  currentUser = null;
  queryLog.length = 0;
  entryStatus = 'PENDING_SETUP';
  logAuditMock.mockClear();
});

describe('POST /finance/entries/:id/acknowledge', () => {
  it('returns 403 for junior users before any DB mutation', async () => {
    currentUser = { userId: 'u-junior', roleCode: 'TUW', hierarchyLevel: 5, displayName: 'Junior UW' };
    const res = await call(buildApp(), { method: 'POST', path: `/finance/entries/${ENTRY_ID}/acknowledge` });

    expect(res.status).toBe(403);
    expect(queryLog.some((q) => q.sql.includes('UPDATE public.finance_treaty_entry'))).toBe(false);
  });

  it('allows approver-tier users and prevents double-acknowledge', async () => {
    currentUser = { userId: 'u-approver', roleCode: 'CU', hierarchyLevel: 4, displayName: 'Approver' };

    const ack = await call(buildApp(), { method: 'POST', path: `/finance/entries/${ENTRY_ID}/acknowledge` });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ ok: true, entry_id: ENTRY_ID, status: 'ACTIVE' });

    const again = await call(buildApp(), { method: 'POST', path: `/finance/entries/${ENTRY_ID}/acknowledge` });
    expect(again.status).toBe(422);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });
});
