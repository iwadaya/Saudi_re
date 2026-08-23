// Shared LLM client with Gemini-first, OpenAI-fallback semantics for
// JSON-mode prompts. One call site (slip ingest, renewal-pack extraction,
// any future structured-extraction flow) plugs in via callLlmJson; both
// providers are tried in order so an outage at Gemini doesn't break the
// product.
//
// Why this lives here rather than inline in the route:
//   • The renewal-pack flow needs the same provider semantics as slip
//     ingest. Duplicating fetch + retry + provider selection would
//     diverge in subtle ways (timeouts, headers, error shape).
//   • Tests inject a fake `fetchFn` to assert per-provider behaviour
//     without hitting the real APIs.
//
// Defaults are tuned for renewal packs:
//   • maxOutputTokens defaults to 16_384 — the 1000 default that the
//     slip-ingest route used originally truncated long extractions
//     mid-JSON, producing parse errors. Each caller can override.
//   • temperature defaults to 0 — every consumer wants deterministic
//     structured output.
//   • responseMimeType: "application/json" so Gemini emits raw JSON.

import { env } from '../config/env.js';
import { logger } from './logger.js';
import { assertAiEnabled, redactForLlm } from './aiGovernance.js';
import { recordAiCall } from '../observability/aiMetrics.js';

const GEMINI_MODEL_DEFAULT = 'gemini-2.5-pro';
const OPENAI_MODEL_DEFAULT = 'gpt-4o';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_API = 'https://api.openai.com/v1/responses';

// Hard upper bound on a single provider request. Without it a hung provider
// pins the socket (and file descriptors) indefinitely and stalls graceful
// shutdown until the deploy's hard deadline force-exits. AbortSignal.timeout
// rejects the fetch with a TimeoutError, which the caller catches and falls
// through to the next provider. Override with LLM_TIMEOUT_MS.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000;

/**
 * Call an LLM in JSON mode, trying Gemini first then OpenAI.
 *
 * @param {object} params
 * @param {string} params.systemPrompt - Instructions to the model.
 * @param {string} [params.userPrompt] - User-turn text. Defaults to a thin nudge.
 * @param {Array<{type:'input_file', filename:string, mime:string, base64:string}>} [params.attachments]
 *        Optional file attachments. Only meaningful for slip ingest; the
 *        renewal-pack extractor passes the parsed JSON inline in
 *        userPrompt and omits attachments.
 * @param {number} [params.maxOutputTokens=16384]
 * @param {number} [params.temperature=0]
 * @param {string} [params.geminiModel]
 * @param {string} [params.openaiModel]
 * @param {'gemini'|'openai'|null} [params.forceProvider] - Useful for tests.
 * @param {typeof fetch} [params.fetchFn=fetch]
 * @returns {Promise<{text: string, provider: 'gemini'|'openai', raw: any}>}
 */
