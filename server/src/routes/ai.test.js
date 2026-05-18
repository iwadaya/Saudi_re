// server/src/routes/ai.test.js
//
// Unit tests for /api/ai/analyse-json — the JSON-mode completion route
// used by client-side wording analysis. Mocks the shared llmClient so
// we exercise validation + response shaping without touching real
// providers.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

// Stub env BEFORE importing the route. The /ai/complete route inspects
// env.anthropicApiKey at request time, so keeping it null here means
// the parallel /ai/complete path returns 503 — fine for these tests
// which exercise /ai/analyse-json only.
vi.mock('../config/env.js', () => ({
  env: {
    anthropicApiKey: null,
    geminiApiKey: 'gemini-test-key',
    openaiApiKey: 'sk-test',
    uploadDir: '/tmp',
  },
}));

const llmJsonMock = vi.fn();
vi.mock('../lib/llmClient.js', () => ({
  callLlmJson: (...args) => llmJsonMock(...args),
}));

vi.mock('../db/pool.js', () => ({
  pool: { query: vi.fn(() => Promise.resolve({ rows: [] })) },
}));

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
