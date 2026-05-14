// server/src/routes/aiMarket.test.js
//
// Unit tests for /api/ai/market/* (prompts 8.2 / 8.3 / 8.4).
//
//   generate-report       — cache miss, cache hit, force_refresh,
//                           invalid output, missing user
//   treaty-benchmarks/:id — verdict bands, NO_DATA on missing fields,
//                           404 when no report exists
//   treaty-recommendations — generate, cache hit, force_refresh,
//                           server-side sanitization (LINE_SIZE clamp,
//                           TERMS dropped when empty), staging metadata
//   recommendation/:id/stage / reject — LINE_SIZE only, warning gate,
//                           TERMS returns 422, supersede prior STAGED
//
// pg pool (including pool.connect transactions) and global fetch are
// stubbed; no real DB or network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// ── Test fixtures ────────────────────────────────────────────────
const USER_ID     = '00000000-0000-0000-0000-000000000001';
const COUNTRY_ID  = '11111111-1111-1111-1111-111111111111';
const COB_ID      = '22222222-2222-2222-2222-222222222222';
const CONTRACT_ID = '33333333-3333-3333-3333-333333333333';
const CEDANT_ID   = '44444444-4444-4444-4444-444444444444';
const REPORT_ID   = '55555555-5555-5555-5555-555555555555';
const TARGET_YR   = 2026;

const VALID_REPORT_OUTPUT = {
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
    loss_ratio_market_avg: 62,
    loss_ratio_year: 2024,
    commission_market_norm_pct: 25,
    retention_market_norm_pct: 30,
    roe_market_avg_pct: 12,
    notes: 'Benchmarks from regulator filings.',
  },
  trends: [{ title: 'Hardening', body: 'Rates up 5%.', severity: 'OPPORTUNITY', source_idx: 1 }],
  recommendations: [
    { title: 'Hold line', body: 'Maintain current share.', action_type: 'WATCH', confidence: 0.7, source_idx: 1 },
  ],
  sources: [
    { idx: 1, url: 'https://example.com/report', title: 'Market Report', snippet: 'Snippet here.' },
  ],
};

// Treaty-rec model output (no web_search call → tools omitted in payload)
const VALID_TREATY_RECS_OUTPUT = {
  recommendations: [
    {
      action_type: 'LINE_SIZE',
      title: 'Trim line',
      body: 'Margin below market by 2pts; trim 5pts.',
      recommended_line_pct: 0.18,
      rationale: 'Loss ratio elevated vs market.',
      confidence: 0.8,
    },
    {
      action_type: 'TERMS',
      title: 'Improve commission',
      body: 'Push for 1pt lower commission.',
      recommended_terms_changes: { commission_pct: 24 },
      rationale: 'Market norm tighter.',
      confidence: 0.65,
    },
    {
      action_type: 'WATCH',
      title: 'Monitor regulator',
      body: 'New solvency rules pending.',
      rationale: 'Trend in report.',
      confidence: 0.5,
    },
  ],
};

// Minimal OpenAI Responses-API shape. Real responses include extra
// fields (usage, finish_reason, etc.) we don't read. The route prefers
// `output_text` when present so we set that for the happy path; the
// walk-the-output-array fallback is exercised by walking when needed.
function openaiResponseWith(jsonText) {
  return {
    id: 'resp_test',
    model: 'gpt-4o',
    output_text: jsonText,
    output: [
      { role: 'assistant', content: [{ type: 'output_text', text: jsonText }] },
    ],
  };
}

// ── pg pool stub ─────────────────────────────────────────────────
//
// Tests mutate the `state` object to control individual branches —
// freshReportRow (cache hit), reportById (resolve by id), treatyRow
// (loadTreatyMetrics result), existingRecs (treaty-rec cache),
// recById (single rec read for stage/reject), priorStaging (prior
// STAGED rows to supersede).
//
// inserts captures every INSERT for post-call assertions.
const state = {
  freshReportRow: null,
  reportById:     null,
  treatyRow:      null,
  existingRecs:   [],
  recById:        null,
  priorStaging:   [],
  insertedReport: null,
  insertedRecs:   [],
  insertedStaging: null,
  updatedRecStatus: null,
  updatedMarketRecStatus: null,
  countryAxcoCode: null,   // set to e.g. 'SA' to exercise the Axco path
  cobAxcoCode:     null,
};

