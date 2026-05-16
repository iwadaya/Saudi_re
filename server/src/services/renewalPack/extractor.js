// Renewal-pack LLM extractor.
//
// Takes the deterministic JSON produced by parser.js, hands it to the
// shared LLM client (Gemini → OpenAI fallback), validates the response
// against the matching Zod schema, and returns the structured
// extraction.
//
// Failure modes:
//   • LLM call throws → propagated. Callers decide whether to retry the
//     whole flow (the route would 502; a job runner would mark FAILED).
//   • Model returns non-JSON → caught, formatted, fed back as a retry
//     prompt once. If the retry also fails, we attach the partial JSON
//     (best-effort extracted from the raw text) and warn.
//   • Zod parse fails → retry once with the validation error appended.
//     On second failure we return the *partial* parsed object alongside
//     the error in warnings[]. Downstream UIs can render whatever
//     survived rather than dropping the whole pack on the floor.

import { callLlmJson, parseJsonOutput } from '../../lib/llmClient.js';
import { schemaForType } from '../../validation/renewalPack.js';
import {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  buildRetryUserPrompt,
} from './extractorPrompts.js';

const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_TEMPERATURE = 0;

/**
 * @param {object} parsedPack - parser.js output (must include `type`).
 * @param {object} [opts]
 * @param {Function} [opts.callLlm] - injected for tests. Defaults to callLlmJson.
 * @param {number} [opts.maxOutputTokens]
 * @returns {Promise<{
 *   type: string,
 *   extraction: object | null,
 *   provider: 'gemini'|'openai'|null,
 *   warnings: string[],
 *   raw: { firstAttempt: string|null, retryAttempt: string|null }
 * }>}
 */
export async function extractRenewalPack(parsedPack, opts = {}) {
  const { callLlm = callLlmJson, maxOutputTokens = DEFAULT_MAX_TOKENS } = opts;
  if (!parsedPack || typeof parsedPack !== 'object') {
    throw new Error('extractRenewalPack: parsedPack must be the parser.js output object');
  }
  const type = parsedPack.type;
  if (type !== 'proportional' && type !== 'non_proportional') {
    throw new Error(`extractRenewalPack: unsupported type "${type}"`);
  }
  const schema = schemaForType(type);
  const systemPrompt = buildExtractionSystemPrompt(type);
  const userPrompt = buildExtractionUserPrompt(parsedPack);

  const warnings = [...(parsedPack.warnings || [])];
  let provider = null;
  let firstAttempt = null;
  let retryAttempt = null;

  // ─── Attempt 1 ──────────────────────────────────────────────────────────
  let firstParsed;
  let firstZodError = null;
  try {
    const r = await callLlm({
      systemPrompt,
      userPrompt,
      maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
    });
    provider = r.provider;
    firstAttempt = r.text;
    firstParsed = safeJsonParse(r.text);
    if (firstParsed.error) {
      warnings.push(`LLM returned non-JSON on first attempt: ${firstParsed.error}`);
    } else {
      const v = schema.safeParse(firstParsed.value);
      if (v.success) {
        return { type, extraction: v.data, provider, warnings, raw: { firstAttempt, retryAttempt } };
      }
      firstZodError = formatZodError(v.error);
      warnings.push(`Schema validation failed on first attempt: ${firstZodError}`);
    }
  } catch (err) {
    // Hard provider failure — no point retrying with a "you got the
    // schema wrong" prompt. Surface immediately.
    throw new Error(`LLM call failed: ${err?.message || err}`);
  }

  // ─── Attempt 2 (retry with error) ───────────────────────────────────────
  const retryPrompt = buildRetryUserPrompt(
    parsedPack,
    firstAttempt,
    firstZodError || (firstParsed && firstParsed.error) || 'unknown parse error',
  );
  try {
    const r2 = await callLlm({
      systemPrompt,
      userPrompt: retryPrompt,
      maxOutputTokens,
      temperature: DEFAULT_TEMPERATURE,
    });
    provider = r2.provider;
    retryAttempt = r2.text;
    const retryParsed = safeJsonParse(r2.text);
    if (retryParsed.error) {
      warnings.push(`LLM returned non-JSON on retry: ${retryParsed.error}`);
      return {
        type,
        extraction: firstParsed?.value ?? null,
        provider,
        warnings,
        raw: { firstAttempt, retryAttempt },
      };
    }
    const v2 = schema.safeParse(retryParsed.value);
    if (v2.success) {
      return { type, extraction: v2.data, provider, warnings, raw: { firstAttempt, retryAttempt } };
    }
    warnings.push(`Schema validation failed on retry: ${formatZodError(v2.error)}`);
    // Best-effort: return whatever parsed JSON we got, even if it
    // doesn't fully satisfy the schema. Callers can render what's
    // valid and flag the rest.
    return {
      type,
      extraction: retryParsed.value ?? firstParsed?.value ?? null,
      provider,
      warnings,
      raw: { firstAttempt, retryAttempt },
    };
  } catch (err) {
    warnings.push(`LLM retry call failed: ${err?.message || err}`);
    return {
      type,
      extraction: firstParsed?.value ?? null,
      provider,
      warnings,
      raw: { firstAttempt, retryAttempt },
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function safeJsonParse(text) {
  try {
    return { value: parseJsonOutput(text), error: null };
  } catch (e) {
    return { value: null, error: e.message };
  }
}

function formatZodError(err) {
  if (!err || !Array.isArray(err.issues)) return String(err);
  return err.issues
    .slice(0, 12) // bound the prompt size; 12 issues is plenty to nudge a fix
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
