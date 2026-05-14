// server/src/routes/aiMarket.test.js
//
// Unit tests for /api/ai/market/generate-report. Covers:
//   • cache miss → calls Anthropic, persists, returns cached:false
//   • cache hit  → skips Anthropic, returns cached:true
//   • force_refresh:true → bypasses cache even when a fresh row exists
//   • invalid model output → 502 with raw_response, no row persisted
//
// pg pool and global fetch are both stubbed; no real DB or network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// ── Test fixtures ────────────────────────────────────────────────
const USER_ID    = '00000000-0000-0000-0000-000000000001';
const COUNTRY_ID = '11111111-1111-1111-1111-111111111111';
const COB_ID     = '22222222-2222-2222-2222-222222222222';
const TARGET_YR  = 2026;

const VALID_MODEL_OUTPUT = {
  executive_summary: 'Strong market with hardening rates.',
  market_landscape: {
    regulator: 'CMA',
    regulator_recent_actions: ['New solvency rules in 2025'],
    top_carriers: [{ name: 'Carrier A', market_share_pct: 25, am_best_rating: 'A' }],
    market_size_premium: { value: 500000000, currency: 'USD', year: 2024, source_idx: 1 },
    market_growth_pct: 7.5,
    recent_context: 'Rates have hardened over the past year.',
  },
  market_benchmarks: {
    loss_ratio_market_avg: 0.62,
    loss_ratio_year: 2024,
    commission_market_norm_pct: 25,
    retention_market_norm_pct: 30,
    roe_market_avg_pct: 12,
    notes: 'Benchmarks from regulator filings.',
  },
  trends: [
    { title: 'Hardening', body: 'Rates up 5%.', severity: 'OPPORTUNITY', source_idx: 1 },
  ],
  recommendations: [
    { title: 'Hold line', body: 'Maintain current share.', action_type: 'WATCH', confidence: 0.7, source_idx: 1 },
  ],
  sources: [
    { idx: 1, url: 'https://example.com/report', title: 'Market Report', snippet: 'Snippet here.' },
  ],
};

function anthropicResponseWith(jsonText) {
  return {
    id: 'msg_test',
    model: 'claude-sonnet-4-20250514',
    content: [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'reinsurance' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
      { type: 'text', text: jsonText },
    ],
    stop_reason: 'end_turn',
  };
}

// ── pg pool stub ─────────────────────────────────────────────────
const queryLog = [];
let freshReportRow = null;     // returned for the cache check
let lastInsertedReport = null; // captured INSERT row

function fakePoolQuery(sql, params = []) {
  queryLog.push({ sql, params });

  if (/FROM public\.country WHERE country_id/.test(sql)) {
    return Promise.resolve({ rows: [{ country_id: params[0], name: 'Kenya', code: 'KE' }] });
  }
  if (/information_schema\.columns/.test(sql)) {
    return Promise.resolve({
      rows: [
        { column_name: 'class_of_business_id' },
        { column_name: 'class_of_business' },
      ],
    });
  }
  if (/FROM public\.class_of_business WHERE/.test(sql)) {
    return Promise.resolve({ rows: [{ class_of_business_id: params[0], name: 'Fire' }] });
  }
  if (/FROM public\.market_intelligence_report\s+WHERE country_id=\$1/.test(sql)
      && /generated_at > now/.test(sql)) {
    return Promise.resolve({ rows: freshReportRow ? [freshReportRow] : [] });
  }
  if (/FROM public\.market_intelligence_report\s+WHERE country_id=\$1 AND class_of_business_id/.test(sql)) {
    return Promise.resolve({ rows: freshReportRow ? [freshReportRow] : [] });
  }
  if (/INSERT INTO public\.market_intelligence_report/.test(sql)) {
    lastInsertedReport = {
      report_id: 'rep-123',
      country_id: params[0],
      class_of_business_id: params[1],
      target_year: params[2],
      executive_summary: params[3],
      market_landscape: JSON.parse(params[4]),
      market_benchmarks: JSON.parse(params[5]),
      trends: JSON.parse(params[6]),
      recommendations: JSON.parse(params[7]),
      sources: JSON.parse(params[8]),
      model: params[9],
      raw_response: JSON.parse(params[10]),
      generated_by_user_id: params[11],
      generation_duration_ms: params[12],
      generated_at: new Date().toISOString(),
    };
    return Promise.resolve({ rows: [lastInsertedReport] });
  }
  return Promise.resolve({ rows: [] });
}

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(fakePoolQuery) },
}));

