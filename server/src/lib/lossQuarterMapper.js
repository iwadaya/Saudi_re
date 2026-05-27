// server/src/lib/lossQuarterMapper.js
// AI-assisted mapping of large/cat losses to the development quarter they
// most likely entered the triangle. Advisory only — it returns suggestions
// (a development period, a derived actuarial reported date, a confidence and
// a rationale) that the actuary reviews and applies; nothing is written here.
//
// The model is given, per loss: its date, amount, any existing reported date,
// and the observed cumulative row + period-over-period increments for its
// underwriting year. The strongest signal is matching the loss amount to the
// development column where the cumulative row jumped by roughly that amount.
// Reporting lag (a loss surfaces the quarter after it is reported) is the
// secondary signal when the jump is ambiguous.

import { callLlmJson, parseJsonOutput } from './llmClient.js';
import { logger } from './logger.js';

const SYSTEM_PROMPT = `You are an actuarial assistant helping place individual large/cat losses into a cumulative claims development triangle.

For each loss you are given:
- uw_year: the underwriting (origin) year.
- date_of_loss and (optional) reported_date.
- amount: the loss amount in the triangle's units.
- row: the observed development of that underwriting year as an array of
  { dev_months, cum, incr } where cum is the cumulative value and incr is the
  increase versus the previous development column.

Decide the development period (in months, matching one of the row's dev_months
values) at which the loss most likely first appears in the triangle. Rules:
1. Prefer the dev_months column whose incremental jump (incr) is closest to the
   loss amount — that is where the loss surfaced.
2. If no jump matches well, fall back to reporting lag: a loss surfaces about
   one quarter after it is reported (or after the loss date when no reported
   date is given).
3. Never choose a dev_months beyond the row's observed range.

Return ONLY a JSON object of the form:
{ "suggestions": [ { "loss_id": "...", "suggested_dev_months": <int>, "confidence": "high"|"medium"|"low", "rationale": "<one short sentence>" } ] }
Include one entry per input loss. Use the exact loss_id given.`;

// Group triangle cells into per-origin-year rows with cumulative values and
// the period-over-period increments used for jump matching.
export function buildRowsByYear(triangleCells) {
  const byYear = new Map();
  for (const c of Array.isArray(triangleCells) ? triangleCells : []) {
    const yr = Number(c.origin_year);
    if (!Number.isFinite(yr)) continue;
    if (!byYear.has(yr)) byYear.set(yr, []);
    byYear.get(yr).push({ dev_months: Number(c.dev_months), cum: Number(c.cum_value) || 0 });
  }
  const out = new Map();
  for (const [yr, cells] of byYear) {
    const sorted = [...cells].sort((a, b) => a.dev_months - b.dev_months);
    let prev = 0;
    out.set(yr, sorted.map((c) => {
      const incr = c.cum - prev;
      prev = c.cum;
      return { dev_months: c.dev_months, cum: c.cum, incr };
    }));
  }
  return out;
}

// Reproduce the reported date that would place a loss at `devMonths`:
// stripping enters a loss one quarter after its reported date, so
// reportedAge = devMonths - 3 months from the start of the uw year.
export function devMonthsToReportedDate(uwYear, devMonths) {
  const repAge = Math.max(0, Math.round(Number(devMonths)) - 3);
  return new Date(Date.UTC(Number(uwYear), repAge, 1)).toISOString().slice(0, 10);
}

const CONFIDENCE = new Set(['high', 'medium', 'low']);

export async function suggestLossQuarters({ losses, triangleCells, triangleType, llm = callLlmJson }) {
  const list = Array.isArray(losses) ? losses : [];
  if (!list.length) return { suggestions: [], provider: null };

  const rowsByYear = buildRowsByYear(triangleCells);
  const lossCtx = list.map((l) => {
    const yr = Number(l.uw_year);
    const row = rowsByYear.get(yr) || [];
    return {
      loss_id: String(l.loss_id),
      uw_year: yr,
      date_of_loss: l.date_of_loss || null,
      reported_date: l.actuarial_reported_date || null,
      amount: Number(l.incurred) || (Number(l.paid) || 0) + (Number(l.os) || 0),
      row,
    };
  });

  const userPrompt = JSON.stringify({ triangle_type: triangleType || 'INCURRED', losses: lossCtx });
  const { text, provider } = await llm({ systemPrompt: SYSTEM_PROMPT, userPrompt, maxOutputTokens: 4096 });

  let parsed;
  try {
    parsed = parseJsonOutput(text);
  } catch (e) {
    logger.error('[lossQuarterMapper] failed to parse LLM output', { error: e?.message });
    throw new Error('Could not parse AI response');
  }

  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const byId = new Map(lossCtx.map((l) => [l.loss_id, l]));
  const suggestions = [];
  for (const s of rawSuggestions) {
    const ctx = byId.get(String(s?.loss_id));
    if (!ctx) continue;
    const dev = Number(s?.suggested_dev_months);
    if (!Number.isFinite(dev)) continue;
    // Clamp into the row's observed range so a stray model value can't push
    // the loss outside the triangle.
    const devs = ctx.row.map((r) => r.dev_months);
    const minDev = devs.length ? Math.min(...devs) : dev;
    const maxDev = devs.length ? Math.max(...devs) : dev;
    const clamped = Math.min(Math.max(Math.round(dev), minDev), maxDev);
    suggestions.push({
      loss_id: ctx.loss_id,
      uw_year: ctx.uw_year,
      suggested_dev_months: clamped,
      suggested_reported_date: devMonthsToReportedDate(ctx.uw_year, clamped),
      confidence: CONFIDENCE.has(String(s?.confidence)) ? String(s.confidence) : 'low',
      rationale: typeof s?.rationale === 'string' ? s.rationale.slice(0, 300) : '',
    });
  }
  return { suggestions, provider };
}
