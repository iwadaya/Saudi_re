// server/src/routes/aiMarket.js
//
// AI market-intelligence report endpoints (prompt 8.2).
//
//   POST /api/ai/market/generate-report
//   GET  /api/ai/market/latest-report
//
// The report is shared at (country, class_of_business, target_year).
// Anything under 30 days old is returned from cache; force_refresh
// bypasses that. Persisted only on a model response that passes the
// marketReportSchema — invalid responses produce a 502 with the raw
// body so the caller can see what came back.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { validateBody } from '../lib/validate.js';
import {
  marketReportRequestSchema,
  marketReportSchema,
} from '../validation/marketReport.js';

const router = Router();

const ANTHROPIC_API        = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL      = 'claude-sonnet-4-20250514';
const ANTHROPIC_VERSION    = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 4000;
const WEB_SEARCH_MAX_USES  = 8;
const CACHE_TTL_DAYS       = 30;

const SYSTEM_PROMPT = `You are a senior reinsurance market analyst with access to web search. Generate a market intelligence report for a reinsurance underwriter reviewing a treaty in a specific country and class of business. Use web search to find:
- The country's insurance regulator and recent regulatory actions in the last 24 months.
- The top 5-7 carriers in this country and class, with rating and market share where available.
- Market-wide loss ratio, commission norms, and retention norms for this class in this country (most recent year available).
- Recent large losses, natcat events, M&A, or rate changes affecting this market.
- Forward-looking trends: hardening/softening, capacity, climate exposure shifts, regulatory pipeline.

Respond ONLY with a single JSON object. No markdown. No backticks. No prose before or after the JSON. The JSON must match:

{
  executive_summary: string (<= 150 words),
  market_landscape: {
    regulator: string,
    regulator_recent_actions: string[],
    top_carriers: [{ name: string, market_share_pct?: number, am_best_rating?: string }],
    market_size_premium: { value: number, currency: string, year: number, source_idx: int },
    market_growth_pct: number | null,
    recent_context: string (<= 200 words)
  },
  market_benchmarks: {
    loss_ratio_market_avg: number | null,
    loss_ratio_year: int | null,
    commission_market_norm_pct: number | null,
    retention_market_norm_pct: number | null,
    roe_market_avg_pct: number | null,
    notes: string
  },
  trends: [{
    title: string,
    body: string (<= 150 words),
    severity: 'INFO' | 'WARNING' | 'OPPORTUNITY',
    source_idx?: int
  }],
  recommendations: [{
    title: string,
    body: string (<= 200 words),
    action_type: 'LINE_SIZE' | 'TERMS' | 'EXIT' | 'WATCH',
    confidence: number,
    source_idx?: int
  }],
  sources: [{
    idx: int,
    url: string,
    title: string,
    snippet: string (<= 200 chars)
  }]
}

Rules:
- Every numeric claim (loss ratio, commission, market share, growth) must reference a source_idx pointing into the sources array.
- If you cannot verify a number via web search, set it to null with a note in the surrounding text. Do NOT guess.
- Recommendations must be evidence-backed; cite the source_idx that supports each.
- The sources array must list every web page you actually used. Don't pad it with unread results.
- Numbers are bare (no commas, no symbols, no percent sign — those are formatting concerns for the UI).`;

function buildUserPrompt({ country, cob, target_year }) {
  const today = new Date().toISOString().slice(0, 10);
  return `Generate a market intelligence report for:
Country: ${country.name}
Class of business: ${cob.name}
Target underwriting year: ${target_year}
The current date is ${today}. Focus on recent data (last 24 months) and forward-looking views for the target_year.`;
}

function requireUser(req, res) {
  const uid = req.user?.userId;
  if (!uid) {
    res.status(401).json({ error: 'x-user-id header required' });
    return null;
  }
  return uid;
}

// Pull country name from the canonical lookup. Returns null if missing.
async function resolveCountry(countryId) {
  const { rows } = await pool.query(
    `SELECT country_id, country_name AS name, country_code AS code
       FROM public.country WHERE country_id=$1`,
    [countryId],
  );
  return rows[0] || null;
}

// Pull class-of-business name with the same introspection pattern as
// routes/lookups.js — the live DB has used either `class_of_business`
// or `class_name` as the display column historically.
async function resolveCob(cobId) {
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='class_of_business'
      ORDER BY ordinal_position`,
  );
  const cols = colRes.rows.map(r => r.column_name);
  const idCol   = cols.find(c => c === 'class_of_business_id') || cols.find(c => c === 'class_id') || cols[0];
  const nameCol = cols.find(c => c === 'class_of_business')    || cols.find(c => c === 'class_name') || cols[1] || cols[0];
  const { rows } = await pool.query(
    `SELECT ${idCol} AS class_of_business_id, ${nameCol} AS name
       FROM public.class_of_business WHERE ${idCol}=$1`,
    [cobId],
  );
  return rows[0] || null;
}

// Most-recent report for the (country, cob, year) triple if any.
async function findFreshReport({ countryId, cobId, targetYear, ttlDays }) {
  const { rows } = await pool.query(
    `SELECT * FROM public.market_intelligence_report
      WHERE country_id=$1
        AND class_of_business_id=$2
        AND target_year=$3
        AND generated_at > now() - ($4::int * INTERVAL '1 day')
      ORDER BY generated_at DESC
      LIMIT 1`,
    [countryId, cobId, targetYear, ttlDays],
  );
  return rows[0] || null;
}

async function callAnthropic({ system, userPrompt }) {
  if (!env.anthropicApiKey) {
    const err = new Error('ANTHROPIC_API_KEY not configured on server');
    err.statusCode = 503;
    throw err;
  }
  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES,
    }],
  };
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Anthropic API error ${resp.status}`;
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }
  return await resp.json();
}

