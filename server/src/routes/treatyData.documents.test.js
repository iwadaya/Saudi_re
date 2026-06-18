import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const treatyDataRouter = (await import('./treatyData.js')).default;

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const servers = [];
const P = (value) => Promise.resolve(value);

let scenario;

function fakeQuery(sql) {
  if (sql.includes('FROM public.contract_document') && sql.includes('WHERE document_id=$1')) {
    return P({ rows: scenario.documentRows });
  }
  if (sql.includes('FROM public.contract_document') && sql.includes('WHERE contract_id=$1')) {
    return P({ rows: scenario.documentRows.map(({ storage_path: _storage_path, ...row }) => row) });
  }
  if (sql.includes('owner_level')) {
    return P({ rows: scenario.ownershipRows });
  }
  if (sql.includes('DELETE FROM public.contract_document')) {
    return P({ rowCount: scenario.deleteRowCount ?? 1, rows: [] });
  }
  return P({ rows: [] });
}

beforeEach(() => {
  scenario = {
    documentRows: [{
      document_id: 'doc-1',
      contract_id: 'contract-1',
      quote_id: null,
      file_name: 'slip.pdf',
      mime_type: 'application/pdf',
      size_bytes: 123,
      storage_path: 'https://res.cloudinary.com/demo/raw/upload/slip.pdf',
    }],
    ownershipRows: [{ assigned_to_user_id: 'owner', owner_level: 5, assigned_to_name: 'Owner' }],
    deleteRowCount: 1,
  };
  poolMock.query.mockReset();
  poolMock.query.mockImplementation(fakeQuery);
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => { s.close(resolve); s.closeAllConnections?.(); });
  }
});

function boot(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', treatyDataRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
    servers.push(s);
  });
}

describe('contract document route authorization', () => {
  it('blocks a non-assignee from listing treaty documents', async () => {
    const base = await boot({ userId: 'other', hierarchyLevel: 5, isSupervisor: false });
    const res = await fetch(`${base}/api/treaties/contract-1/documents`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists treaty document metadata for the assignee without exposing storage_path', async () => {
    const base = await boot({ userId: 'owner', hierarchyLevel: 5, isSupervisor: false });
    const res = await fetch(`${base}/api/treaties/contract-1/documents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).not.toHaveProperty('storage_path');
  });

  it('blocks a non-assignee from viewing a document by id', async () => {
    const base = await boot({ userId: 'other', hierarchyLevel: 5, isSupervisor: false });
    const res = await fetch(`${base}/api/documents/doc-1/view`, { redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows the assignee to view a document by id', async () => {
    const base = await boot({ userId: 'owner', hierarchyLevel: 5, isSupervisor: false });
    const res = await fetch(`${base}/api/documents/doc-1/view`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://res.cloudinary.com/demo/raw/upload/slip.pdf');
  });

  it('blocks a non-assignee from deleting a document by id', async () => {
    const base = await boot({ userId: 'other', hierarchyLevel: 5, isSupervisor: false });
    const res = await fetch(`${base}/api/documents/doc-1`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'READ_ONLY' });
  });
});
