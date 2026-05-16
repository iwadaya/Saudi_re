// server/tests/integration/renewalPackImport.integration.test.js
//
// Integration coverage for the simplified renewal-pack import:
//   POST   /api/quotes/:quoteId/import-renewal-pack
//   GET    /api/quotes/:quoteId/import-renewal-pack/:jobId
//   GET    /api/quotes/:quoteId/import-snapshots
//   POST   /api/quotes/:quoteId/import-snapshots/:snapshotId/restore
//
// Gated by TEST_WITH_DB=1.  The LLM HTTP call is intercepted by
// stubbing global.fetch so we don't need real network access. The
// file on disk is seeded directly so we don't have to wire a fake
// uploader.
//
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// env.js reads process.env at module-load time and caches it on the
// exported `env` object. Without the keys, llmClient.js would throw
// "No LLM provider configured" before our fetch interceptor fires.
// vi.hoisted() runs before any other import is resolved, so setting
// the keys here precedes the env-module load.
vi.hoisted(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
});
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { env } from '../../src/config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../../test/fixtures/renewal-packs');

// ── shared leaf + canned LLM responses ──────────────────────────────────────

const lf = (value, confidence = 1, source = 'test:A1') => ({ value, confidence, source });

function cannedProp() {
  return {
    cedant: lf('Acme Insurance Co'),
    treatyName: lf('Property QS 2026'),
    classes: lf(['Fire']),
    uwYearRange: lf([2017, 2026]),
    premium: {
      triangle: {
        uwYears: [2025, 2026],
        devPeriods: [12, 24],
        values: [[100, 200], [120, null]],
        source: 'Premium Triangle:A1:C3',
        confidence: 1,
      },
      latestEarned: lf(1_000_000),
      growthAssumption: lf(3),
    },
    claims: {
      triangle: {
        uwYears: [2025, 2026],
        devPeriods: [12, 24],
        values: [[50, 80], [60, null]],
        source: 'Claims Triangle:A1:C3',
        confidence: 1,
      },
      ultimateLossRatio: lf(55),
    },
    osTriangle: null,
    largeLosses: [
      {
        uwYear: lf(2024),
        insuredName: lf('Refinery'),
        description: lf('Fire'),
        date: lf('2024-03-15'),
        classOfBusiness: lf('Energy'),
        paid: lf(1_000_000),
        os: lf(0),
        incurred: lf(1_000_000),
      },
    ],
    catLosses: [],
    riskProfile: { books: [] },
    claimsProfile: { books: [] },
    cresta: { countries: [] },
    hasTriangles: true,
  };
}

function cannedNp() {
  return {
    cedant: lf('Lambda Re'),
    treatyName: lf('Property XL 2026'),
    classes: lf(['Property XL']),
    uwYearRange: lf([2017, 2025]),
    layers: [
      {
        layer: lf('L1'),
        limit: lf(5_000_000),
        attachment: lf(1_000_000),
        aggLimit: lf(10_000_000),
        egnpi: lf(20_000_000),
        rate: lf(2.5),
        earnedPremium: lf(500_000),
        mdp: lf(500_000),
        mdpAlt: lf(400_000),
        reinstatements: lf(2),
        reinstatementPct: lf(100),
      },
    ],
    egnpiHistory: [
      { year: lf(2024), egnpi: lf(40_000_000) },
      { year: lf(2025), egnpi: lf(50_000_000) },
    ],
    largeLosses: [],
    catLosses: [],
    riskProfile: { books: [] },
    claimsProfile: { books: [] },
    cresta: { countries: [] },
    hasTriangles: false,
  };
}

/**
 * Intercept LLM HTTP calls. Configurable per-test by reassigning the
 * `cannedResponse` ref. `pause` is a release valve used by the
 * concurrency test — when set, the fetch handler awaits it before
 * returning, holding the job in 'processing' so a second POST can
 * race it.
 */
function installLlmFetchInterceptor(getCannedJson, getPause) {
  const original = global.fetch;
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url || '');
    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
      const pause = getPause?.();
      if (pause) await pause;
      const text = JSON.stringify(getCannedJson());
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.openai.com/')) {
      const text = JSON.stringify(getCannedJson());
      return new Response(JSON.stringify({ output_text: text }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(url, init);
  });
  return () => { global.fetch = original; };
}

