// Tests for the shared LLM client. Stub env BEFORE importing the module
// because callLlmJson reads env.geminiApiKey / env.openaiApiKey at the
// time of the call to decide which providers to try.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    geminiApiKey: 'gemini-test-key', openaiApiKey: 'sk-test', uploadDir: '/tmp',
    aiFeaturesEnabled: true, aiRedactionEnabled: true,
  },
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { callLlmJson, parseJsonOutput } = await import('./llmClient.js');

function fakeResp(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function geminiOk(text) {
  return fakeResp({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  });
}

function openAiOk(text) {
  return fakeResp({ output_text: text });
}

describe('callLlmJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Gemini result on success — does not call OpenAI', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(geminiOk('{"ok":1}'));
    const r = await callLlmJson({ systemPrompt: 'sys', userPrompt: 'do it', fetchFn });
    expect(r.provider).toBe('gemini');
    expect(r.text).toBe('{"ok":1}');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toMatch(/generativelanguage.googleapis.com/);
  });

  it('falls back to OpenAI when Gemini fails', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResp({ error: { message: 'boom' } }, false, 500))
      .mockResolvedValueOnce(openAiOk('{"ok":2}'));
    const r = await callLlmJson({ systemPrompt: 'sys', userPrompt: 'do it', fetchFn });
    expect(r.provider).toBe('openai');
    expect(r.text).toBe('{"ok":2}');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toBe('https://api.openai.com/v1/responses');
  });

  it('throws a combined error when both providers fail', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fakeResp({ error: { message: 'gemini-down' } }, false, 500))
      .mockResolvedValueOnce(fakeResp({ error: { message: 'openai-down' } }, false, 500));
    await expect(
      callLlmJson({ systemPrompt: 'sys', userPrompt: 'do it', fetchFn }),
    ).rejects.toThrow(/All LLM providers failed/);
  });

  it('detects Gemini MAX_TOKENS truncation and falls back', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResp({
          candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
        }),
      )
      .mockResolvedValueOnce(openAiOk('{"ok":3}'));
    const r = await callLlmJson({ systemPrompt: 'sys', userPrompt: 'do it', fetchFn });
    expect(r.provider).toBe('openai');
    expect(r.text).toBe('{"ok":3}');
  });

  it('uses the default 16384 maxOutputTokens on the Gemini request', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(geminiOk('{}'));
    await callLlmJson({ systemPrompt: 'sys', userPrompt: 'do it', fetchFn });
    const sent = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(sent.generationConfig.maxOutputTokens).toBe(16384);
    expect(sent.generationConfig.response_mime_type).toBe('application/json');
    expect(sent.generationConfig.temperature).toBe(0);
  });

  it('redacts PII from the user prompt BEFORE it leaves the app', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(geminiOk('{"ok":1}'));
    const r = await callLlmJson({
      systemPrompt: 'sys',
      userPrompt: 'contact jane.doe@example.com or +1 415 555 0100',
      fetchFn,
    });
    const sentBody = fetchFn.mock.calls[0][1].body;
    expect(sentBody).not.toContain('jane.doe@example.com');
    expect(sentBody).toContain('[REDACTED_EMAIL]');
    expect(r.redactionCount).toBeGreaterThanOrEqual(1);
  });

  it('honours forceProvider="openai"', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(openAiOk('{"ok":4}'));
    const r = await callLlmJson({
      systemPrompt: 'sys',
      userPrompt: 'do it',
      forceProvider: 'openai',
      fetchFn,
    });
    expect(r.provider).toBe('openai');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
  });
});

describe('parseJsonOutput', () => {
  it('parses raw JSON', () => {
    expect(parseJsonOutput('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(parseJsonOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips bare ``` fences', () => {
    expect(parseJsonOutput('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('throws on non-JSON', () => {
    expect(() => parseJsonOutput('not json {')).toThrow();
  });
});