function fakePoolQuery(sql, params = []) {
  // ── country / cob lookups ──
  if (/FROM public\.country WHERE country_id/.test(sql)) {
    return Promise.resolve({ rows: [{
      country_id: params[0], name: 'Kenya', code: 'KE',
      axco_country_code: state.countryAxcoCode || null,
    }] });
  }
  if (/information_schema\.columns/.test(sql)) {
    return Promise.resolve({
      rows: [{ column_name: 'class_of_business_id' }, { column_name: 'class_of_business' }],
    });
  }
  if (/FROM public\.class_of_business WHERE/.test(sql)) {
    return Promise.resolve({ rows: [{
      class_of_business_id: params[0], name: 'Fire',
      axco_class_code: state.cobAxcoCode || null,
    }] });
  }

  // ── report cache check (with TTL) ──
  if (/FROM public\.market_intelligence_report\s+WHERE country_id=\$1[\s\S]*generated_at > now/.test(sql)) {
    return Promise.resolve({ rows: state.freshReportRow ? [state.freshReportRow] : [] });
  }
  // ── latest report (no TTL) ──
  if (/FROM public\.market_intelligence_report\s+WHERE country_id=\$1 AND class_of_business_id/.test(sql)) {
    return Promise.resolve({ rows: state.freshReportRow ? [state.freshReportRow] : [] });
  }
  // ── report by id ──
  if (/FROM public\.market_intelligence_report WHERE report_id/.test(sql)) {
    return Promise.resolve({ rows: state.reportById ? [state.reportById] : [] });
  }

  // ── report insert ──
  if (/INSERT INTO public\.market_intelligence_report/.test(sql)) {
    state.insertedReport = {
      report_id: 'rep-123', country_id: params[0], class_of_business_id: params[1],
      target_year: params[2], executive_summary: params[3],
      market_landscape: JSON.parse(params[4]), market_benchmarks: JSON.parse(params[5]),
      trends: JSON.parse(params[6]), recommendations: JSON.parse(params[7]),
      sources: JSON.parse(params[8]),
      model: params[9], raw_response: JSON.parse(params[10]),
      generated_by_user_id: params[11], generation_duration_ms: params[12],
      axco_snapshot: params[13] ? JSON.parse(params[13]) : null,
      generated_at: new Date().toISOString(),
    };
    return Promise.resolve({ rows: [state.insertedReport] });
  }

  // ── treaty metrics (loadTreatyMetrics) ──
  if (/FROM public\.contract c[\s\S]*contract_prop_details[\s\S]*WHERE c\.contract_id = \$1/.test(sql)
      || /SELECT[\s\S]*c\.contract_id[\s\S]*FROM public\.contract c[\s\S]*WHERE c\.contract_id = \$1/.test(sql)) {
    return Promise.resolve({ rows: state.treatyRow ? [state.treatyRow] : [] });
  }

  // ── treaty-rec cache check ──
  if (/FROM public\.market_intelligence_recommendation[\s\S]*WHERE contract_id=\$1 AND report_id=\$2/.test(sql)
      && /status <> 'SUPERSEDED'/.test(sql)) {
    return Promise.resolve({ rows: state.existingRecs });
  }
  // ── treaty-rec list (GET) ──
  if (/FROM public\.market_intelligence_recommendation[\s\S]*WHERE contract_id=\$1\s+AND status <> 'SUPERSEDED'/.test(sql)) {
    return Promise.resolve({ rows: state.existingRecs });
  }

  // ── supersede prior recs (UPDATE inside generate flow) ──
  if (/UPDATE public\.market_intelligence_recommendation[\s\S]*SET status='SUPERSEDED'/.test(sql)) {
    return Promise.resolve({ rows: [] });
  }

  // ── insert a new market rec ──
  if (/INSERT INTO public\.market_intelligence_recommendation/.test(sql)) {
    const row = {
      rec_id: `rec-${state.insertedRecs.length + 1}`,
      report_id: params[0], contract_id: params[1],
      action_type: params[2], recommended_line_pct: params[3],
      recommended_terms_changes: params[4] ? JSON.parse(params[4]) : null,
      rationale: params[5], confidence: params[6],
      compliance_warnings: params[7] ? JSON.parse(params[7]) : [],
      status: 'PENDING', acted_at: null, acted_by_user_id: null,
      created_at: new Date().toISOString(),
    };
    state.insertedRecs.push(row);
    return Promise.resolve({ rows: [row] });
  }

  // ── single rec lookup for stage/reject (JOIN contract) ──
  if (/FROM public\.market_intelligence_recommendation mr[\s\S]*JOIN public\.contract c[\s\S]*WHERE mr\.rec_id=\$1/.test(sql)) {
    return Promise.resolve({ rows: state.recById ? [state.recById] : [] });
  }

  // ── prior STAGED rows in cedant_portfolio_staging ──
  if (/FROM public\.cedant_portfolio_staging\s+WHERE cedant_id=\$1 AND contract_id=\$2 AND status='STAGED'/.test(sql)) {
    return Promise.resolve({ rows: state.priorStaging });
  }
  // ── supersede prior staging row ──
  if (/UPDATE public\.cedant_portfolio_staging[\s\S]*SET status='DISCARDED'/.test(sql)) {
    return Promise.resolve({ rows: [] });
  }
  // ── revert prior AI rec status when superseded ──
  if (/UPDATE public\.cedant_ai_recommendation[\s\S]*SET status='PENDING'/.test(sql)
      || /UPDATE public\.market_intelligence_recommendation[\s\S]*SET status='PENDING'/.test(sql)) {
    return Promise.resolve({ rows: [] });
  }
  // ── INSERT new staging row ──
  if (/INSERT INTO public\.cedant_portfolio_staging/.test(sql)) {
    state.insertedStaging = {
      staging_id: 'staging-1',
      cedant_id: params[0], contract_id: params[1], proposed_line_pct: params[2],
      source: 'AI_MARKET_RECOMMENDATION', source_market_rec_id: params[3],
      rationale: params[4],
      compliance_warnings: params[5] ? JSON.parse(params[5]) : [],
      warning_acknowledged_by_user_id: params[6],
      warning_acknowledged_at: params[7],
      created_by_user_id: params[8],
      status: 'STAGED', created_at: new Date().toISOString(),
    };
    return Promise.resolve({ rows: [state.insertedStaging] });
  }
  // ── mark this market rec STAGED ──
  if (/UPDATE public\.market_intelligence_recommendation[\s\S]*SET status='STAGED'/.test(sql)) {
    state.updatedMarketRecStatus = { rec_id: params[0], user_id: params[1], status: 'STAGED' };
    return Promise.resolve({ rows: [] });
  }
  // ── reject (UPDATE status='REJECTED') ──
  if (/UPDATE public\.market_intelligence_recommendation[\s\S]*SET status='REJECTED'/.test(sql)) {
    state.updatedMarketRecStatus = { rec_id: params[0], user_id: params[1], status: 'REJECTED' };
    return Promise.resolve({ rows: state.recById ? [{ ...state.recById, status: 'REJECTED' }] : [] });
  }

  return Promise.resolve({ rows: [] });
}