// The model loops web_search → result → reasoning. The final answer
// lives in one or more `text` content blocks. Concatenate them, strip
// any accidental ``` fences or leading/trailing prose, and return the
// trimmed string. The system prompt asks for raw JSON but we tolerate
// minor deviation.
function extractJsonText(anthropicResponse) {
  const blocks = anthropicResponse?.content || [];
  let text = blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();
  if (!text) return '';
  // Strip ```json … ``` fences if the model wrapped the JSON anyway.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Trim any prose before the first `{` and after the last `}` so the
  // JSON parser sees only the object.
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < text.length - 1)) {
    if (first >= 0 && last > first) text = text.slice(first, last + 1).trim();
  }
  return text;
}

// POST /api/ai/market/generate-report
router.post(
  '/ai/market/generate-report',
  validateBody(marketReportRequestSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const {
      country_id: countryId,
      class_of_business_id: cobId,
      target_year: targetYear,
      force_refresh: forceRefresh,
    } = req.body;

    const [country, cob] = await Promise.all([resolveCountry(countryId), resolveCob(cobId)]);
    if (!country) return res.status(404).json({ error: 'country_id not found' });
    if (!cob)     return res.status(404).json({ error: 'class_of_business_id not found' });

    // Cache check
    if (!forceRefresh) {
      const fresh = await findFreshReport({
        countryId, cobId, targetYear, ttlDays: CACHE_TTL_DAYS,
      });
      if (fresh) {
        logger.info('[ai/market] cache hit', {
          report_id: fresh.report_id,
          generated_at: fresh.generated_at,
        });
        return res.json({ ...fresh, cached: true });
      }
    }

    // Build prompt + call Claude
    const userPrompt = buildUserPrompt({ country, cob, target_year: targetYear });
    const t0 = Date.now();
    let raw;
    try {
      raw = await callAnthropic({ system: SYSTEM_PROMPT, userPrompt });
    } catch (e) {
      logger.error('[ai/market] Anthropic call failed', {
        error: e?.message, statusCode: e?.statusCode,
      });
      return res.status(e.statusCode || 502).json({ error: e?.message || 'AI call failed' });
    }
    const durationMs = Date.now() - t0;

    // Parse + validate the model output
    const text = extractJsonText(raw);
    if (!text) {
      logger.warn('[ai/market] model returned no text content');
      return res.status(502).json({ error: 'Model returned no text', raw_response: raw });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.warn('[ai/market] model returned non-JSON');
      return res.status(502).json({ error: 'Model returned non-JSON', raw_response: raw });
    }
    const result = marketReportSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn('[ai/market] model output failed validation', { issues: result.error.issues });
      return res.status(502).json({
        error: 'Model output failed validation',
        issues: result.error.issues,
        raw_response: raw,
      });
    }

    // Persist + return
    const data = result.data;
    const { rows } = await pool.query(
      `INSERT INTO public.market_intelligence_report
         (country_id, class_of_business_id, target_year,
          executive_summary, market_landscape, market_benchmarks,
          trends, recommendations, sources,
          model, raw_response, generated_by_user_id, generation_duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        countryId, cobId, targetYear,
        data.executive_summary,
        JSON.stringify(data.market_landscape),
        JSON.stringify(data.market_benchmarks),
        JSON.stringify(data.trends),
        JSON.stringify(data.recommendations),
        JSON.stringify(data.sources),
        ANTHROPIC_MODEL, JSON.stringify(raw), userId, durationMs,
      ],
    );
    return res.status(201).json({ ...rows[0], cached: false });
  }),
);

// GET /api/ai/market/latest-report?country_id=&class_of_business_id=&target_year=
router.get(
  '/ai/market/latest-report',
  asyncHandler(async (req, res) => {
    const countryId = req.query.country_id;
    const cobId     = req.query.class_of_business_id;
    const yearRaw   = req.query.target_year;
    if (!countryId || !cobId || !yearRaw) {
      return res.status(400).json({
        error: 'country_id, class_of_business_id and target_year are required',
      });
    }
    const targetYear = Number(yearRaw);
    if (!Number.isInteger(targetYear)) {
      return res.status(400).json({ error: 'target_year must be an integer' });
    }
    const { rows } = await pool.query(
      `SELECT * FROM public.market_intelligence_report
        WHERE country_id=$1 AND class_of_business_id=$2 AND target_year=$3
        ORDER BY generated_at DESC LIMIT 1`,
      [countryId, cobId, targetYear],
    );
    if (!rows.length) return res.status(404).json({ error: 'No report yet for this combination.' });
    const ageMs = Date.now() - new Date(rows[0].generated_at).getTime();
    const stale = ageMs > CACHE_TTL_DAYS * 24 * 3600 * 1000;
    res.json({ ...rows[0], cached: true, stale });
  }),
);

export default router;
