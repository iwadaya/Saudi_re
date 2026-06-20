// server/src/observability/aiMetrics.js
//
// AI provider metrics: request count by outcome, call latency, token
// usage, and an estimated USD cost. These back the "AI provider
// failures / cost" dashboard.
//
// Same design as httpMetrics.js / poolMetrics.js: @opentelemetry/api is
// dynamic-imported only when OTel is enabled (enableAiMetrics is called
// from otelInit). Until then recordAiCall is a no-op, so the shared LLM
// client carries no OTel imports in the default module graph and there
// is zero behavioural change when OTel is off (the default, incl. CI).

// Approximate list prices in USD per 1,000,000 tokens. These are
// estimates for cost-trend dashboards, NOT billing-grade figures —
// update when a provider changes pricing or a new model is adopted.
// Token counts are always emitted precisely; only this derived cost
// depends on the table. Unknown models fall back to a zero cost so a
// missing entry can't silently inflate the metric.
const PRICE_PER_MTOK = {
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gpt-4o': { input: 2.5, output: 10 },
};

/**
 * Pull a normalized token-usage shape from a raw provider response.
 * Gemini reports `usageMetadata` (promptTokenCount/candidatesTokenCount);
 * the OpenAI Responses API reports `usage` (input_tokens/output_tokens).
 * Returns zeros when usage is absent so callers never have to null-check.
 */
export function extractUsage(provider, raw) {
  if (provider === 'gemini') {
    const u = raw?.usageMetadata || {};
    const input = Number(u.promptTokenCount) || 0;
    const output = Number(u.candidatesTokenCount) || 0;
    return { input, output, total: Number(u.totalTokenCount) || input + output };
  }
  if (provider === 'openai') {
    const u = raw?.usage || {};
    const input = Number(u.input_tokens) || 0;
    const output = Number(u.output_tokens) || 0;
    return { input, output, total: Number(u.total_tokens) || input + output };
  }
  return { input: 0, output: 0, total: 0 };
}

/** Estimated USD cost from a usage shape and the model price table. */
export function estimateCostUsd(model, usage) {
  const price = PRICE_PER_MTOK[model];
  if (!price || !usage) return 0;
  return (usage.input / 1e6) * price.input + (usage.output / 1e6) * price.output;
}

// Set by enableAiMetrics() once the SDK is up. While null, recordAiCall
// is a no-op.
let record = null;

/**
 * Record one provider attempt. `outcome` is 'success' or 'error'.
 * `raw` is the provider's parsed response (success only); usage/cost are
 * derived from it. Never throws — metrics must not affect an AI call.
 */
export function recordAiCall({ provider, model, outcome, durationMs, raw }) {
  if (!record) return;
  try {
    record({ provider, model, outcome, durationMs, raw });
  } catch {
    /* metrics must never break an AI call */
  }
}

let enabled = false;

/**
 * Create the instruments and start recording. Dynamic-imports
 * @opentelemetry/api so the dependency stays out of the default graph.
 * Idempotent.
 */
export async function enableAiMetrics() {
  if (enabled) return;
  const { metrics } = await import('@opentelemetry/api');
  const meter = metrics.getMeter('universe.ai.provider');

  const requests = meter.createCounter('ai.provider.requests', {
    description: 'AI provider attempts by provider, model and outcome (success|error)',
  });
  const duration = meter.createHistogram('ai.provider.request.duration', {
    description: 'AI provider call latency',
    unit: 's',
    advice: { explicitBucketBoundaries: [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60] },
  });
  const tokens = meter.createCounter('ai.provider.tokens', {
    description: 'AI tokens consumed by provider, model and token type (input|output)',
    unit: 'token',
  });
  const cost = meter.createCounter('ai.provider.cost.usd', {
    description: 'Estimated AI spend in USD (list-price approximation; see aiMetrics.js)',
    unit: 'USD',
  });

  record = ({ provider, model, outcome, durationMs, raw }) => {
    const base = { provider, model, outcome };
    requests.add(1, base);
    if (Number.isFinite(durationMs)) duration.record(durationMs / 1000, base);
    if (outcome !== 'success') return; // no usage on a failed attempt
    const usage = extractUsage(provider, raw);
    if (usage.input) tokens.add(usage.input, { provider, model, token_type: 'input' });
    if (usage.output) tokens.add(usage.output, { provider, model, token_type: 'output' });
    const usd = estimateCostUsd(model, usage);
    if (usd > 0) cost.add(usd, { provider, model });
  };
  enabled = true;
}