const fakeClient = { query: fakePoolQuery, release: () => {} };

vi.mock('../db/pool.js', () => ({
  pool: {
    query: vi.fn(fakePoolQuery),
    connect: vi.fn(async () => fakeClient),
  },
}));

vi.mock('../config/env.js', () => ({
  env: { openaiApiKey: 'test-key' },
}));

const logAuditMock = vi.fn(async () => undefined);
vi.mock('../services/audit.js', () => ({
  logAudit: logAuditMock,
}));

// Axco client is mocked so tests can deterministically choose whether
// a snapshot is "available". The real lib makes a network call; we
// just intercept fetchMarketSnapshot's return value.
const axcoFetchMock = vi.fn(async () => null);
vi.mock('../lib/axcoClient.js', () => ({
  fetchMarketSnapshot: axcoFetchMock,
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

async function call(app, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { 'x-user-id': USER_ID, 'x-user-role': 'CU', ...headers };
    const req = Object.assign(Object.create(express.request), {
      method, url: path, headers: reqHeaders, body: body ?? undefined,
    });
    const resHeaders = {};
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app, statusCode: 200,
      setHeader(k, v) { resHeaders[k] = v; return res; },
      getHeader(k) { return resHeaders[k]; },
      status(code) { res.statusCode = code; return res; },
      json(payload) { chunks.push(JSON.stringify(payload)); res.end(); },
      end() {
        resolve({
          status: res.statusCode, headers: resHeaders,
          body: chunks.length ? JSON.parse(chunks.join('')) : null,
        });
      },
    });
    res.req = req; req.res = res;
    try {
      app.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: res.statusCode, headers: resHeaders, body: null });
      });
    } catch (e) { reject(e); }
  });
}

// Convenience factories
const makeReportRow = (over = {}) => ({
  report_id: REPORT_ID,
  country_id: COUNTRY_ID,
  class_of_business_id: COB_ID,
  target_year: TARGET_YR,
  ...VALID_REPORT_OUTPUT,
  raw_response: {},
  model: 'gpt-4o',
  generated_at: new Date().toISOString(),
  ...over,
});