// ── test fixtures helpers ───────────────────────────────────────────────────

async function ensureTreatyTypes() {
  // The treaty_type seed runs as part of seeds/run.js, but the
  // integration test env may not have applied it. Insert two
  // well-known rows that the tests pick by category.
  await pool.query(
    `INSERT INTO public.treaty_type (treaty_type, category) VALUES
       ('Quota Share', 'PROPORTIONAL'),
       ('Excess of Loss', 'NON_PROPORTIONAL')
     ON CONFLICT DO NOTHING`,
  );
}

async function pickTreatyTypeId(category) {
  const { rows } = await pool.query(
    `SELECT treaty_type_id FROM public.treaty_type WHERE category=$1 LIMIT 1`,
    [category],
  );
  return rows[0]?.treaty_type_id || null;
}

async function createQuote({ treatyCategory = 'PROPORTIONAL' } = {}) {
  const treaty_type_id = await pickTreatyTypeId(treatyCategory);
  const { rows } = await pool.query(
    `INSERT INTO public.quote (uw_year, status, treaty_type_id, created_by_user_id, assigned_to_user_id)
     VALUES ($1, 'DRAFT', $2, NULL, NULL)
     RETURNING quote_id`,
    [new Date().getFullYear(), treaty_type_id],
  );
  return rows[0].quote_id;
}

async function createQuoteWithoutTreatyDetail() {
  const { rows } = await pool.query(
    `INSERT INTO public.quote (uw_year, status, treaty_type_id, created_by_user_id, assigned_to_user_id)
     VALUES ($1, 'DRAFT', NULL, NULL, NULL)
     RETURNING quote_id`,
    [new Date().getFullYear()],
  );
  return rows[0].quote_id;
}

/**
 * Seed a contract_document row pointing at a real file written under
 * env.uploadDir. The route loads the file via uploadStorage's local
 * path resolver.
 */
async function seedDocument({ quoteId, docType = 'renewal_pack', fixtureName = 'PROP_01.xlsx' }) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  const buf = fs.readFileSync(fixturePath);
  const subdir = `quotes/${quoteId}`;
  const filename = `${Date.now()}_${fixtureName}`;
  const relPath = `${subdir}/${filename}`;
  const absDir = path.resolve(env.uploadDir, subdir);
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.resolve(env.uploadDir, relPath), buf);

  // contract_document has a CHECK constraint requiring exactly one of
  // (contract_id, quote_id). Quote-owned docs leave contract_id NULL.
  const { rows: dRows } = await pool.query(
    `INSERT INTO public.contract_document
       (contract_id, quote_id, file_name, mime_type, size_bytes, storage_path, doc_type, title)
     VALUES (NULL, $1, $2, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', $3, $4, $5, $2)
     RETURNING document_id`,
    [quoteId, fixtureName, buf.length, relPath, docType],
  );
  return { documentId: dRows[0].document_id };
}

/**
 * Block on the job until it reaches a terminal state. Each tick polls
 * the GET endpoint; we cap at 5s so a hang fails clearly.
 */
