// Unit tests for the AI metrics helpers + the no-op recorder path.
// The recording path activates only under OTel (enableAiMetrics, needs a
// live SDK); here we cover usage extraction, cost estimation and the
// guarantee that recordAiCall is inert when metrics are disabled.
import { describe, expect, it } from 'vitest';
import { extractUsage, estimateCostUsd, recordAiCall } from './aiMetrics.js';

describe('extractUsage', () => {
  it('reads Gemini usageMetadata', () => {
    const raw = { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 } };
    expect(extractUsage('gemini', raw)).toEqual({ input: 100, output: 40, total: 140 });
  });

  it('derives Gemini total when omitted', () => {
    const raw = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
    expect(extractUsage('gemini', raw)).toEqual({ input: 10, output: 5, total: 15 });
  });

  it('reads OpenAI Responses usage', () => {
    const raw = { usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 } };
    expect(extractUsage('openai', raw)).toEqual({ input: 200, output: 80, total: 280 });
  });

  it('returns zeros for missing usage or unknown provider', () => {
    expect(extractUsage('gemini', {})).toEqual({ input: 0, output: 0, total: 0 });
    expect(extractUsage('openai', null)).toEqual({ input: 0, output: 0, total: 0 });
    expect(extractUsage('mystery', { usage: { input_tokens: 5 } })).toEqual({ input: 0, output: 0, total: 0 });
  });
});

describe('estimateCostUsd', () => {
  it('prices a known model from input + output tokens', () => {
    // gpt-4o: $2.50/Mtok input, $10/Mtok output.
    const cost = estimateCostUsd('gpt-4o', { input: 1_000_000, output: 1_000_000 });
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it('prices gemini-2.5-pro', () => {
    const cost = estimateCostUsd('gemini-2.5-pro', { input: 2_000_000, output: 0 });
    expect(cost).toBeCloseTo(2.5, 6);
  });

  it('returns 0 for an unknown model rather than guessing', () => {
    expect(estimateCostUsd('some-future-model', { input: 1_000_000, output: 1_000_000 })).toBe(0);
  });

  it('returns 0 for missing usage', () => {
    expect(estimateCostUsd('gpt-4o', null)).toBe(0);
  });
});

describe('recordAiCall (disabled / default)', () => {
  it('is inert and never throws when metrics are off', () => {
    expect(() => recordAiCall({ provider: 'gemini', model: 'gemini-2.5-pro', outcome: 'success', durationMs: 12, raw: {} })).not.toThrow();
    expect(() => recordAiCall({})).not.toThrow();
  });
});