vi.mock('../config/env.js', () => ({
  env: { anthropicApiKey: 'test-key' },
}));

const { default: aiMarketRouter } = await import('./aiMarket.js');
const { attachRequestContext }    = await import('../middleware/requestContext.js');

function buildApp() {
  const app = express();
  app.use(attachRequestContext);
  app.use('/api', aiMarketRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

// Lightweight request runner. body is attached directly to req.body
// so we don't have to wire up express.json() / stream the payload.
async function call(app, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      'x-user-id': USER_ID,
      'x-user-role': 'CU',
      ...headers,
    };
    const req = Object.assign(Object.create(express.request), {
      method,
      url: path,
      headers: reqHeaders,
      body: body ?? undefined,
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
    } catch (e) { reject(e); }
  });
}

// ── tests ────────────────────────────────────────────────────────
describe('/api/ai/market/generate-report', () => {
  let fetchSpy;

  beforeEach(() => {
    queryLog.length = 0;
    freshReportRow = null;
    lastInsertedReport = null;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => anthropicResponseWith(JSON.stringify(VALID_MODEL_OUTPUT)),
    });
  });

  afterEach(() => { fetchSpy.mockRestore(); });

  it('cache miss → calls Anthropic, persists, returns cached:false', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    expect(res.body.cached).toBe(false);
    expect(res.body.executive_summary).toMatch(/hardening/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lastInsertedReport).not.toBeNull();
    expect(lastInsertedReport.target_year).toBe(TARGET_YR);
    expect(lastInsertedReport.model).toBe('claude-sonnet-4-20250514');
  });

  it('cache hit (< 30 days) → returns cached row, does NOT call Anthropic', async () => {
    freshReportRow = {
      report_id: 'rep-cached',
      country_id: COUNTRY_ID,
      class_of_business_id: COB_ID,
      target_year: TARGET_YR,
      executive_summary: 'Cached summary',
      market_landscape: VALID_MODEL_OUTPUT.market_landscape,
      market_benchmarks: VALID_MODEL_OUTPUT.market_benchmarks,
      trends: VALID_MODEL_OUTPUT.trends,
      recommendations: VALID_MODEL_OUTPUT.recommendations,
      sources: VALID_MODEL_OUTPUT.sources,
      model: 'claude-sonnet-4-20250514',
      raw_response: {},
      generated_at: new Date().toISOString(),
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.report_id).toBe('rep-cached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('force_refresh:true bypasses cache and calls Anthropic', async () => {
    freshReportRow = {
      report_id: 'rep-cached',
      country_id: COUNTRY_ID,
      class_of_business_id: COB_ID,
      target_year: TARGET_YR,
      executive_summary: 'Cached summary',
      market_landscape: VALID_MODEL_OUTPUT.market_landscape,
      market_benchmarks: VALID_MODEL_OUTPUT.market_benchmarks,
      trends: VALID_MODEL_OUTPUT.trends,
      recommendations: VALID_MODEL_OUTPUT.recommendations,
      sources: VALID_MODEL_OUTPUT.sources,
      model: 'claude-sonnet-4-20250514',
      raw_response: {},
      generated_at: new Date().toISOString(),
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/market/generate-report',
      body: {
        country_id: COUNTRY_ID, class_of_business_id: COB_ID,
        target_year: TARGET_YR, force_refresh: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(lastInsertedReport).not.toBeNull();
  });

  it('invalid model output → 502, raw_response echoed, no row persisted', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => anthropicResponseWith(JSON.stringify({ not: 'a valid report' })),
    });
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/validation/i);
    expect(res.body.raw_response).toBeDefined();
    expect(lastInsertedReport).toBeNull();
  });

  it('missing x-user-id → 401', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/market/generate-report',
      headers: { 'x-user-id': '' },
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
