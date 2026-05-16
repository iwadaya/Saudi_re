// server/tests/integration/renewalPackImport.integration.test.js
//
// POSTs PROP_01 and NP_01 fixtures to /api/quotes/import-renewal-pack
// and asserts a draft quote is created with the expected shape on
// the import_metadata blob.
//
// Gated by TEST_WITH_DB=1. The LLM call is intercepted by injecting a
// fake into the extractor via global.fetch (we mock the network layer
// at the lowest level so we don't need to wire callLlm through the
// route just for tests).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../../test/fixtures/renewal-packs');

// ── shared leaf + canned LLM responses ───────────────────────────────────────

const lf = (value, confidence = 1, source = 'test:A1') => ({ value, confidence, source });

function cannedProp() {
  // Minimal but Zod-valid ProportionalExtraction response. The
  // parser ran for real; this stand-in is what the LLM would have
  // produced.
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
    largeLosses: [],
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

// Intercept LLM HTTP calls. The shared llmClient.callLlmJson tries
// Gemini first, so a single canned response into the first fetch is
// enough — the client never falls back when the first one succeeds.
function installLlmFetchInterceptor(getCannedJson) {
  const original = global.fetch;
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url || '');
    if (u.startsWith('https://generativelanguage.googleapis.com/')) {
      const text = JSON.stringify(getCannedJson());
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.openai.com/')) {
      // Fallback path; shouldn't be hit, but in case it is, return a valid response.
      const text = JSON.stringify(getCannedJson());
      return new Response(JSON.stringify({ output_text: text }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(url, init);
  });
  return () => { global.fetch = original; };
}

function buildFileFormData(absPath) {
  const buf = fs.readFileSync(absPath);
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const fd = new FormData();
  fd.append('file', blob, path.basename(absPath));
  return fd;
}

describe.skipIf(shouldSkipDb)('integration: POST /api/quotes/import-renewal-pack', () => {
  let harness;
  let restoreFetch;
  const createdQuoteIds = [];
  let cannedResponse = cannedProp;

  beforeAll(async () => {
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';
    harness = await bootApp();
    restoreFetch = installLlmFetchInterceptor(() => cannedResponse());
  });

  afterAll(async () => {
    restoreFetch?.();
    for (const id of createdQuoteIds) {
      try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {}
    }
    await harness.close();
    await closePools();
  });

  it('imports PROP_01 → creates a DRAFT quote with import_metadata + audit row', async () => {
    cannedResponse = cannedProp;
    const fd = buildFileFormData(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const res = await harness.fetchApp('POST', '/api/quotes/import-renewal-pack', { body: fd });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.quoteId).toBeTruthy();
    expect(body.type).toBe('proportional');
    expect(typeof body.fieldConfidence).toBe('object');
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(Array.isArray(body.unmatchedCresta)).toBe(true);
    createdQuoteIds.push(body.quoteId);

    // Quote row exists with status DRAFT + populated import_metadata
    const { rows } = await pool.query(
      `SELECT status, import_metadata, quote_ref FROM public.quote WHERE quote_id=$1`,
      [body.quoteId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('DRAFT');
    expect(rows[0].quote_ref).toMatch(/^QT-\d{4}-\d{4}$/);
    const meta = rows[0].import_metadata;
    expect(meta).toBeTruthy();
    expect(meta.source).toBe('renewal_pack_import');
    expect(meta.source_filename).toBe('PROP_01.xlsx');
    expect(meta.type).toBe('proportional');
    expect(typeof meta.field_confidence).toBe('object');
    expect(meta.wizard_state.header.cedant_name).toBe('Acme Insurance Co');

    // Audit row written.
    const { rows: auditRows } = await pool.query(
      `SELECT event_type, payload FROM public.audit_log
        WHERE entity_type='QUOTE' AND entity_id=$1
        ORDER BY created_at DESC LIMIT 1`,
      [body.quoteId],
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].event_type).toBe('renewal_pack_imported');
    expect(auditRows[0].payload.filename).toBe('PROP_01.xlsx');
  });

  it('imports NP_01 → creates a DRAFT quote with NP-shaped wizard_state', async () => {
    cannedResponse = cannedNp;
    const fd = buildFileFormData(path.join(FIXTURES_DIR, 'NP_01.xlsx'));
    const res = await harness.fetchApp('POST', '/api/quotes/import-renewal-pack', { body: fd });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('non_proportional');
    createdQuoteIds.push(body.quoteId);

    const { rows } = await pool.query(
      `SELECT import_metadata FROM public.quote WHERE quote_id=$1`,
      [body.quoteId],
    );
    const meta = rows[0].import_metadata;
    expect(meta.type).toBe('non_proportional');
    expect(meta.wizard_state.skipTriangleScreens).toBe(true);
    expect(meta.wizard_state.np_structure.layers).toHaveLength(1);
    expect(meta.wizard_state.egnpi_history).toHaveLength(2);
  });

  it('rejects requests with no file (400 MISSING_FILE)', async () => {
    const fd = new FormData();
    const res = await harness.fetchApp('POST', '/api/quotes/import-renewal-pack', { body: fd });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_FILE');
  });

  it('rejects non-.xlsx filenames (400 BAD_EXTENSION)', async () => {
    const fd = new FormData();
    const blob = new Blob([new Uint8Array([0])], { type: 'application/octet-stream' });
    fd.append('file', blob, 'notes.pdf');
    const res = await harness.fetchApp('POST', '/api/quotes/import-renewal-pack', { body: fd });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('BAD_EXTENSION');
  });

  it('rejects calls without x-user-role header (401)', async () => {
    const fd = buildFileFormData(path.join(FIXTURES_DIR, 'PROP_01.xlsx'));
    const res = await fetch(`${harness.baseUrl}/api/quotes/import-renewal-pack`, {
      method: 'POST',
      body: fd,
      // intentionally no x-user-role
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('UNAUTHORIZED');
  });
});
