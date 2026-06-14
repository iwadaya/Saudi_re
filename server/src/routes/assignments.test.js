// Assignment routes source the actor from the VERIFIED token (req.user.userId),
// ignoring any reassigned_by/user_id in the body — so nobody can act as someone
// else. The ownership services are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

const { svc } = vi.hoisted(() => ({
  svc: {
    selfAssign: vi.fn(), reassign: vi.fn(), allocate: vi.fn(),
    getAssignmentHistory: vi.fn(), listContractsWithOwnership: vi.fn(), listViewableUsers: vi.fn(),
  },
}));
vi.mock('../services/assignments.js', () => svc);
vi.mock('../services/permissions.js', () => ({ getEditPermission: vi.fn() }));

const { default: assignmentsRouter } = await import('./assignments.js');

let currentUser = null;
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(assignmentsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  return app;
}
async function call(app, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), { method, url: path, headers: { 'content-type': 'application/json' }, body: body || {} });
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app, statusCode: 200, setHeader() { return res; }, getHeader() {},
      status(c) { res.statusCode = c; return res; },
      json(p) { chunks.push(JSON.stringify(p)); res.end(); },
      end() { resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(chunks.join('')) : null }); },
    });
    res.req = req; req.res = res;
    try { app.handle(req, res, (e) => { if (e) reject(e); else resolve({ status: res.statusCode, body: null }); }); } catch (e) { reject(e); }
  });
}

beforeEach(() => { currentUser = null; Object.values(svc).forEach((f) => f.mockReset()); });

describe('reassign actor = verified token user', () => {
  it('records assigned_by as the token user, ignoring a spoofed reassigned_by in the body', async () => {
    currentUser = { userId: 'cu-real', roleCode: 'CU', hierarchyLevel: 2 };
    svc.reassign.mockResolvedValue({ assigned: true });
    const res = await call(buildApp(), {
      method: 'POST', path: '/contracts/c1/reassign',
      body: { reassigned_by: 'attacker', new_owner_id: 'owner-x', comment: 'x' },
    });
    expect(res.status).toBe(200);
    expect(svc.reassign).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'CONTRACT', entityId: 'c1', reassignedBy: 'cu-real', newOwnerId: 'owner-x',
    }));
  });

  it('401s when there is no verified identity', async () => {
    currentUser = null;
    const res = await call(buildApp(), { method: 'POST', path: '/contracts/c1/reassign', body: { reassigned_by: 'x', new_owner_id: 'y' } });
    expect(res.status).toBe(401);
    expect(svc.reassign).not.toHaveBeenCalled();
  });

  it('self-assign uses the token user, not the body', async () => {
    currentUser = { userId: 'me', roleCode: 'TUW', hierarchyLevel: 5 };
    svc.selfAssign.mockResolvedValue({ assignedTo: 'me' });
    await call(buildApp(), { method: 'POST', path: '/contracts/c1/assign', body: { user_id: 'someone-else' } });
    expect(svc.selfAssign).toHaveBeenCalledWith(expect.objectContaining({ userId: 'me' }));
  });
});