const makeTreatyRow = (over = {}) => ({
  contract_id: CONTRACT_ID,
  cedant_id: CEDANT_ID,
  country_id: COUNTRY_ID,
  primary_class_of_business_id: COB_ID,
  uw_year: TARGET_YR,
  signed_line_pct: 20.0,
  status: 'SIGNED',
  entity_type: 'PROP',
  prop_brokerage_pct: 26,
  prop_retention_pct: 35,
  np_brokerage_pct: null,
  prop_actuarial_margin: 0.12,
  weighted_modelled: null,
  total_earned_premium: null,
  triangle_loss_ratio_pct: 65.2,
  written_line_pct: null,
  ...over,
});

let fetchSpy;
function resetState() {
  state.freshReportRow = null;
  state.reportById     = null;
  state.treatyRow      = null;
  state.existingRecs   = [];
  state.recById        = null;
  state.priorStaging   = [];
  state.insertedReport = null;
  state.insertedRecs   = [];
  state.insertedStaging = null;
  state.updatedRecStatus = null;
  state.updatedMarketRecStatus = null;
  state.countryAxcoCode = null;
  state.cobAxcoCode = null;
}

beforeEach(() => {
  resetState();
  logAuditMock.mockClear();
  axcoFetchMock.mockClear();
  axcoFetchMock.mockResolvedValue(null);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => openaiResponseWith(JSON.stringify(VALID_REPORT_OUTPUT)),
  });
});

afterEach(() => { fetchSpy.mockRestore(); });

