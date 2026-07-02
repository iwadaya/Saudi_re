// server/src/routes/ai.test.js
//
// Unit tests for /api/ai/analyse-json — the JSON-mode completion route
// used by client-side wording analysis. Mocks the shared llmClient so
// we exercise validation + response shaping without touching real
// providers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Stub env BEFORE importing the route. The /ai/complete route inspects
// env.anthropicApiKey at request time, so keeping it null here means
// the parallel /ai/complete path returns 503 — fine for these tests
// which exercise /ai/analyse-json only.
const { envMock } = vi.hoisted(() => ({
  envMock: {
    anthropicApiKey: null,
    geminiApiKey: 'gemini-test-key',
    openaiApiKey: 'sk-test',
    uploadDir: '/tmp',
    // AI governance — enabled by default for these tests; flipped off to test the gate.
    aiFeaturesEnabled: true,
    aiRedactionEnabled: true,
    aiCustomerOptOut: false,
  },
}));
vi.mock('../config/env.js', () => ({ env: envMock }));

const llmJsonMock = vi.fn();
vi.mock('../lib/llmClient.js', () => ({
  callLlmJson: (...args) => llmJsonMock(...args),
}));

const { poolQueryMock } = vi.hoisted(() => ({ poolQueryMock: vi.fn(() => Promise.resolve({ rows: [] })) }));
vi.mock('../db/pool.js', () => ({ pool: { query: poolQueryMock } }));

