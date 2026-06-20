// server/tests/integration/treatyDataDocuments.integration.test.js
//
// Access-control coverage for the shared document routes in routes/treatyData.js
// (audit item P0-1 — document IDOR):
//   • DELETE /documents/:docId
//   • GET    /documents/:docId/download
//   • GET    /documents/:docId/view
//   • GET    /documents/:docId/text
//
// Policy under test (assertCanAccessDocument): a document is never more
// accessible than its parent contract/quote. Reads inherit the parent READ
// policy (open to any authenticated user today); DELETE takes the assignee
// edit-lock. A missing/foreign document id is 404 on every route. download +
// delete write an audit event.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools, DEMO_USER_ID } from './helpers.js';
import { pool } from '../../src/db/pool.js';

// A second, authenticated user who is NOT the assignee of anything we create.
const OTHER_USER = { 'x-user-role': 'CU', 'x-user-id': '00000000-0000-0000-0000-0000000000ff' };
const MISSING_DOC_ID = '00000000-0000-0000-0000-0000deadbeef';

describe.skipIf(shouldSkipDb)('integration: document ACL (treatyData /documents/:docId)', () => {
  let harness;
  let refs;
  const createdContracts = [];
  const createdQuotes = [];
  const createdDocs = [];

  // The default harness user (DEMO_USER_ID, CU) creates — and therefore is the
  // assignee of — every contract/quote here. Uploads are edit-locked, so they
  // must run as the assignee.
  async function newContract() {
    const c = await harness
      .fetchApp('POST', '/api/treaties', { body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01' } })
      .then((r) => r.json());
    createdContracts.push(c.contract_id);
    return c.contract_id;
  }

  async function newQuote() {
    const q = await harness
      .fetchApp('POST', '/api/quotes', { body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' } })
      .then((r) => r.json());
    createdQuotes.push(q.quote_id);
    return q.quote_id;
  }

  async function uploadDoc(parentPath, body = 'hello document body') {
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'text/plain' }), 'doc.txt');
    const res = await harness.fetchApp('POST', parentPath, { body: form });
    expect(res.status).toBe(201);
    const doc = await res.json();
    createdDocs.push(doc.document_id);
    return doc.document_id;
  }

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
  });

  afterAll(async () => {
    if (harness) {
      for (const id of createdDocs) { try { await harness.fetchApp('DELETE', `/api/documents/${id}`); } catch {} }
      for (const id of createdContracts) { try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {} }
      for (const id of createdQuotes) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  it('owner/assignee can view, download, text-extract, and delete a contract document', async () => {
    const contractId = await newContract();
    const docId = await uploadDoc(`/api/treaties/${contractId}/documents`, 'owner-can-read');

    const view = await harness.fetchApp('GET', `/api/documents/${docId}/view`);
    expect(view.status).toBe(200);

    const download = await harness.fetchApp('GET', `/api/documents/${docId}/download`);
    expect(download.status).toBe(200);

    const text = await harness.fetchApp('GET', `/api/documents/${docId}/text`);
    expect(text.status).toBe(200);
    expect((await text.json()).text).toContain('owner-can-read');

    const del = await harness.fetchApp('DELETE', `/api/documents/${docId}`);
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);
  });

  it('a non-assignee can READ (reads are open) but is 403 READ_ONLY on DELETE', async () => {
    const contractId = await newContract();
    const docId = await uploadDoc(`/api/treaties/${contractId}/documents`, 'reader-body');

    // Reads inherit the contract read policy → open to any authenticated user.
    for (const sub of ['view', 'download', 'text']) {
      const res = await harness.fetchApp('GET', `/api/documents/${docId}/${sub}`, { headers: OTHER_USER });
      expect(res.status, `GET ${sub} as non-assignee`).toBe(200);
    }

    // DELETE takes the assignee edit-lock → the non-assignee is blocked.
    const del = await harness.fetchApp('DELETE', `/api/documents/${docId}`, { headers: OTHER_USER });
    expect(del.status).toBe(403);
    expect((await del.json()).code).toBe('READ_ONLY');

    // The document survived the blocked delete — the assignee can still read it.
    const stillThere = await harness.fetchApp('GET', `/api/documents/${docId}/view`);
    expect(stillThere.status).toBe(200);
  });

  it('a missing / foreign-by-id document is 404 on every route (closes load-by-id IDOR)', async () => {
    for (const path of [
      `/api/documents/${MISSING_DOC_ID}/view`,
      `/api/documents/${MISSING_DOC_ID}/download`,
      `/api/documents/${MISSING_DOC_ID}/text`,
    ]) {
      const res = await harness.fetchApp('GET', path);
      expect(res.status, `GET ${path}`).toBe(404);
    }
    const del = await harness.fetchApp('DELETE', `/api/documents/${MISSING_DOC_ID}`);
    expect(del.status).toBe(404);
  });

  it('download and delete write in-trail audit events (actor, doc id, contract id, action)', async () => {
    const contractId = await newContract();
    const docId = await uploadDoc(`/api/treaties/${contractId}/documents`, 'audited-body');

    expect((await harness.fetchApp('GET', `/api/documents/${docId}/download`)).status).toBe(200);
    expect((await harness.fetchApp('DELETE', `/api/documents/${docId}`)).status).toBe(200);

    const { rows } = await pool.query(
      `SELECT event_type, actor, payload
         FROM public.contract_audit_event
        WHERE contract_id = $1 AND event_type IN ('DOCUMENT_DOWNLOADED','DOCUMENT_DELETED')
        ORDER BY created_at`,
      [contractId],
    );
    const byType = Object.fromEntries(rows.map((r) => [r.event_type, r]));

    expect(byType.DOCUMENT_DOWNLOADED).toBeTruthy();
    expect(byType.DOCUMENT_DOWNLOADED.actor).toBe(DEMO_USER_ID);
    expect(byType.DOCUMENT_DOWNLOADED.payload).toMatchObject({ documentId: docId, contractId, action: 'download' });

    expect(byType.DOCUMENT_DELETED).toBeTruthy();
    expect(byType.DOCUMENT_DELETED.actor).toBe(DEMO_USER_ID);
    expect(byType.DOCUMENT_DELETED.payload).toMatchObject({ documentId: docId, contractId, action: 'delete' });
  });

  it('regression: quote-owned documents use the same shared routes — readable, assignee-only delete', async () => {
    const quoteId = await newQuote();
    const docId = await uploadDoc(`/api/quotes/${quoteId}/documents`, 'quote-doc-body');

    // Reader (non-assignee) may view; delete is assignee-locked.
    expect((await harness.fetchApp('GET', `/api/documents/${docId}/view`, { headers: OTHER_USER })).status).toBe(200);
    const blocked = await harness.fetchApp('DELETE', `/api/documents/${docId}`, { headers: OTHER_USER });
    expect(blocked.status).toBe(403);

    // Assignee can delete.
    expect((await harness.fetchApp('DELETE', `/api/documents/${docId}`)).status).toBe(200);
  });
});
