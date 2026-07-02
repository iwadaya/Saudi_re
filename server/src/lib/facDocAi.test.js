import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the pg pool BEFORE importing the module under test so the
// module's top-level `import { pool } from '../db/pool.js'` resolves
// to our fake. We use vi.mock() with a factory.
const poolMock = { query: vi.fn() };
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

// Stub the prompts module so we don't depend on its content here —
// we only care that the runner threads systemPrompt through to the
// openAi caller.
vi.mock('./facDocAiPrompts.js', () => ({
  buildFacSystemPrompt: () => 'STUB PROMPT',
  facAiResponseSchema: {
    parse(v) {
      // Mirror the real schema's required shape; rough but sufficient
      // for these tests.
      if (typeof v?.summary !== 'string') throw new Error('summary must be string');
      if (typeof v?.extracted !== 'object') throw new Error('extracted must be object');
      if (!Array.isArray(v?.recommendations)) throw new Error('recommendations must be array');
      return v;
    },
  },
}));

// Stub env so config/env.js doesn't try to read .env from disk.
vi.mock('../config/env.js', () => ({ env: { uploadDir: '/tmp/fac-doc-ai', openaiApiKey: 'sk-test' } }));
// Silence the logger.
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Now import the module under test (top-level imports above are
// already resolved through the mocks).
const { runFacDocumentAnalysis, parseFacAiResponse, sanitizeRecommendations, readDocumentBytes } = await import('./facDocAi.js');

beforeEach(() => {
  poolMock.query.mockReset();
});

function happyResponse() {
  return {
    summary: 'Looks like a Saudi Re slip for ACME Petrochemicals.',
    extracted: { cedant_name: 'Saudi Re', original_insured: 'ACME Petrochemicals' },
    recommendations: [
      {
        target_screen: 'FAC_PRICING',
        target_field:  'factor.CONSTRUCTION',
        suggested_value: 'Class A - RCC roof and Structure',
        rationale: 'Section 3.1 of the report.',
        confidence: 0.85,
      },
      {
        target_screen: 'FAC_PRICING',
        target_field:  'factor.UNKNOWN_FACTOR',  // should be filtered out
        suggested_value: 'whatever',
        rationale: 'hallucinated',
        confidence: 0.5,
      },
    ],
  };
}

function setupQueryStub({ insertedAnalysisId = '00000000-0000-0000-0000-000000000001', factorOptionExists = true } = {}) {
  poolMock.query.mockImplementation(async (sql) => {
    // Order in runFacDocumentAnalysis:
    //  1) INSERT fac_document_analysis (RUNNING) → returns analysis_id
    //  2) loadFacAiContextLists: 3 catalogue selects
    //  3) sanitizeRecommendations: SELECT fac_ai_extraction_field
    //     and for each FACTOR_OPTION rec, SELECT fac_factor_option
    //  4) lookupCurrentValue per surviving rec (factor.* → SELECT fac_underwriting_factors)
    //  5) UPDATE fac_document_analysis (SUCCEEDED)
    //  6) INSERT fac_ai_recommendation per rec
    if (/INSERT INTO public\.fac_document_analysis/.test(sql)) {
      return { rows: [{ analysis_id: insertedAnalysisId }] };
    }
    if (/FROM public\.fac_factor_option ORDER BY/.test(sql)) {
      return { rows: [
        { factor_code: 'CONSTRUCTION', option_label: 'Class A - RCC roof and Structure' },
      ] };
    }
    if (/FROM public\.fac_occupancy_master/.test(sql)) return { rows: [{ occupancy_name: 'Hospitals' }] };
    if (/FROM public\.fac_clause_master/.test(sql)) return { rows: [{ clause_code: 'LM7', clause_name: 'Wordings – LM7' }] };
    if (/FROM public\.fac_ai_extraction_field/.test(sql)) return { rows: [
      { field_code: 'factor.CONSTRUCTION', screen: 'FAC_PRICING', data_type: 'FACTOR_OPTION' },
      // factor.UNKNOWN_FACTOR is deliberately absent — sanitize should drop it
    ] };
    if (/FROM public\.fac_factor_option\s+WHERE factor_code = \$1/.test(sql)) {
      return { rowCount: factorOptionExists ? 1 : 0, rows: [] };
    }
    if (/SELECT selections->>\$2 AS v FROM public\.fac_underwriting_factors/.test(sql)) {
      return { rows: [] };
    }
    if (/UPDATE public\.fac_document_analysis/.test(sql)) return { rows: [], rowCount: 1 };
    if (/INSERT INTO public\.fac_ai_recommendation/.test(sql)) {
      return { rows: [{ recommendation_id: 'r-1', target_field: 'factor.CONSTRUCTION', status: 'PENDING' }] };
    }
    throw new Error('Unexpected SQL in test stub: ' + sql.slice(0, 80));
  });
}

describe('parseFacAiResponse', () => {
  it('strips markdown fences before parsing', () => {
    const fenced = '```json\n{"summary":"hi","extracted":{},"recommendations":[]}\n```';
    const out = parseFacAiResponse(fenced);
    expect(out.summary).toBe('hi');
  });

  it('throws on non-JSON', () => {
    expect(() => parseFacAiResponse('not json')).toThrow(/non-JSON/);
  });
});

describe('runFacDocumentAnalysis — happy path', () => {
  it('inserts RUNNING then SUCCEEDED, persists only valid recommendations', async () => {
    setupQueryStub();
    // Stub the bytes reader so we don't hit disk / network.
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
    }));
    try {
      const openAiCaller = vi.fn(async ({ systemPrompt }) => {
        expect(systemPrompt).toBe('STUB PROMPT');
        return { text: JSON.stringify(happyResponse()), raw: { id: 'resp_1' } };
      });

      const result = await runFacDocumentAnalysis({
        facRiskId: '11111111-1111-1111-1111-111111111111',
        document: { document_id: '22222222-2222-2222-2222-222222222222', storage_key: 'https://res.cloudinary.com/demo/raw/authenticated/v1/foo.pdf' },
        documentKind: 'SURVEY_REPORT',
        openAiCaller,
      });

      // Only the valid factor.CONSTRUCTION recommendation survives —
      // factor.UNKNOWN_FACTOR is silently dropped by sanitizeRecommendations.
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].target_field).toBe('factor.CONSTRUCTION');
      expect(result.analysisId).toBe('00000000-0000-0000-0000-000000000001');

      const sqls = poolMock.query.mock.calls.map((c) => c[0]);
      // First write must be RUNNING, last meaningful write must be SUCCEEDED.
      expect(sqls.some((s) => /INSERT INTO public\.fac_document_analysis/.test(s))).toBe(true);
      expect(sqls.some((s) => /UPDATE public\.fac_document_analysis\s+SET status='SUCCEEDED'/.test(s))).toBe(true);
      expect(sqls.some((s) => /INSERT INTO public\.fac_ai_recommendation/.test(s))).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('runFacDocumentAnalysis — OpenAI error', () => {
  it('marks the analysis FAILED and rethrows', async () => {
    setupQueryStub();
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => ({
      ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    try {
      const openAiCaller = vi.fn(async () => {
        const e = new Error('OpenAI 500 — internal');
        throw e;
      });
      await expect(runFacDocumentAnalysis({
        facRiskId: '11111111-1111-1111-1111-111111111111',
        document: { document_id: '22222222-2222-2222-2222-222222222222', storage_key: 'https://res.cloudinary.com/demo/raw/authenticated/v1/foo.pdf' },
        documentKind: 'SURVEY_REPORT',
        openAiCaller,
      })).rejects.toThrow(/OpenAI 500/);
      const sqls = poolMock.query.mock.calls.map((c) => c[0]);
      expect(sqls.some((s) => /UPDATE public\.fac_document_analysis\s+SET status='FAILED'/.test(s))).toBe(true);
      // Ensure no SUCCEEDED update was issued.
      expect(sqls.some((s) => /status='SUCCEEDED'/.test(s))).toBe(false);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('sanitizeRecommendations — drops invalid FACTOR_OPTION', () => {
  it('drops a FACTOR_OPTION value not in the master', async () => {
    setupQueryStub({ factorOptionExists: false });
    const recs = await sanitizeRecommendations([
      {
        target_screen: 'FAC_PRICING',
        target_field:  'factor.CONSTRUCTION',
        suggested_value: 'Class Z — Made up',
        rationale: 'hallucinated', confidence: 0.5,
      },
    ]);
    expect(recs).toHaveLength(0);
  });
});

describe('readDocumentBytes — SSRF hardening', () => {
  it('refuses to fetch a file_path URL (the SSRF vector)', async () => {
    await expect(readDocumentBytes({ file_path: 'http://169.254.169.254/latest/meta-data/' }))
      .rejects.toThrow(/refusing to fetch document from a file_path URL/);
  });

  it('refuses to fetch a non-Cloudinary storage_key URL', async () => {
    await expect(readDocumentBytes({ storage_key: 'http://localhost:6379/' }))
      .rejects.toThrow(/non-allowlisted remote asset URL/);
  });

  it('refuses an internal https host masquerading as a storage_key', async () => {
    await expect(readDocumentBytes({ storage_key: 'https://internal.metadata.example/secret' }))
      .rejects.toThrow(/non-allowlisted remote asset URL/);
  });
});
