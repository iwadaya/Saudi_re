// server/tests/integration/documentSignedUrl.integration.test.js
//
// P0-3: private document storage. A remote (Cloudinary) document must be served
// via an app-minted, short-lived SIGNED URL produced only AFTER the P0-1 ACL
// check — never a redirect to the permanent stored URL. This verifies:
//   • an authorised read 302-redirects to the freshly-minted signed URL (≠ stored);
//   • an unauthenticated caller is 401 and NEVER mints a URL;
//   • a missing/foreign document is 404 and NEVER mints a URL.
//
// Cloudinary is mocked (no real account); the test sets CLOUDINARY_URL so the
// signing path is exercised. Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools, DEMO_USER_ID } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const { cldMock } = vi.hoisted(() => ({
  cldMock: {
    config: vi.fn(),
    url: vi.fn((publicId, opts) => `https://signed.example/${publicId}?exp=${opts.expires_at}`),
    uploader: { upload_stream: vi.fn(), destroy: vi.fn(() => Promise.resolve({ result: 'ok' })) },
  },
}));
vi.mock('cloudinary', () => ({ v2: cldMock }));

const STORED_URL = 'https://res.cloudinary.com/cloud/raw/authenticated/v1/universe3/doc/secret.pdf';
const MISSING_DOC = '00000000-0000-0000-0000-0000feedface';
const AUTHED = { 'x-user-role': 'CU', 'x-user-id': DEMO_USER_ID };

describe.skipIf(shouldSkipDb)('integration: private document signed-URL serving', () => {
  let harness;
  let refs;
  let contractId;
  let docId;

  // Raw fetch so we can inspect the 302 instead of following it to the (mocked) CDN.
  const req = (path, headers) => fetch(`${harness.baseUrl}${path}`, { redirect: 'manual', headers: { ...headers } });

  beforeAll(async () => {
    process.env.CLOUDINARY_URL = 'cloudinary://key:secret@cloud';
    const { _resetCloudinaryForTests } = await import('../../src/lib/uploadStorage.js');
    _resetCloudinaryForTests();

    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01' },
    }).then((r) => r.json());
    contractId = c.contract_id;
    const { rows } = await pool.query(
      `INSERT INTO public.contract_document (contract_id, file_name, mime_type, storage_path)
       VALUES ($1,'secret.pdf','application/pdf',$2) RETURNING document_id`,
      [contractId, STORED_URL],
    );
    docId = rows[0].document_id;
  });

  afterAll(async () => {
    try { await pool.query(`DELETE FROM public.contract_document WHERE document_id=$1`, [docId]); } catch {}
    if (harness) { try { await harness.fetchApp('DELETE', `/api/treaties/${contractId}`); } catch {} await harness.close(); }
    delete process.env.CLOUDINARY_URL;
    await closePools();
  });

  it('an authorised view 302-redirects to a freshly-minted signed URL, not the stored one', async () => {
    cldMock.url.mockClear();
    const res = await req(`/api/documents/${docId}/view`, AUTHED);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location');
    expect(loc).toMatch(/^https:\/\/signed\.example\//);
    expect(loc).not.toBe(STORED_URL);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(cldMock.url).toHaveBeenCalledTimes(1); // minted exactly once, after the ACL passed
  });

  it('an authorised download also redirects to a signed URL', async () => {
    cldMock.url.mockClear();
    const res = await req(`/api/documents/${docId}/download`, AUTHED);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/signed\.example\//);
    expect(cldMock.url).toHaveBeenCalled();
  });

  it('an unauthenticated caller is 401 and never mints a URL', async () => {
    cldMock.url.mockClear();
    const res = await req(`/api/documents/${docId}/view`); // no auth headers
    expect(res.status).toBe(401);
    expect(cldMock.url).not.toHaveBeenCalled();
  });

  it('a missing/foreign document is 404 and never mints a URL', async () => {
    cldMock.url.mockClear();
    const res = await req(`/api/documents/${MISSING_DOC}/view`, AUTHED);
    expect(res.status).toBe(404);
    expect(cldMock.url).not.toHaveBeenCalled();
  });
});
