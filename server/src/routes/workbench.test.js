// server/src/routes/workbench.test.js
// Approval-workflow unit tests for the Actuarial Formula Workbench.
//
// Mocks the pg pool with canned query responses so we can drive the
// route handlers through real Express middleware without a database.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// In-memory query log and queued responses keyed by SQL fragment.
const queryLog = [];
let queryHandlers = [];

function pushHandler(fragment, response) {
  queryHandlers.push({ fragment, response });
}

function fakeQuery(sql, params) {
  queryLog.push({ sql, params });
  const idx = queryHandlers.findIndex((h) => sql.includes(h.fragment));
  if (idx === -1) {
    return Promise.resolve({ rows: [] });
  }
  const [handler] = queryHandlers.splice(idx, 1);
  const value = typeof handler.response === 'function'
    ? handler.response({ sql, params })
    : handler.response;
  return Promise.resolve(value);
}

const fakeClient = {
  query: vi.fn(fakeQuery),
  release: vi.fn(),
};

vi.mock('../db/pool.js', () => ({
  pool: {
    query: vi.fn(fakeQuery),
    connect: vi.fn(() => Promise.resolve(fakeClient)),
  },
}));

vi.mock('../services/audit.js', () => ({
  logAudit: vi.fn(() => Promise.resolve()),
}));

const { default: workbenchRouter } = await import('./workbench.js');

function buildApp({ user } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user || {
      userId: '11111111-1111-1111-1111-111111111111',
      role: 'TUW',
      roleCode: 'TUW',
      displayName: 'Test User',
      hierarchyLevel: 5,
      canApprove: false,
      isSupervisor: false,
    };
    next();
  });
  app.use('/api', workbenchRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

// Lightweight request helper that drives the Express app via injected
// request/response objects — avoids pulling in supertest as a dep.
async function call(app, { method, path, body, user }) {
  if (user) {
    // App was already built; in tests we rebuild the app per-call when a
    // specific user is needed.
  }
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
    });
    const chunks = [];
    const statusCode = 200;
    const res = Object.assign(Object.create(express.response), {
      app,
      statusCode,
      setHeader() { return res; },
      getHeader() { return undefined; },
      status(code) { res.statusCode = code; return res; },
      json(payload) {
        chunks.push(JSON.stringify(payload));
        res.end();
      },
      end() {
        resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(chunks.join('')) : null });
      },
    });
    res.req = req;
    req.res = res;
    try {
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(chunks.join('')) : null });
      });
    } catch (e) {
      reject(e);
    }
  });
}

beforeEach(() => {
  queryLog.length = 0;
  queryHandlers = [];
  fakeClient.query.mockClear();
  fakeClient.release.mockClear();
});