async function waitForJob(harness, quoteId, jobId, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await harness.fetchApp('GET', `/api/quotes/${quoteId}/import-renewal-pack/${jobId}`);
    const body = await res.json();
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not finish within ${timeoutMs}ms`);
}

// ── test suite ──────────────────────────────────────────────────────────────

describe.skipIf(shouldSkipDb)('integration: renewal-pack import (simplified)', () => {
  let harness;
  let restoreFetch;
  const cannedResponseRef = { current: cannedProp };
  const pauseRef = { current: null };
  const createdQuoteIds = new Set();

  beforeAll(async () => {
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
    harness = await bootApp();
    restoreFetch = installLlmFetchInterceptor(
      () => cannedResponseRef.current(),
      () => pauseRef.current,
    );
    await ensureTreatyTypes();
  });

  beforeEach(() => {
    pauseRef.current = null;
    cannedResponseRef.current = cannedProp;
  });

  afterAll(async () => {
    restoreFetch?.();
    for (const id of createdQuoteIds) {
      try { await pool.query(`DELETE FROM public.quote WHERE quote_id=$1`, [id]); } catch {}
    }
    await harness.close();
    await closePools();
  });

  it('happy path: empty quote + renewal pack doc → 202 → done with filledPages + snapshot row + audit', async () => {
    cannedResponseRef.current = cannedProp;
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId });

    const postRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    expect(postRes.status).toBe(202);
    const { jobId } = await postRes.json();
    expect(jobId).toBeTruthy();

    const result = await waitForJob(harness, quoteId, jobId);
    expect(result.status).toBe('done');
    expect(result.filledPages).toEqual(expect.arrayContaining(['premium_history', 'claims_history', 'large_losses']));
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.unmatchedCresta)).toBe(true);
    expect(result.restorePointId).toBeTruthy();

    // Snapshot row exists, references the job, captured before-state
    // (which was empty).
    const { rows: snapRows } = await pool.query(
      `SELECT snapshot_id, filename, filled_pages, payload FROM public.import_snapshots
        WHERE quote_id=$1 ORDER BY captured_at DESC LIMIT 1`,
      [quoteId],
    );
    expect(snapRows).toHaveLength(1);
    expect(snapRows[0].snapshot_id).toBe(result.restorePointId);
    expect(snapRows[0].filename).toBe('PROP_01.xlsx');
    expect(snapRows[0].filled_pages).toEqual(expect.arrayContaining(['premium_history', 'claims_history']));
    // Pre-write snapshot of an empty quote → empty page states.
    expect(snapRows[0].payload.pages.premium_history.cells).toEqual([]);
    expect(snapRows[0].payload.pages.claims_history_paid.cells).toEqual([]);

    // Audit log entry references the snapshot id.
    const { rows: auditRows } = await pool.query(
      `SELECT event_type, payload FROM public.audit_log
        WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type='renewal_pack_imported'
        ORDER BY created_at DESC LIMIT 1`,
      [quoteId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].payload.snapshotId).toBe(result.restorePointId);
    expect(auditRows[0].payload.filledPagesCount).toBeGreaterThan(0);

    // Triangle cells actually landed on the quote.
    const { rows: premRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.quote_triangle_cells WHERE quote_id=$1 AND type='PREMIUM'`,
      [quoteId],
    );
    expect(premRows[0].n).toBeGreaterThan(0);
  });

  it('document not type=renewal_pack → 409 NOT_RENEWAL_PACK', async () => {
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId, docType: 'SLIP' });

    const res = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOT_RENEWAL_PACK');
  });

  it('treaty detail not saved → 409 TREATY_DETAIL_REQUIRED', async () => {
    const quoteId = await createQuoteWithoutTreatyDetail();
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId });

    const res = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('TREATY_DETAIL_REQUIRED');
  });

  it('proportional quote + NP-shaped pack → does NOT crash; extractor uses PROP prompt', async () => {
    cannedResponseRef.current = cannedNp; // LLM returns NP-shaped JSON
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId, fixtureName: 'NP_01.xlsx' });

    const postRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    expect(postRes.status).toBe(202);
    const { jobId } = await postRes.json();

    // The LLM JSON doesn't match the proportional schema (it's NP-shaped),
    // so extractor.js will warn and return null extraction → job FAILED.
    // The route's job is to surface that failure, NOT crash. Either
    // status='failed' (extraction empty) or status='done' with empty
    // filledPages is acceptable here — we just assert no crash.
    const result = await waitForJob(harness, quoteId, jobId);
    expect(['done', 'failed']).toContain(result.status);
    if (result.status === 'done') {
      // PROP gating means no NP pages should be filled even if LLM
      // hallucinated them.
      expect(result.filledPages).not.toContain('np_structure');
      expect(result.filledPages).not.toContain('egnpi_history');
    }
  });

  it('two concurrent imports on the same quote → second returns 409 IMPORT_IN_PROGRESS', async () => {
    cannedResponseRef.current = cannedProp;
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId });

    // Hold the LLM call so the first import stays in 'processing'.
    let release;
    pauseRef.current = new Promise((r) => { release = r; });

    const firstRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    expect(firstRes.status).toBe(202);
    const { jobId } = await firstRes.json();

    // Now the job is in 'processing' (waiting on the LLM). A second POST
    // should hit the unique partial index and 409.
    // setImmediate has had a tick to insert the row by the time the
    // first POST resolves; if it's still racing we'll see a 202 here
    // and fail clearly.
    let secondRes;
    // Small retry loop in case the first job hasn't inserted the
    // 'processing' row yet (rare with setImmediate but possible).
    for (let i = 0; i < 10; i++) {
      secondRes = await harness.fetchApp(
        'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
        { body: { documentId } },
      );
      if (secondRes.status === 409) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(secondRes.status).toBe(409);
    const body = await secondRes.json();
    expect(body.code).toBe('IMPORT_IN_PROGRESS');

    release(); // let the first job complete
    pauseRef.current = null;
    await waitForJob(harness, quoteId, jobId);
  });

  it('re-import overwrites previous values (and snapshots the prior state)', async () => {
    cannedResponseRef.current = cannedProp;
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId });

    // First import — fills premium_history etc.
    let res = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    let { jobId } = await res.json();
    const firstResult = await waitForJob(harness, quoteId, jobId);
    expect(firstResult.status).toBe('done');

    // Hand-edit a premium cell so we can see it get overwritten by the
    // re-import.
    await pool.query(
      `UPDATE public.quote_triangle_cells SET cum_value = 999999
        WHERE quote_id=$1 AND type='PREMIUM' AND origin_year=2025 AND dev_months=12`,
      [quoteId],
    );
    const { rows: beforeSecond } = await pool.query(
      `SELECT cum_value FROM public.quote_triangle_cells
        WHERE quote_id=$1 AND type='PREMIUM' AND origin_year=2025 AND dev_months=12`,
      [quoteId],
    );
    expect(Number(beforeSecond[0].cum_value)).toBe(999999);

    // Second import — overwrites.
    res = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    ({ jobId } = await res.json());
    const secondResult = await waitForJob(harness, quoteId, jobId);
    expect(secondResult.status).toBe('done');

    // Premium cell is back to the canned value, not 999999.
    const { rows: afterSecond } = await pool.query(
      `SELECT cum_value FROM public.quote_triangle_cells
        WHERE quote_id=$1 AND type='PREMIUM' AND origin_year=2025 AND dev_months=12`,
      [quoteId],
    );
    expect(Number(afterSecond[0].cum_value)).toBe(100);

    // Two snapshots, newest first.
    const listRes = await harness.fetchApp('GET', `/api/quotes/${quoteId}/import-snapshots`);
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(2);
    expect(new Date(list[0].capturedAt).getTime()).toBeGreaterThanOrEqual(new Date(list[1].capturedAt).getTime());

    // The newest snapshot captured the hand-edited 999999 value — that's
    // the state we'd restore back to.
    const { rows: snapPayload } = await pool.query(
      `SELECT payload FROM public.import_snapshots WHERE snapshot_id=$1`,
      [list[0].id],
    );
    const cells = snapPayload[0].payload.pages.premium_history.cells;
    const cell = cells.find((c) => c.origin_year === 2025 && c.dev_months === 12);
    expect(Number(cell.cum_value)).toBe(999999);
  });

  it('snapshot lifecycle: list → restore → second restore → 410; expired → 410', async () => {
    cannedResponseRef.current = cannedProp;
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId });

    // Pre-seed an existing cell so we can see the restore put it back.
    await pool.query(
      `INSERT INTO public.quote_triangle_cells (quote_id, type, origin_year, dev_months, cum_value)
       VALUES ($1, 'PREMIUM', 2024, 12, 42)`,
      [quoteId],
    );

    // Import → snapshot captures the (2024, 12, 42) row; writes the
    // canned (2025/2026) cells over the top.
    const postRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    const { jobId } = await postRes.json();
    const result = await waitForJob(harness, quoteId, jobId);
    expect(result.status).toBe('done');
    const snapshotId = result.restorePointId;

    // After import the (2024, 12, 42) row is gone — overwritten by the
    // import. (Triangle pages are full-delete-and-rewrite.)
    const { rows: postImportRows } = await pool.query(
      `SELECT origin_year, dev_months, cum_value FROM public.quote_triangle_cells
        WHERE quote_id=$1 AND type='PREMIUM' AND origin_year=2024 AND dev_months=12`,
      [quoteId],
    );
    expect(postImportRows).toHaveLength(0);

    // List shows the snapshot as restorable.
    const listRes1 = await harness.fetchApp('GET', `/api/quotes/${quoteId}/import-snapshots`);
    const list1 = await listRes1.json();
    expect(list1.find((s) => s.id === snapshotId).restorable).toBe(true);

    // Restore.
    const restoreRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-snapshots/${snapshotId}/restore`,
    );
    expect(restoreRes.status).toBe(200);

    // The (2024, 12, 42) cell is back; canned (2025) cells are gone.
    const { rows: restored2024 } = await pool.query(
      `SELECT cum_value FROM public.quote_triangle_cells
        WHERE quote_id=$1 AND type='PREMIUM' AND origin_year=2024 AND dev_months=12`,
      [quoteId],
    );
    expect(restored2024).toHaveLength(1);
    expect(Number(restored2024[0].cum_value)).toBe(42);
    const { rows: restored2025 } = await pool.query(
      `SELECT cum_value FROM public.quote_triangle_cells
        WHERE quote_id=$1 AND type='PREMIUM' AND origin_year=2025`,
      [quoteId],
    );
    expect(restored2025).toHaveLength(0);

    // Restore audit row exists.
    const { rows: restoreAudit } = await pool.query(
      `SELECT event_type, payload FROM public.audit_log
        WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type='import_restored'
        ORDER BY created_at DESC LIMIT 1`,
      [quoteId],
    );
    expect(restoreAudit).toHaveLength(1);
    expect(restoreAudit[0].payload.snapshotId).toBe(snapshotId);

    // Second restore → 410.
    const secondRestore = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-snapshots/${snapshotId}/restore`,
    );
    expect(secondRestore.status).toBe(410);
    const body2 = await secondRestore.json();
    expect(body2.code).toBe('SNAPSHOT_ALREADY_RESTORED');

    // List now shows it as not restorable.
    const listRes2 = await harness.fetchApp('GET', `/api/quotes/${quoteId}/import-snapshots`);
    const list2 = await listRes2.json();
    expect(list2.find((s) => s.id === snapshotId).restorable).toBe(false);

    // Expired-via-backdate test: set captured_at to 31 days ago on a
    // fresh snapshot so the restore endpoint returns 410 SNAPSHOT_EXPIRED.
    const quoteId2 = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId2);
    const { documentId: documentId2 } = await seedDocument({ quoteId: quoteId2 });
    const importRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId2}/import-renewal-pack`,
      { body: { documentId: documentId2 } },
    );
    const { jobId: jobId2 } = await importRes.json();
    const result2 = await waitForJob(harness, quoteId2, jobId2);
    const expiredId = result2.restorePointId;
    await pool.query(
      `UPDATE public.import_snapshots SET captured_at = now() - interval '31 days' WHERE snapshot_id=$1`,
      [expiredId],
    );
    const expiredRestore = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId2}/import-snapshots/${expiredId}/restore`,
    );
    expect(expiredRestore.status).toBe(410);
    const body3 = await expiredRestore.json();
    expect(body3.code).toBe('SNAPSHOT_EXPIRED');
  });

  it('snapshot only contains pages the import touched — skipped pages absent', async () => {
    // Use a canned response with NO large losses, NO CRESTA, only triangles.
    // The snapshot should only have triangle keys (premium_history /
    // claims_history_paid), not large_losses / cresta.
    cannedResponseRef.current = () => ({
      ...cannedProp(),
      largeLosses: [],
      catLosses: [],
      cresta: { countries: [] },
    });
    const quoteId = await createQuote({ treatyCategory: 'PROPORTIONAL' });
    createdQuoteIds.add(quoteId);
    const { documentId } = await seedDocument({ quoteId });

    const postRes = await harness.fetchApp(
      'POST', `/api/quotes/${quoteId}/import-renewal-pack`,
      { body: { documentId } },
    );
    const { jobId } = await postRes.json();
    const result = await waitForJob(harness, quoteId, jobId);
    expect(result.status).toBe('done');

    const { rows } = await pool.query(
      `SELECT payload FROM public.import_snapshots WHERE snapshot_id=$1`,
      [result.restorePointId],
    );
    const pages = rows[0].payload.pages;
    expect(Object.keys(pages).sort()).toEqual(['claims_history_paid', 'premium_history'].sort());
    expect(pages.large_losses).toBeUndefined();
    expect(pages.cresta).toBeUndefined();
  });
});