// ── 8.2 — generate-report ─────────────────────────────────────────
describe('POST /api/ai/market/generate-report', () => {
  it('cache miss → calls OpenAI, persists, returns cached:false', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    expect(res.body.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(state.insertedReport).not.toBeNull();
  });

  it('cache hit (< 30 days) → returns cached row, no OpenAI call', async () => {
    state.freshReportRow = makeReportRow();
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('force_refresh bypasses cache', async () => {
    state.freshReportRow = makeReportRow();
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR, force_refresh: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('invalid model output → 502 with raw_response, no persist', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => openaiResponseWith(JSON.stringify({ not: 'a valid report' })),
    });
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(502);
    expect(res.body.raw_response).toBeDefined();
    expect(state.insertedReport).toBeNull();
  });

  // Regression: gpt-4o sometimes starts source idx at 0. The Zod
  // schema used to enforce min(1) and produced a 502; the relaxed
  // rule accepts any non-negative integer.
  it('accepts 0-indexed sources and persists the report', async () => {
    const zeroIndexed = {
      ...VALID_REPORT_OUTPUT,
      market_landscape: {
        ...VALID_REPORT_OUTPUT.market_landscape,
        market_size_premium: { value: 500_000_000, currency: 'USD', year: 2024, source_idx: 0 },
      },
      trends: [{ title: 'Hardening', body: 'Rates up 5%.', severity: 'OPPORTUNITY', source_idx: 0 }],
      recommendations: [
        { title: 'Hold', body: 'Stay flat.', action_type: 'WATCH', confidence: 0.7, source_idx: 0 },
      ],
      sources: [
        { idx: 0, url: 'https://example.com/zero', title: 'Zero-Indexed Source', snippet: 'snippet' },
      ],
    };
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => openaiResponseWith(JSON.stringify(zeroIndexed)),
    });
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    expect(state.insertedReport).not.toBeNull();
    expect(state.insertedReport.sources[0].idx).toBe(0);
  });

  it('missing x-user-id → 401', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      headers: { 'x-user-id': '' },
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── 8.3 — treaty-benchmarks ───────────────────────────────────────
describe('GET /api/ai/market/treaty-benchmarks/:contract_id', () => {
  it('returns deltas + verdicts for a treaty with full data', async () => {
    state.treatyRow = makeTreatyRow();
    state.freshReportRow = makeReportRow();
    const app = buildApp();
    const res = await call(app, {
      method: 'GET', path: `/api/ai/market/treaty-benchmarks/${CONTRACT_ID}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.report_id).toBe(REPORT_ID);
    expect(res.body.treaty_metrics.loss_ratio_pct).toBeCloseTo(65.2, 1);
    expect(res.body.treaty_metrics.commission_pct).toBe(26);
    expect(res.body.treaty_metrics.retention_pct).toBe(35);
    expect(res.body.treaty_metrics.margin_pct).toBeCloseTo(12, 1);
    // Loss ratio: 65.2 vs 62 → delta +3.2, lower-is-better band ±2 → WORSE
    const lr = res.body.benchmarks_table.find(r => r.metric === 'Loss Ratio');
    expect(lr.verdict).toBe('WORSE');
    expect(lr.delta).toBeCloseTo(3.2, 1);
    // Commission: 26 vs 25 → delta +1, lower-is-better band ±1 → ON_PAR (boundary inclusive)
    const comm = res.body.benchmarks_table.find(r => r.metric === 'Commission');
    expect(comm.verdict).toBe('ON_PAR');
    expect(comm.delta).toBe(1);
    // Retention: 35 vs 30 → delta +5, higher-is-better band ±5 → ON_PAR (boundary inclusive)
    const ret = res.body.benchmarks_table.find(r => r.metric === 'Retention');
    expect(ret.verdict).toBe('ON_PAR');
    // Margin: treaty 12, market roe 12 → margin lookup via market_metrics
    // (market.margin_pct is null because the schema separates margin vs ROE),
    // so verdict is NO_DATA. This is by design — see marketMetricsFromReport.
    const mgn = res.body.benchmarks_table.find(r => r.metric === 'Margin');
    expect(mgn.verdict).toBe('NO_DATA');
  });

  it('treaty missing margin → NO_DATA on margin row, others populated', async () => {
    state.treatyRow = makeTreatyRow({ prop_actuarial_margin: null });
    state.freshReportRow = makeReportRow();
    const app = buildApp();
    const res = await call(app, {
      method: 'GET', path: `/api/ai/market/treaty-benchmarks/${CONTRACT_ID}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.treaty_metrics.margin_pct).toBeNull();
    const mgn = res.body.benchmarks_table.find(r => r.metric === 'Margin');
    expect(mgn.verdict).toBe('NO_DATA');
    const lr = res.body.benchmarks_table.find(r => r.metric === 'Loss Ratio');
    expect(lr.verdict).toBe('WORSE');
  });

  it('404 when no report exists for the treaty segment', async () => {
    state.treatyRow = makeTreatyRow();
    // freshReportRow null + no reportById → resolveReport returns null
    const app = buildApp();
    const res = await call(app, {
      method: 'GET', path: `/api/ai/market/treaty-benchmarks/${CONTRACT_ID}`,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No market intelligence report/);
    expect(res.body.hint).toMatch(/generate-report/);
  });

  it('1pt over market commission → ON_PAR (band inclusive)', async () => {
    state.treatyRow = makeTreatyRow({ prop_brokerage_pct: 26 }); // market 25, +1pt
    state.freshReportRow = makeReportRow();
    const app = buildApp();
    const res = await call(app, {
      method: 'GET', path: `/api/ai/market/treaty-benchmarks/${CONTRACT_ID}`,
    });
    expect(res.status).toBe(200);
    const comm = res.body.benchmarks_table.find(r => r.metric === 'Commission');
    expect(comm.verdict).toBe('ON_PAR');
  });

  it('contract not found → 404', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'GET', path: `/api/ai/market/treaty-benchmarks/${CONTRACT_ID}`,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Contract not found/);
  });
});

// ── 8.4 — treaty-recommendations ──────────────────────────────────
describe('POST /api/ai/market/treaty-recommendations', () => {
  beforeEach(() => {
    // Default: treaty exists, report resolves by id.
    state.treatyRow = makeTreatyRow();
    state.reportById = makeReportRow();
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => openaiResponseWith(JSON.stringify(VALID_TREATY_RECS_OUTPUT)),
    });
  });

  it('generates and persists per-treaty recs with staging metadata', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID },
    });
    expect(res.status).toBe(201);
    expect(res.body.cached).toBe(false);
    expect(res.body.recommendations).toHaveLength(3);
    const ls = res.body.recommendations.find(r => r.action_type === 'LINE_SIZE');
    expect(ls.recommended_line_pct).toBeGreaterThanOrEqual(0);
    expect(ls.recommended_line_pct).toBeLessThanOrEqual(1);
    expect(ls.staging_supported).toBe(true);
    expect(ls.staging_disabled_reason).toBeNull();
    const terms = res.body.recommendations.find(r => r.action_type === 'TERMS');
    expect(terms.staging_supported).toBe(false);
    expect(terms.staging_disabled_reason).toMatch(/Terms staging not yet implemented/);
    expect(state.insertedRecs).toHaveLength(3);
  });

  it('clamps LINE_SIZE recommended_line_pct outside [0,1] back into range', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => openaiResponseWith(JSON.stringify({
        recommendations: [{
          action_type: 'LINE_SIZE', title: 'High', body: 'b', recommended_line_pct: 1.7,
          rationale: 'r', confidence: 0.6,
        }],
      })),
    });
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID },
    });
    expect(res.status).toBe(201);
    expect(state.insertedRecs[0].recommended_line_pct).toBe(1);
  });

  it('drops TERMS rec with no usable term changes', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => openaiResponseWith(JSON.stringify({
        recommendations: [
          { action_type: 'TERMS', title: 't', body: 'b',
            recommended_terms_changes: {}, rationale: 'r', confidence: 0.5 },
          { action_type: 'WATCH', title: 'w', body: 'b', rationale: 'r', confidence: 0.5 },
        ],
      })),
    });
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID },
    });
    expect(res.status).toBe(201);
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0].action_type).toBe('WATCH');
  });

  it('cache hit: existing non-superseded recs returned without OpenAI call', async () => {
    state.existingRecs = [{
      rec_id: 'rec-existing', report_id: REPORT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.2,
      recommended_terms_changes: null, rationale: 'cached', confidence: 0.7,
      compliance_warnings: [], status: 'PENDING',
      created_at: new Date().toISOString(),
    }];
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID },
    });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.recommendations).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('force_refresh bypasses cache and regenerates', async () => {
    state.existingRecs = [{
      rec_id: 'rec-existing', report_id: REPORT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.2,
      recommended_terms_changes: null, rationale: 'cached', confidence: 0.7,
      compliance_warnings: [], status: 'PENDING',
      created_at: new Date().toISOString(),
    }];
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID, force_refresh: true },
    });
    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('404 when contract not found', async () => {
    state.treatyRow = null;
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID },
    });
    expect(res.status).toBe(404);
  });

  it('404 when report not found', async () => {
    state.reportById = null;
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/treaty-recommendations',
      body: { contract_id: CONTRACT_ID, report_id: REPORT_ID },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/ai/market/treaty-recommendations/:contract_id', () => {
  it('returns all non-superseded recs with staging metadata', async () => {
    state.existingRecs = [
      { rec_id: 'a', action_type: 'LINE_SIZE', recommended_line_pct: 0.2, status: 'PENDING' },
      { rec_id: 'b', action_type: 'TERMS',     status: 'PENDING' },
    ];
    const app = buildApp();
    const res = await call(app, {
      method: 'GET', path: `/api/ai/market/treaty-recommendations/${CONTRACT_ID}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.recommendations).toHaveLength(2);
    expect(res.body.recommendations[0].staging_supported).toBe(true);
    expect(res.body.recommendations[1].staging_supported).toBe(false);
  });
});

// ── 8.4 — stage / reject ──────────────────────────────────────────
describe('POST /api/ai/market/recommendation/:rec_id/stage', () => {
  it('LINE_SIZE rec writes to cedant_portfolio_staging with correct source linkage', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'because', compliance_warnings: [], status: 'PENDING',
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: {},
    });
    expect(res.status).toBe(201);
    expect(state.insertedStaging).toMatchObject({
      contract_id: CONTRACT_ID, cedant_id: CEDANT_ID,
      proposed_line_pct: 0.18, source: 'AI_MARKET_RECOMMENDATION',
      source_market_rec_id: 'rec-1',
    });
    expect(state.updatedMarketRecStatus).toMatchObject({ rec_id: 'rec-1', status: 'STAGED' });
  });

  it('warnings present without acknowledgement → 422 with warnings echoed', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'because', compliance_warnings: ['Negative margin warning'],
      status: 'PENDING',
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: {},
    });
    expect(res.status).toBe(422);
    expect(res.body.compliance_warnings).toContain('Negative margin warning');
    expect(state.insertedStaging).toBeNull();
  });

  it('warnings present with warning_acknowledged:true → 201', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'because', compliance_warnings: ['Negative margin warning'],
      status: 'PENDING',
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: { warning_acknowledged: true },
    });
    expect(res.status).toBe(201);
    expect(state.insertedStaging.warning_acknowledged_by_user_id).toBe(USER_ID);
  });

  it('TERMS rec → 422 (not stageable through this endpoint)', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'TERMS', recommended_line_pct: null,
      recommended_terms_changes: { commission_pct: 24 },
      rationale: 'because', compliance_warnings: [], status: 'PENDING',
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: {},
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/TERMS recommendations are not stageable/);
    expect(state.insertedStaging).toBeNull();
  });

  it('rec already STAGED → 409', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'r', compliance_warnings: [], status: 'STAGED',
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: {},
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/ai/market/recommendation/:rec_id/reject', () => {
  it('rejects a PENDING rec without writing to staging', async () => {
    state.recById = {
      rec_id: 'rec-2', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'r', compliance_warnings: [], status: 'PENDING',
    };
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-2/reject',
      body: { reason: 'too aggressive' },
    });
    expect(res.status).toBe(200);
    expect(state.updatedMarketRecStatus).toMatchObject({ rec_id: 'rec-2', status: 'REJECTED' });
    expect(state.insertedStaging).toBeNull();
  });

  it('404 when rec missing', async () => {
    state.recById = null;
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-x/reject',
      body: {},
    });
    expect(res.status).toBe(404);
  });
});

// ── 8.7 — audit events ────────────────────────────────────────────
describe('8.7 audit + log-view', () => {
  it('first-time generate fires REPORT_GENERATED with country/cob/year/model/duration', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    const events = logAuditMock.mock.calls.map(c => c[1]);
    const generated = events.find(e => e.eventType === 'REPORT_GENERATED');
    expect(generated).toBeDefined();
    expect(generated.entityType).toBe('MARKET_INTELLIGENCE_REPORT');
    expect(generated.payload).toMatchObject({
      country_id: COUNTRY_ID,
      class_of_business_id: COB_ID,
      target_year: TARGET_YR,
      model: 'gpt-4o',
    });
    expect(Number.isFinite(generated.payload.duration_ms)).toBe(true);
    expect(events.find(e => e.eventType === 'REPORT_REFRESHED')).toBeUndefined();
  });

  it('force_refresh fires REPORT_REFRESHED (with prior_generated_at) instead of REPORT_GENERATED', async () => {
    state.freshReportRow = makeReportRow({ generated_at: '2026-04-01T00:00:00.000Z' });
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR, force_refresh: true },
    });
    expect(res.status).toBe(201);
    const events = logAuditMock.mock.calls.map(c => c[1]);
    const refreshed = events.find(e => e.eventType === 'REPORT_REFRESHED');
    expect(refreshed).toBeDefined();
    expect(refreshed.payload.prior_generated_at).toBe('2026-04-01T00:00:00.000Z');
    expect(events.find(e => e.eventType === 'REPORT_GENERATED')).toBeUndefined();
  });

  it('cache hit fires no audit row', async () => {
    state.freshReportRow = makeReportRow();
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(200);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it('stage fires RECOMMENDATION_STAGED with action_type + warnings_acknowledged flag', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'r', compliance_warnings: [], status: 'PENDING',
    };
    const app = buildApp();
    await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: {},
    });
    const events = logAuditMock.mock.calls.map(c => c[1]);
    const staged = events.find(e => e.eventType === 'RECOMMENDATION_STAGED');
    expect(staged).toBeDefined();
    expect(staged.payload).toMatchObject({
      rec_id: 'rec-1', contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      warnings_acknowledged: false,
    });
  });

  it('stage with acknowledged warnings sets warnings_acknowledged:true', async () => {
    state.recById = {
      rec_id: 'rec-1', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'r', compliance_warnings: ['warn!'], status: 'PENDING',
    };
    const app = buildApp();
    await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-1/stage',
      body: { warning_acknowledged: true },
    });
    const events = logAuditMock.mock.calls.map(c => c[1]);
    const staged = events.find(e => e.eventType === 'RECOMMENDATION_STAGED');
    expect(staged.payload.warnings_acknowledged).toBe(true);
  });

  it('reject fires RECOMMENDATION_REJECTED with reason (or null)', async () => {
    state.recById = {
      rec_id: 'rec-2', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'r', compliance_warnings: [], status: 'PENDING',
    };
    const app = buildApp();
    await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-2/reject',
      body: { reason: 'too aggressive' },
    });
    const events = logAuditMock.mock.calls.map(c => c[1]);
    const rejected = events.find(e => e.eventType === 'RECOMMENDATION_REJECTED');
    expect(rejected).toBeDefined();
    expect(rejected.payload).toMatchObject({
      rec_id: 'rec-2', contract_id: CONTRACT_ID, reason: 'too aggressive',
    });
  });

  it('reject without reason still fires the audit row with reason:null', async () => {
    state.recById = {
      rec_id: 'rec-3', cedant_id: CEDANT_ID, contract_id: CONTRACT_ID,
      action_type: 'LINE_SIZE', recommended_line_pct: 0.18,
      rationale: 'r', compliance_warnings: [], status: 'PENDING',
    };
    const app = buildApp();
    await call(app, {
      method: 'POST', path: '/api/ai/market/recommendation/rec-3/reject',
      body: {},
    });
    const rejected = logAuditMock.mock.calls
      .map(c => c[1]).find(e => e.eventType === 'RECOMMENDATION_REJECTED');
    expect(rejected).toBeDefined();
    expect(rejected.payload.reason).toBeNull();
  });
});

describe('POST /api/ai/market/log-view', () => {
  it('writes a REPORT_VIEWED audit row and returns 204', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/log-view',
      body: { report_id: REPORT_ID, contract_id: CONTRACT_ID },
    });
    expect(res.status).toBe(204);
    const events = logAuditMock.mock.calls.map(c => c[1]);
    const viewed = events.find(e => e.eventType === 'REPORT_VIEWED');
    expect(viewed).toBeDefined();
    expect(viewed.entityType).toBe('MARKET_INTELLIGENCE_REPORT');
    expect(viewed.entityId).toBe(REPORT_ID);
    expect(viewed.payload).toMatchObject({
      report_id: REPORT_ID, contract_id: CONTRACT_ID,
    });
  });

  it('rejects bad UUIDs with 400', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/log-view',
      body: { report_id: 'not-a-uuid', contract_id: CONTRACT_ID },
    });
    expect(res.status).toBe(400);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it('401 when x-user-id missing', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/log-view',
      headers: { 'x-user-id': '' },
      body: { report_id: REPORT_ID, contract_id: CONTRACT_ID },
    });
    expect(res.status).toBe(401);
  });
});

// ── Axco enrichment ───────────────────────────────────────────────
describe('Axco enrichment', () => {
  const AXCO_SNAPSHOT = {
    source: 'AXCO',
    axco_country_code: 'SA',
    axco_class_code:   'PROP',
    regulator: { name: 'IA', recent_actions: ['Action 1'] },
    top_carriers: [{ name: 'Carrier A', market_share_pct: 22, am_best_rating: 'A' }],
    market_size_premium: { value: 783660000, currency: 'USD', year: 2024 },
    market_growth_pct: 7.5,
    benchmarks: { loss_ratio_pct: 62, commission_pct: 25, retention_pct: 30, roe_pct: 12, year: 2024 },
    fetched_at: new Date().toISOString(),
  };

  it('does not call Axco when country/cob have no axco_*_code', async () => {
    // state.countryAxcoCode + cobAxcoCode are null by default
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    expect(axcoFetchMock).not.toHaveBeenCalled();
    expect(state.insertedReport.axco_snapshot).toBeNull();
    const generated = logAuditMock.mock.calls.map(c => c[1]).find(e => e.eventType === 'REPORT_GENERATED');
    expect(generated.payload.axco_used).toBe(false);
  });

  it('persists axco_snapshot and audits axco_used:true when Axco returns data', async () => {
    state.countryAxcoCode = 'SA';
    state.cobAxcoCode = 'PROP';
    axcoFetchMock.mockResolvedValue(AXCO_SNAPSHOT);
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    expect(axcoFetchMock).toHaveBeenCalledWith({ countryCode: 'SA', cobCode: 'PROP' });
    expect(state.insertedReport.axco_snapshot).toMatchObject({
      source: 'AXCO',
      axco_country_code: 'SA',
      axco_class_code: 'PROP',
    });
    const generated = logAuditMock.mock.calls.map(c => c[1]).find(e => e.eventType === 'REPORT_GENERATED');
    expect(generated.payload.axco_used).toBe(true);
  });

  it('injects AXCO data into the user prompt when present', async () => {
    state.countryAxcoCode = 'SA';
    state.cobAxcoCode = 'PROP';
    axcoFetchMock.mockResolvedValue(AXCO_SNAPSHOT);
    const app = buildApp();
    await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    // The route serialised the OpenAI request body via fetch; pull it
    // back and assert the user prompt was enriched.
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const userMsg = sentBody.input.find(m => m.role === 'user');
    const userText = userMsg.content[0].text;
    expect(userText).toMatch(/AUTHORITATIVE AXCO DATA/);
    expect(userText).toMatch(/783660000/);
  });

  it('Axco fetch failure is non-fatal — report still generates without snapshot', async () => {
    state.countryAxcoCode = 'SA';
    state.cobAxcoCode = 'PROP';
    axcoFetchMock.mockRejectedValue(new Error('boom'));
    const app = buildApp();
    const res = await call(app, {
      method: 'POST', path: '/api/ai/market/generate-report',
      body: { country_id: COUNTRY_ID, class_of_business_id: COB_ID, target_year: TARGET_YR },
    });
    expect(res.status).toBe(201);
    expect(state.insertedReport.axco_snapshot).toBeNull();
    const generated = logAuditMock.mock.calls.map(c => c[1]).find(e => e.eventType === 'REPORT_GENERATED');
    expect(generated.payload.axco_used).toBe(false);
  });
});