describe('workbench: role gating', () => {
  it('rejects parameter submission from a Treaty Underwriter (level 5)', async () => {
    const app = buildApp(); // default = TUW
    const r = await call(app, {
      method: 'POST',
      path: '/api/workbench/parameters',
      body: { module: 'PROJECTIONS', formula_name: 'LDF_PROPERTY_CAT',
              parameter_key: 'ldfs', proposed_value: [1.3, 1.08] },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Treaty Director/);
  });

  it('allows parameter submission from a Treaty Director (level 3)', async () => {
    const app = buildApp({
      user: { userId: 'td-1', role: 'TD', displayName: 'TD One',
              hierarchyLevel: 3, canApprove: true, isSupervisor: false },
    });
    pushHandler('INSERT INTO public.formula_parameters', {
      rows: [{ id: 'p-1', current_value: null, pending_value: [1.3, 1.08] }],
    });
    pushHandler('INSERT INTO public.formula_change_log', { rows: [] });

    const r = await call(app, {
      method: 'POST',
      path: '/api/workbench/parameters',
      body: { module: 'PROJECTIONS', formula_name: 'LDF_PROPERTY_CAT',
              parameter_key: 'ldfs', proposed_value: [1.3, 1.08] },
    });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('PENDING');
  });

  it('rejects approve from a Treaty Director (level 3, not supervisor)', async () => {
    const app = buildApp({
      user: { userId: 'td-1', role: 'TD', displayName: 'TD One',
              hierarchyLevel: 3, canApprove: true, isSupervisor: false },
    });
    const r = await call(app, {
      method: 'PUT',
      path: '/api/workbench/parameters/p-1/approve',
      body: {},
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Chief Underwriter/);
  });

  it('allows approve from a Chief Underwriter (level 2)', async () => {
    const app = buildApp({
      user: { userId: 'cu-1', role: 'CU', displayName: 'Chief UW',
              hierarchyLevel: 2, canApprove: true, isSupervisor: true },
    });
    pushHandler('FROM public.formula_parameters', {
      rows: [{ id: 'p-1', current_value: [1.0], pending_value: [1.3], status: 'PENDING' }],
    });
    pushHandler('UPDATE public.formula_parameters', {
      rows: [{ id: 'p-1', current_value: [1.3] }],
    });
    pushHandler('INSERT INTO public.formula_change_log', { rows: [] });

    const r = await call(app, {
      method: 'PUT',
      path: '/api/workbench/parameters/p-1/approve',
      body: { comment: 'looks good' },
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe('p-1');
  });
});

describe('workbench: approval workflow', () => {
  it('rejects approving a row with no pending value', async () => {
    const app = buildApp({
      user: { userId: 'cu-1', role: 'CU', displayName: 'Chief UW',
              hierarchyLevel: 2, canApprove: true, isSupervisor: true },
    });
    pushHandler('FROM public.formula_parameters', {
      rows: [{ id: 'p-1', current_value: [1.0], pending_value: null, status: 'APPROVED' }],
    });

    const r = await call(app, {
      method: 'PUT',
      path: '/api/workbench/parameters/p-1/approve',
      body: {},
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/No pending change/);
  });

  it('returns 404 when approving an unknown parameter', async () => {
    const app = buildApp({
      user: { userId: 'cu-1', role: 'CU', displayName: 'Chief UW',
              hierarchyLevel: 2, canApprove: true, isSupervisor: true },
    });
    pushHandler('FROM public.formula_parameters', { rows: [] });

    const r = await call(app, {
      method: 'PUT',
      path: '/api/workbench/parameters/missing/approve',
      body: {},
    });
    expect(r.status).toBe(404);
  });

  it('reject keeps row APPROVED when current_value exists', async () => {
    const app = buildApp({
      user: { userId: 'cu-1', role: 'CU', displayName: 'Chief UW',
              hierarchyLevel: 2, canApprove: true, isSupervisor: true },
    });
    pushHandler('FROM public.formula_parameters', {
      rows: [{ id: 'p-1', current_value: [1.0], pending_value: [1.3], status: 'PENDING' }],
    });
    pushHandler('UPDATE public.formula_parameters', { rows: [] });
    pushHandler('INSERT INTO public.formula_change_log', { rows: [] });

    const r = await call(app, {
      method: 'PUT',
      path: '/api/workbench/parameters/p-1/reject',
      body: { comment: 'too aggressive' },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('APPROVED');
  });

  it('reject sets status to REJECTED for a brand-new (no current_value) row', async () => {
    const app = buildApp({
      user: { userId: 'cu-1', role: 'CU', displayName: 'Chief UW',
              hierarchyLevel: 2, canApprove: true, isSupervisor: true },
    });
    pushHandler('FROM public.formula_parameters', {
      rows: [{ id: 'p-1', current_value: null, pending_value: [1.3], status: 'PENDING' }],
    });
    pushHandler('UPDATE public.formula_parameters', { rows: [] });
    pushHandler('INSERT INTO public.formula_change_log', { rows: [] });

    const r = await call(app, {
      method: 'PUT',
      path: '/api/workbench/parameters/p-1/reject',
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
  });
});

describe('workbench: comments', () => {
  it('rejects empty comment text', async () => {
    const app = buildApp();
    const r = await call(app, {
      method: 'POST',
      path: '/api/workbench/comments',
      body: { module: 'PROJECTIONS', formula_name: 'LDF_PROPERTY_CAT', comment_text: '   ' },
    });
    expect(r.status).toBe(400);
  });

  it('allows any authenticated user to post a comment', async () => {
    const app = buildApp(); // TUW
    pushHandler('INSERT INTO public.formula_comments', {
      rows: [{ id: 'c-1', created_at: new Date().toISOString() }],
    });
    const r = await call(app, {
      method: 'POST',
      path: '/api/workbench/comments',
      body: { module: 'PROJECTIONS', formula_name: 'LDF_PROPERTY_CAT', comment_text: 'check this' },
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe('c-1');
  });
});