vi.mock('../lib/facDocAi.js', () => ({
  runFacDocumentAnalysis: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { default: aiRouter } = await import('./ai.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', aiRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

async function call(app, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Object.create(express.request), {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      body: body || {},
    });
    const chunks = [];
    const res = Object.assign(Object.create(express.response), {
      app,
      statusCode: 200,
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
  llmJsonMock.mockReset();
  poolQueryMock.mockClear();
  envMock.aiFeaturesEnabled = true;
  envMock.aiCustomerOptOut = false;
});

describe('AI governance gate', () => {
  const AI_ENDPOINTS = [
    ['/api/ai/analyse-json', { systemPrompt: 'sys', userPrompt: 'user' }],
    ['/api/ai/slip-ingest', { base64: 'ZmFrZQ==', mode: 'PROP' }],
    ['/api/ai/complete', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/ai/fac/analyse-document', { fac_risk_id: 'r1', document_id: 'd1' }],
  ];

  it('when AI_FEATURES_ENABLED is off, every AI endpoint 403s and makes NO provider call', async () => {
    envMock.aiFeaturesEnabled = false;
    llmJsonMock.mockResolvedValue({ text: '{}', provider: 'gemini' });
    const app = buildApp();
    for (const [path, body] of AI_ENDPOINTS) {
      const res = await call(app, { method: 'POST', path, body });
      expect(res.status, `${path} should 403`).toBe(403);
      expect(res.body.code).toBe('AI_DISABLED');
    }
    expect(llmJsonMock).not.toHaveBeenCalled(); // gate blocks before any provider call
  });

  it('a tenant/customer opt-out also 403s the gate', async () => {
    envMock.aiCustomerOptOut = true;
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/api/ai/analyse-json', body: { systemPrompt: 's', userPrompt: 'u' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AI_OPTED_OUT');
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('with the gate open, a successful call writes an AI_CALL audit row', async () => {
    llmJsonMock.mockResolvedValueOnce({ text: '{"ok":1}', provider: 'gemini', redactionCount: 0 });
    const app = buildApp();
    const res = await call(app, { method: 'POST', path: '/api/ai/analyse-json', body: { systemPrompt: 's', userPrompt: 'u' } });
    expect(res.status).toBe(200);
    const auditCall = poolQueryMock.mock.calls.find(
      ([sql, params]) => /audit_log/.test(sql) && Array.isArray(params) && params.includes('AI_CALL'),
    );
    expect(auditCall, 'an AI_CALL audit row should be written').toBeTruthy();
  });
});

describe('POST /api/ai/complete PII redaction', () => {
  let fetchSpy;
  beforeEach(() => {
    // /ai/complete talks to Anthropic directly via global fetch — stub both.
    envMock.anthropicApiKey = 'sk-ant-test';
    fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'msg_1', content: [{ type: 'text', text: 'ok' }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    envMock.anthropicApiKey = null;
    vi.unstubAllGlobals();
  });

  it('redacts PII inside array-form content blocks AND the system field before the provider call', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {
        system: 'Contact underwriter at boss@example.com',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Insured email is john@example.com' },
              { type: 'text', text: 'no pii here' },
              { type: 'image', source: { data: 'AAAA' } },
            ],
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);

    // Array text blocks are redacted; non-text blocks pass through untouched.
    expect(sentBody.messages[0].content[0].text).toBe('Insured email is [REDACTED_EMAIL]');
    expect(sentBody.messages[0].content[1].text).toBe('no pii here');
    expect(sentBody.messages[0].content[2]).toEqual({ type: 'image', source: { data: 'AAAA' } });
    // The system field is redacted too.
    expect(sentBody.system).toBe('Contact underwriter at [REDACTED_EMAIL]');
    // Belt-and-braces: no raw PII anywhere in the outbound payload.
    const wire = JSON.stringify(sentBody);
    expect(wire).not.toContain('john@example.com');
    expect(wire).not.toContain('boss@example.com');
  });

  it('still redacts string-form content (regression on the original path)', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/complete',
      body: { messages: [{ role: 'user', content: 'reach me at a@b.com' }] },
    });
    expect(res.status).toBe(200);
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sentBody.messages[0].content).toBe('reach me at [REDACTED_EMAIL]');
  });
});

describe('POST /api/ai/analyse-json', () => {
  it('forwards system + user prompts to callLlmJson and returns { text, provider }', async () => {
    llmJsonMock.mockResolvedValueOnce({ text: '{"ok":1}', provider: 'gemini' });
    const app = buildApp();

    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { systemPrompt: 'sys', userPrompt: 'user' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: '{"ok":1}', provider: 'gemini' });
    expect(llmJsonMock).toHaveBeenCalledTimes(1);
    const callArg = llmJsonMock.mock.calls[0][0];
    expect(callArg.systemPrompt).toBe('sys');
    expect(callArg.userPrompt).toBe('user');
    // Default cap chosen to keep wording-analysis spend bounded.
    expect(callArg.maxOutputTokens).toBe(4096);
    expect(callArg.temperature).toBe(0);
  });

  it('passes through caller-provided maxOutputTokens and temperature', async () => {
    llmJsonMock.mockResolvedValueOnce({ text: '{}', provider: 'openai' });
    const app = buildApp();
    await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 8000, temperature: 0.5 },
    });
    const callArg = llmJsonMock.mock.calls[0][0];
    expect(callArg.maxOutputTokens).toBe(8000);
    expect(callArg.temperature).toBe(0.5);
  });

  it('returns 400 when systemPrompt is missing', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { userPrompt: 'user' },
    });
    expect(res.status).toBe(400);
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('returns 400 when userPrompt is missing', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { systemPrompt: 'sys' },
    });
    expect(res.status).toBe(400);
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('returns 400 when systemPrompt is an empty string', async () => {
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { systemPrompt: '', userPrompt: 'u' },
    });
    expect(res.status).toBe(400);
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('returns 502 with the underlying error message when callLlmJson throws', async () => {
    llmJsonMock.mockRejectedValueOnce(new Error('all providers down'));
    const app = buildApp();
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { systemPrompt: 'sys', userPrompt: 'user' },
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('all providers down');
  });

  it('rejects payloads that bust the size limits', async () => {
    const app = buildApp();
    const huge = 'a'.repeat(60_000);
    const res = await call(app, {
      method: 'POST',
      path: '/api/ai/analyse-json',
      body: { systemPrompt: 'sys', userPrompt: huge },
    });
    expect(res.status).toBe(400);
    expect(llmJsonMock).not.toHaveBeenCalled();
  });
});