export async function callLlmJson(params) {
  const {
    systemPrompt,
    userPrompt = 'Return ONLY the JSON object.',
    attachments = [],
    maxOutputTokens = 16384,
    temperature = 0,
    geminiModel = GEMINI_MODEL_DEFAULT,
    openaiModel = OPENAI_MODEL_DEFAULT,
    forceProvider = null,
    fetchFn = fetch,
    governance = {},
  } = params;

  // Fail-closed AI gate — enforced here so EVERY caller of the shared client is
  // covered even if a route forgets the middleware. Throws 403 when AI is
  // disabled / unconfigured / opted-out, before any provider request.
  assertAiEnabled(governance);

  // Redact PII/identifiers from the user-turn text BEFORE it leaves the app.
  // (System prompt is app-authored; binary attachments bypass text redaction —
  // see aiGovernance.js.) redactionCount is surfaced so callers can audit it.
  const redaction = redactForLlm(userPrompt);
  const safeUserPrompt = redaction.text;

  const errors = [];
  const tryGemini = forceProvider !== 'openai' && !!env.geminiApiKey;
  const tryOpenAi = forceProvider !== 'gemini' && !!env.openaiApiKey;

  if (!tryGemini && !tryOpenAi) {
    throw new Error('No LLM provider configured: set GEMINI_API_KEY or OPENAI_API_KEY');
  }

  if (tryGemini) {
    const startNs = process.hrtime.bigint();
    try {
      const out = await callGemini({
        systemPrompt, userPrompt: safeUserPrompt, attachments,
        maxOutputTokens, temperature, model: geminiModel, fetchFn,
      });
      recordAiCall({ provider: 'gemini', model: geminiModel, outcome: 'success', durationMs: msSince(startNs), raw: out.raw });
      logger.info('[llm] gemini succeeded', { model: geminiModel });
      return { ...out, redactionCount: redaction.redactionCount };
    } catch (err) {
      recordAiCall({ provider: 'gemini', model: geminiModel, outcome: 'error', durationMs: msSince(startNs), raw: null });
      const msg = err?.message || String(err);
      logger.warn('[llm] gemini failed, falling back to openai', { error: msg });
      errors.push(`gemini: ${msg}`);
    }
  }

  if (tryOpenAi) {
    const startNs = process.hrtime.bigint();
    try {
      const out = await callOpenAi({
        systemPrompt, userPrompt: safeUserPrompt, attachments,
        maxOutputTokens, temperature, model: openaiModel, fetchFn,
      });
      recordAiCall({ provider: 'openai', model: openaiModel, outcome: 'success', durationMs: msSince(startNs), raw: out.raw });
      logger.info('[llm] openai succeeded', { model: openaiModel });
      return { ...out, redactionCount: redaction.redactionCount };
    } catch (err) {
      recordAiCall({ provider: 'openai', model: openaiModel, outcome: 'error', durationMs: msSince(startNs), raw: null });
      const msg = err?.message || String(err);
      logger.error('[llm] openai failed', { error: msg });
      errors.push(`openai: ${msg}`);
    }
  }

  throw new Error(`All LLM providers failed: ${errors.join(' | ')}`);
}

// Elapsed wall-clock ms since a process.hrtime.bigint() mark.
function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

// ── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini({ systemPrompt, userPrompt, attachments, maxOutputTokens, temperature, model, fetchFn }) {
  if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY not configured');

  // Gemini's generateContent: system_instruction is separate; contents
  // is the user turn. Files go as inline_data parts with the same base64.
  const parts = [{ text: userPrompt }];
  for (const att of attachments) {
    parts.push({
      inline_data: { mime_type: att.mime || 'application/pdf', data: att.base64 },
    });
  }

  const payload = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      response_mime_type: 'application/json',
    },
  };

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.geminiApiKey)}`;
  const r = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `Gemini ${r.status}`);
  }
  const data = await r.json();
  const candidate = data?.candidates?.[0];
  // Surface the finishReason so callers can tell a truncation from a
  // legitimate empty response — the original 1000-token bug looked
  // exactly like "model returned nothing", but the cause was MAX_TOKENS.
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini: response truncated (MAX_TOKENS) — bump maxOutputTokens');
    }
  }
  const text = (candidate?.content?.parts || []).map((p) => p?.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return { text, provider: 'gemini', raw: data };
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function callOpenAi({ systemPrompt, userPrompt, attachments, maxOutputTokens, temperature, model, fetchFn }) {
  if (!env.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');

  const userContent = [{ type: 'input_text', text: userPrompt }];
  for (const att of attachments) {
    userContent.unshift({
      type: 'input_file',
      filename: att.filename || 'attachment',
      file_data: `data:${att.mime || 'application/pdf'};base64,${att.base64}`,
    });
  }

  const payload = {
    model,
    max_output_tokens: maxOutputTokens,
    temperature,
    // The Responses API supports a JSON object output format that maps
    // closely to Gemini's response_mime_type behaviour.
    text: { format: { type: 'json_object' } },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
      { role: 'user', content: userContent },
    ],
  };

  const r = await fetchFn(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `OpenAI ${r.status}`);
  }
  const data = await r.json();
  let text = data?.output_text;
  if (!text) {
    const partsOut = [];
    for (const item of data?.output || []) {
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') partsOut.push(c.text);
      }
    }
    text = partsOut.join('');
  }
  if (!text) throw new Error('OpenAI returned no text');
  return { text, provider: 'openai', raw: data };
}

// Strip ```json fences and parse. Doesn't validate against any schema —
// callers do that with their own Zod definition.
export function parseJsonOutput(text) {
  let trimmed = String(text || '').trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }
  return JSON.parse(trimmed);
}
