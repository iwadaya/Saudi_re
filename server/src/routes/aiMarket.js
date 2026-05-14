// server/src/routes/aiMarket.js
//
// AI market-intelligence endpoints.
//
//   POST /api/ai/market/generate-report                       (prompt 8.2)
//   GET  /api/ai/market/latest-report                         (prompt 8.2)
//   GET  /api/ai/market/treaty-benchmarks/:contract_id        (prompt 8.3)
//   POST /api/ai/market/treaty-recommendations                (prompt 8.4)
//   GET  /api/ai/market/treaty-recommendations/:contract_id   (prompt 8.4)
//   POST /api/ai/market/recommendation/:rec_id/stage          (prompt 8.4)
//   POST /api/ai/market/recommendation/:rec_id/reject         (prompt 8.4)
//
// The cached report (8.2) is shared at (country, class_of_business,
// target_year). 8.3 computes live per-treaty deltas against it. 8.4
// generates per-treaty recommendations referencing the report context
// and feeds the staging table that 7.5.b already drives.
//
// AI provider: OpenAI Responses API (gpt-4o). /generate-report uses
// the web_search_preview tool so the model can verify numbers against
// live sources; /treaty-recommendations passes withWebSearch=false
// since the report already supplies the context.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { validateBody } from '../lib/validate.js';
import { logAudit } from '../services/audit.js';
import { checkPortfolioCompliance } from '../lib/portfolioCompliance.js';
import {
  marketReportRequestSchema,
  marketReportSchema,
  marketReportLogViewSchema,
  treatyRecommendationsRequestSchema,
  treatyRecommendationsResponseSchema,
  marketRecStageSchema,
  marketRecRejectSchema,
} from '../validation/marketReport.js';

const router = Router();

const OPENAI_API           = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL         = 'gpt-4o';
const OPENAI_MAX_TOKENS    = 4000;
const TREATY_REC_MAX_TOKENS = 1500;
const CACHE_TTL_DAYS       = 30;

// Server-side defaults for portfolioCompliance when run on a single
// treaty rec (no per-cedant inputs available at this layer). Generous
// caps so the per-contract checks ("negative-margin increase",
// "large delta") still fire but COB-concentration stays silent —
// we don't have full portfolio context here.
const DEFAULT_MAX_LINE_SIZE_PCT      = 0.50;
const DEFAULT_MAX_COB_CONCENTRATION  = 0.50;

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

// OpenAI Responses API call. /generate-report uses the
// web_search_preview tool so the model can verify numbers against live
// sources; /treaty-recommendations passes withWebSearch=false because
// the report already provides the context. Same shape as the slip-
// ingest call in routes/ai.js (Bearer auth, /v1/responses, `input`
// array of role+content messages).
async function callOpenAI({ system, userPrompt, withWebSearch = true, maxTokens = OPENAI_MAX_TOKENS }) {
  if (!env.openaiApiKey) {
    const err = new Error('OPENAI_API_KEY not configured on server');
    err.statusCode = 503;
    throw err;
  }
  const payload = {
    model: OPENAI_MODEL,
    max_output_tokens: maxTokens,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user',   content: [{ type: 'input_text', text: userPrompt }] },
    ],
    ...(withWebSearch ? { tools: [{ type: 'web_search_preview' }] } : {}),
  };
  const resp = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    const msg = errBody?.error?.message || `OpenAI API error ${resp.status}`;
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }
  return await resp.json();
}

// Walks the OpenAI Responses output shape and returns the JSON body.
// Prefer the convenience `output_text` aggregator when present;
// otherwise concatenate every text block in `output[*].content[*]`.
// Strips ``` fences and prose around the first `{ … }` since the
// system prompt asks for raw JSON but we stay tolerant.
function extractJsonText(openaiResponse) {
  let text = openaiResponse?.output_text;
  if (!text) {
    const parts = [];
    for (const item of openaiResponse?.output || []) {
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
    text = parts.join('');
  }
  text = (text || '').trim();
  if (!text) return '';
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
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

    // Prior report lookup. On force_refresh this drives the
    // REPORT_REFRESHED audit event's prior_generated_at payload.
    // On first-time generation it stays null and we emit
    // REPORT_GENERATED instead below.
    let priorReport = null;
    if (forceRefresh) {
      const { rows: priorRows } = await pool.query(
        `SELECT report_id, generated_at FROM public.market_intelligence_report
          WHERE country_id=$1 AND class_of_business_id=$2 AND target_year=$3
          ORDER BY generated_at DESC LIMIT 1`,
        [countryId, cobId, targetYear],
      );
      priorReport = priorRows[0] || null;
    }

    // Build prompt + call Claude
    const userPrompt = buildUserPrompt({ country, cob, target_year: targetYear });
    const t0 = Date.now();
    let raw;
    try {
      raw = await callOpenAI({ system: SYSTEM_PROMPT, userPrompt });
    } catch (e) {
      logger.error('[ai/market] OpenAI call failed', {
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
        OPENAI_MODEL, JSON.stringify(raw), userId, durationMs,
      ],
    );

    // Audit: REPORT_REFRESHED when force_refresh replaced an earlier
    // report; REPORT_GENERATED for first-time creation. The two are
    // mutually exclusive so the audit trail tells a single coherent
    // story per call.
    if (priorReport) {
      await logAudit(null, {
        entityType: 'MARKET_INTELLIGENCE_REPORT',
        entityId:   rows[0].report_id,
        eventType:  'REPORT_REFRESHED',
        actor:      userId,
        payload: {
          report_id:           rows[0].report_id,
          prior_report_id:     priorReport.report_id,
          prior_generated_at:  priorReport.generated_at,
          country_id:          countryId,
          class_of_business_id: cobId,
          target_year:         targetYear,
          model:               OPENAI_MODEL,
          duration_ms:         durationMs,
        },
      });
    } else {
      await logAudit(null, {
        entityType: 'MARKET_INTELLIGENCE_REPORT',
        entityId:   rows[0].report_id,
        eventType:  'REPORT_GENERATED',
        actor:      userId,
        payload: {
          country_id:          countryId,
          class_of_business_id: cobId,
          target_year:         targetYear,
          model:               OPENAI_MODEL,
          duration_ms:         durationMs,
        },
      });
    }
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

// ──────────────────────────────────────────────────────────────────
// 8.3 — per-treaty benchmarks (live deltas vs the cached report)
// ──────────────────────────────────────────────────────────────────

// Triangle-derived loss ratio, mirrors cedant-summary in routes/lookups.js.
const LOSS_RATIO_FROM_TRIANGLE = `(
  SELECT
    CASE WHEN SUM(prem_val) > 0
      THEN ROUND((SUM(loss_val) / SUM(prem_val) * 100)::numeric, 2)
      ELSE NULL END
  FROM (
    SELECT
      p.origin_year,
      MAX(CASE WHEN p.type = 'PREMIUM' THEN p.cum_value ELSE 0 END) AS prem_val,
      MAX(CASE WHEN p.type IN ('CLAIMS_PAID','CLAIMS_OS') THEN p.cum_value ELSE 0 END) AS loss_val
    FROM public.contract_triangle_cells p
    WHERE p.contract_id = c.contract_id
      AND p.type IN ('PREMIUM','CLAIMS_PAID','CLAIMS_OS')
      AND p.dev_months = (
        SELECT MAX(p2.dev_months) FROM public.contract_triangle_cells p2
        WHERE p2.contract_id = p.contract_id AND p2.type = p.type AND p2.origin_year = p.origin_year
      )
    GROUP BY p.origin_year
  ) diag
)`;

// Pull the treaty's identity (country/cob/year/cedant/entity_type)
// and the live per-treaty metrics needed for benchmarking.
//
// Returns null if the contract id doesn't resolve.
async function loadTreatyMetrics(contractId) {
  const { rows } = await pool.query(`
    SELECT
      c.contract_id, c.cedant_id, c.country_id, c.primary_class_of_business_id,
      c.uw_year, c.signed_line_pct, c.status,
      CASE
        WHEN EXISTS (SELECT 1 FROM public.contract_prop_details WHERE contract_id = c.contract_id) THEN 'PROP'
        WHEN EXISTS (SELECT 1 FROM public.contract_np_details   WHERE contract_id = c.contract_id) THEN 'NP'
        ELSE NULL
      END AS entity_type,
      pd.brokerage_pct  AS prop_brokerage_pct,
      pd.retention_pct  AS prop_retention_pct,
      nd.brokerage_pct  AS np_brokerage_pct,
      po.actuarial_margin AS prop_actuarial_margin,
      nl.weighted_modelled, nl.total_earned_premium,
      ${LOSS_RATIO_FROM_TRIANGLE} AS triangle_loss_ratio_pct,
      co.written_line_pct
    FROM public.contract c
    LEFT JOIN public.contract_prop_details    pd ON pd.contract_id = c.contract_id
    LEFT JOIN public.contract_np_details      nd ON nd.contract_id = c.contract_id
    LEFT JOIN public.contract_pricing_outputs po ON po.contract_id = c.contract_id
    LEFT JOIN (
      SELECT contract_id,
             SUM(COALESCE(earned_premium, 0)) AS total_earned_premium,
             SUM(CASE WHEN modelled_margin IS NOT NULL AND earned_premium > 0
                      THEN earned_premium * modelled_margin ELSE NULL END) AS weighted_modelled
        FROM public.contract_np_layers GROUP BY contract_id
    ) nl ON nl.contract_id = c.contract_id
    LEFT JOIN (SELECT DISTINCT ON (contract_id) contract_id, written_line_pct
               FROM public.contract_offer ORDER BY contract_id, offer_id DESC) co
           ON co.contract_id = c.contract_id
    WHERE c.contract_id = $1
  `, [contractId]);
  const r = rows[0];
  if (!r) return null;

  // Margin as percent (actuarial_margin is a 0..1 fraction in the DB)
  let marginPct = null;
  if (r.entity_type === 'PROP' && r.prop_actuarial_margin != null) {
    marginPct = Number(r.prop_actuarial_margin) * 100;
  } else if (r.entity_type === 'NP'
             && r.weighted_modelled != null
             && Number(r.total_earned_premium) > 0) {
    marginPct = (Number(r.weighted_modelled) / Number(r.total_earned_premium)) * 100;
  }

  const commissionPct = r.entity_type === 'PROP'
    ? toNumOrNull(r.prop_brokerage_pct)
    : toNumOrNull(r.np_brokerage_pct);
  const retentionPct  = r.entity_type === 'PROP' ? toNumOrNull(r.prop_retention_pct) : null;
  const effectiveLine = r.signed_line_pct != null
    ? Number(r.signed_line_pct)
    : (r.written_line_pct != null ? Number(r.written_line_pct) : null);

  return {
    contract_id: r.contract_id,
    cedant_id: r.cedant_id,
    country_id: r.country_id,
    class_of_business_id: r.primary_class_of_business_id,
    uw_year: r.uw_year,
    status: r.status,
    entity_type: r.entity_type,
    current_line_pct_fraction: effectiveLine != null ? effectiveLine / 100 : null,
    treaty_metrics: {
      loss_ratio_pct: toNumOrNull(r.triangle_loss_ratio_pct),
      commission_pct: commissionPct,
      retention_pct:  retentionPct,
      margin_pct:     marginPct,
      // Per-treaty ROE isn't stored in this schema; surfaced as NO_DATA.
      roe_pct: null,
    },
  };
}

function toNumOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Resolve a report row either by explicit id or by falling back to
// the most recent report for the treaty's (country, cob, year). Returns
// null when no report exists yet.
async function resolveReport({ reportId, treaty }) {
  if (reportId) {
    const { rows } = await pool.query(
      `SELECT * FROM public.market_intelligence_report WHERE report_id=$1`,
      [reportId],
    );
    return rows[0] || null;
  }
  if (!treaty.country_id || !treaty.class_of_business_id || treaty.uw_year == null) {
    return null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM public.market_intelligence_report
      WHERE country_id=$1 AND class_of_business_id=$2 AND target_year=$3
      ORDER BY generated_at DESC LIMIT 1`,
    [treaty.country_id, treaty.class_of_business_id, treaty.uw_year],
  );
  return rows[0] || null;
}

// Verdict per benchmark row.
//   dir = 'lower'  → BETTER when treaty < market - band (lower-is-better)
//   dir = 'higher' → BETTER when treaty > market + band (higher-is-better)
// Band is inclusive on the ON_PAR side: |delta| <= band → ON_PAR.
function verdictFor(treaty, market, dir, band) {
  if (treaty == null || market == null) return 'NO_DATA';
  const delta = treaty - market;
  if (Math.abs(delta) <= band) return 'ON_PAR';
  if (dir === 'lower')  return delta < 0 ? 'BETTER' : 'WORSE';
  return delta > 0 ? 'BETTER' : 'WORSE';
}

function buildBenchmarksTable(treaty, market) {
  const rows = [
    { metric: 'Loss Ratio', dir: 'lower',  band: 2, treaty: treaty.loss_ratio_pct, market: market.loss_ratio_pct },
    { metric: 'Commission', dir: 'lower',  band: 1, treaty: treaty.commission_pct, market: market.commission_pct },
    { metric: 'Retention',  dir: 'higher', band: 5, treaty: treaty.retention_pct,  market: market.retention_pct  },
    { metric: 'Margin',     dir: 'higher', band: 2, treaty: treaty.margin_pct,     market: market.margin_pct     },
  ];
  return rows.map(r => {
    const delta = (r.treaty != null && r.market != null) ? r.treaty - r.market : null;
    return {
      metric: r.metric,
      treaty_value: r.treaty,
      market_value: r.market,
      delta,
      verdict: verdictFor(r.treaty, r.market, r.dir, r.band),
      unit: '%',
    };
  });
}

// Project a report's market_benchmarks JSON into the same percent-style
// shape used by the treaty side, so verdicts can be computed apples-to-
// apples. The 8.2 system prompt asks the model for bare numbers; some
// fields are clearly stored as percent (commission_market_norm_pct =
// 25), others might be returned as a fraction (loss_ratio_market_avg
// could be 0.62). If a value comes back as a fraction we multiply by
// 100 here so downstream verdicts and the UI both see percent.
function marketMetricsFromReport(report) {
  const mb = report?.market_benchmarks || {};
  const ml = report?.market_landscape  || {};
  function pctish(v) {
    const n = toNumOrNull(v);
    if (n == null) return null;
    return n > 0 && n <= 1 ? n * 100 : n;
  }
  return {
    loss_ratio_pct: pctish(mb.loss_ratio_market_avg),
    commission_pct: toNumOrNull(mb.commission_market_norm_pct),
    retention_pct:  toNumOrNull(mb.retention_market_norm_pct),
    margin_pct: mb.roe_market_avg_pct != null
      ? null  // margin not separately reported; we surface ROE in roe_pct
      : null,
    roe_pct: toNumOrNull(mb.roe_market_avg_pct),
    // Source landscape passthrough so the UI doesn't need a second call.
    market_growth_pct: toNumOrNull(ml.market_growth_pct),
  };
}

// GET /api/ai/market/treaty-benchmarks/:contract_id?report_id=...
router.get(
  '/ai/market/treaty-benchmarks/:contract_id',
  asyncHandler(async (req, res) => {
    const { contract_id: contractId } = req.params;
    const reportId = req.query.report_id || null;

    const treaty = await loadTreatyMetrics(contractId);
    if (!treaty) return res.status(404).json({ error: 'Contract not found' });

    const report = await resolveReport({ reportId, treaty });
    if (!report) {
      return res.status(404).json({
        error: 'No market intelligence report exists for this treaty yet.',
        hint: 'Call POST /api/ai/market/generate-report to create one.',
        country_id: treaty.country_id,
        class_of_business_id: treaty.class_of_business_id,
        target_year: treaty.uw_year,
      });
    }

    const market = marketMetricsFromReport(report);
    const benchmarks_table = buildBenchmarksTable(treaty.treaty_metrics, market);
    const deltas = {
      loss_ratio_pct_delta: deltaOrNull(treaty.treaty_metrics.loss_ratio_pct, market.loss_ratio_pct),
      commission_pct_delta: deltaOrNull(treaty.treaty_metrics.commission_pct, market.commission_pct),
      retention_pct_delta:  deltaOrNull(treaty.treaty_metrics.retention_pct,  market.retention_pct),
      margin_pct_delta:     deltaOrNull(treaty.treaty_metrics.margin_pct,     market.margin_pct),
    };

    res.json({
      report_id: report.report_id,
      report_generated_at: report.generated_at,
      treaty_metrics: treaty.treaty_metrics,
      market_metrics: market,
      deltas,
      benchmarks_table,
    });
  }),
);

function deltaOrNull(a, b) {
  if (a == null || b == null) return null;
  return a - b;
}

// ──────────────────────────────────────────────────────────────────
// 8.4 — per-treaty AI recommendations (Claude, no web_search)
// ──────────────────────────────────────────────────────────────────

const TREATY_REC_SYSTEM_PROMPT = `You are a reinsurance underwriter. Given a treaty's key metrics and a market intelligence report, generate 2-4 specific recommendations for this treaty. Respond ONLY with a JSON object:
{ recommendations: [{
    action_type: 'LINE_SIZE' | 'TERMS' | 'EXIT' | 'WATCH',
    title: string,
    body: string (<= 200 chars),
    recommended_line_pct?: number,    // 0..1, only for LINE_SIZE
    recommended_terms_changes?: {     // only for TERMS
      commission_pct?: number,
      brokerage_pct?: number,
      profit_commission_pct?: number
    },
    rationale: string (<= 300 chars),
    confidence: number (0..1)
  }]
}
Rules:
- Recommendations must reference specific deltas, trends, or market facts from the input.
- LINE_SIZE recommendations must specify recommended_line_pct.
- TERMS recommendations must include at least one term change.
- EXIT means 'consider non-renewal'; reserve for clearly bad cases.
- WATCH means 'no action now but monitor'; the body should name what to monitor.`;

// Metadata on each row in the API response so the UI knows which
// recommendations are wired to the staging flow yet. Only LINE_SIZE is
// — TERMS will get its own staging path later (see TODO below).
function withStagingMetadata(row) {
  const supported = row.action_type === 'LINE_SIZE';
  return {
    ...row,
    staging_supported: supported,
    staging_disabled_reason: supported
      ? null
      : (row.action_type === 'TERMS'
          ? 'Terms staging not yet implemented — accept manually on the relevant treaty screen.'
          : `${row.action_type} actions are not stageable.`),
  };
}

// POST /api/ai/market/treaty-recommendations
router.post(
  '/ai/market/treaty-recommendations',
  validateBody(treatyRecommendationsRequestSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { contract_id: contractId, report_id: reportId, force_refresh: forceRefresh } = req.body;

    const treaty = await loadTreatyMetrics(contractId);
    if (!treaty) return res.status(404).json({ error: 'Contract not found' });

    const report = await resolveReport({ reportId, treaty });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (String(report.report_id) !== String(reportId)) {
      // Defensive — request body specifies the explicit report_id.
      return res.status(400).json({ error: 'report_id does not resolve to a stored report' });
    }

    // Cache: existing non-superseded recs for this (contract, report)
    if (!forceRefresh) {
      const { rows: existing } = await pool.query(
        `SELECT * FROM public.market_intelligence_recommendation
          WHERE contract_id=$1 AND report_id=$2 AND status <> 'SUPERSEDED'
          ORDER BY created_at ASC`,
        [contractId, reportId],
      );
      if (existing.length) {
        return res.json({
          cached: true,
          recommendations: existing.map(withStagingMetadata),
        });
      }
    }

    const market = marketMetricsFromReport(report);
    const benchmarks_table = buildBenchmarksTable(treaty.treaty_metrics, market);
    const userPromptObj = {
      treaty: {
        contract_id: treaty.contract_id,
        entity_type: treaty.entity_type,
        uw_year: treaty.uw_year,
        current_line_pct: treaty.current_line_pct_fraction,
        metrics: treaty.treaty_metrics,
      },
      market_benchmarks: report.market_benchmarks,
      market_landscape:  report.market_landscape,
      trends:            report.trends,
      benchmarks_table,
    };

    let raw;
    try {
      raw = await callOpenAI({
        system: TREATY_REC_SYSTEM_PROMPT,
        userPrompt: JSON.stringify(userPromptObj),
        withWebSearch: false,
        maxTokens: TREATY_REC_MAX_TOKENS,
      });
    } catch (e) {
      logger.error('[ai/market] treaty-rec OpenAI call failed', { error: e?.message });
      return res.status(e.statusCode || 502).json({ error: e?.message || 'AI call failed' });
    }

    const text = extractJsonText(raw);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      return res.status(502).json({ error: 'Model returned non-JSON', raw_response: raw });
    }
    const parseResult = treatyRecommendationsResponseSchema.safeParse(parsed);
    if (!parseResult.success) {
      logger.warn('[ai/market] treaty-rec output failed validation', { issues: parseResult.error.issues });
      return res.status(502).json({
        error: 'Model output failed validation',
        issues: parseResult.error.issues,
        raw_response: raw,
      });
    }

    // Server-side sanitization: drop unknown action_types (already filtered
    // by Zod), clamp recommended_line_pct to [0,1], strip empty terms.
    const sanitized = parseResult.data.recommendations
      .filter(r => ['LINE_SIZE', 'TERMS', 'EXIT', 'WATCH'].includes(r.action_type))
      .map(r => {
        const out = { ...r };
        if (out.action_type === 'LINE_SIZE') {
          const p = Number(out.recommended_line_pct);
          if (!Number.isFinite(p)) return null;
          out.recommended_line_pct = Math.max(0, Math.min(1, p));
          out.recommended_terms_changes = null;
        } else if (out.action_type === 'TERMS') {
          out.recommended_line_pct = null;
          const t = out.recommended_terms_changes || {};
          const cleaned = {};
          for (const k of ['commission_pct', 'brokerage_pct', 'profit_commission_pct']) {
            const v = Number(t[k]);
            if (Number.isFinite(v)) cleaned[k] = v;
          }
          if (Object.keys(cleaned).length === 0) return null;
          out.recommended_terms_changes = cleaned;
        } else {
          out.recommended_line_pct = null;
          out.recommended_terms_changes = null;
        }
        return out;
      })
      .filter(Boolean);

    if (sanitized.length === 0) {
      return res.status(502).json({
        error: 'Model output yielded no usable recommendations after sanitization',
        raw_response: raw,
      });
    }

    // Portfolio-compliance checks for LINE_SIZE recs only. The full
    // portfolio context isn't available here (single-treaty scope), so
    // CoB concentration will silently no-op — the per-contract checks
    // (negative-margin increase, large delta) still fire.
    const treatyMarginFraction = treaty.treaty_metrics.margin_pct != null
      ? treaty.treaty_metrics.margin_pct / 100
      : 0;
    const contractsCtx = new Map([
      [String(contractId), {
        premium: 0, margin: treatyMarginFraction, cob: null,
      }],
    ]);
    const lineSizeRecs = sanitized.filter(r => r.action_type === 'LINE_SIZE');
    const compliance = new Map();
    for (const r of lineSizeRecs) {
      const warnings = checkPortfolioCompliance(treaty.cedant_id, {
        contract_id: contractId,
        current_line_pct: treaty.current_line_pct_fraction ?? 0,
        recommended_line_pct: r.recommended_line_pct,
      }, {
        contracts: contractsCtx,
        allRecommendations: lineSizeRecs.map(x => ({
          contract_id: contractId,
          recommended_line_pct: x.recommended_line_pct,
        })),
        maxLineSizePct: DEFAULT_MAX_LINE_SIZE_PCT,
        maxCobConcentrationPct: DEFAULT_MAX_COB_CONCENTRATION,
      });
      compliance.set(r, warnings);
    }

    // Persist: mark prior recs SUPERSEDED, then insert.
    const client = await pool.connect();
    let inserted;
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE public.market_intelligence_recommendation
            SET status='SUPERSEDED'
          WHERE contract_id=$1 AND report_id=$2 AND status <> 'SUPERSEDED'`,
        [contractId, reportId],
      );
      const insertedRows = [];
      for (const r of sanitized) {
        const warnings = compliance.get(r) || [];
        const ins = await client.query(
          `INSERT INTO public.market_intelligence_recommendation
             (report_id, contract_id, action_type,
              recommended_line_pct, recommended_terms_changes,
              rationale, confidence, compliance_warnings)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [
            reportId, contractId, r.action_type,
            r.recommended_line_pct,
            r.recommended_terms_changes ? JSON.stringify(r.recommended_terms_changes) : null,
            // Persist the model's narrative — body is the longer text;
            // rationale is the shorter justification. Combine so the
            // single `rationale` column on the row carries both.
            (r.title ? `${r.title}\n\n` : '') + (r.body || '') + (r.rationale ? `\n\nRationale: ${r.rationale}` : ''),
            r.confidence,
            JSON.stringify(warnings),
          ],
        );
        insertedRows.push({ ...ins.rows[0], title: r.title, body: r.body });
      }
      await client.query('COMMIT');
      inserted = insertedRows;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[ai/market] treaty-rec persistence failed', { error: e?.message });
      return res.status(500).json({ error: 'Failed to persist recommendations' });
    } finally {
      client.release();
    }

    res.status(201).json({
      cached: false,
      recommendations: inserted.map(withStagingMetadata),
    });
  }),
);

// GET /api/ai/market/treaty-recommendations/:contract_id
router.get(
  '/ai/market/treaty-recommendations/:contract_id',
  asyncHandler(async (req, res) => {
    const { contract_id: contractId } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM public.market_intelligence_recommendation
        WHERE contract_id=$1 AND status <> 'SUPERSEDED'
        ORDER BY created_at DESC`,
      [contractId],
    );
    res.json({ recommendations: rows.map(withStagingMetadata) });
  }),
);

// POST /api/ai/market/recommendation/:rec_id/stage
//
// Mirrors aiCedant.js's stage POST: supersede the prior STAGED row for
// (cedant, contract), insert a fresh STAGED row, mark the market rec
// as STAGED. Warning-acknowledgement gate matches phase 7.5.b.
//
// TERMS / EXIT / WATCH recs are not stageable through this path —
// terms-staging has its own future endpoint (see withStagingMetadata).
router.post(
  '/ai/market/recommendation/:rec_id/stage',
  validateBody(marketRecStageSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { rec_id: recId } = req.params;
    const { warning_acknowledged: warningAcknowledged } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: recRows } = await client.query(
        `SELECT mr.*, c.cedant_id
           FROM public.market_intelligence_recommendation mr
           JOIN public.contract c ON c.contract_id = mr.contract_id
          WHERE mr.rec_id=$1 FOR UPDATE`,
        [recId],
      );
      if (!recRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Recommendation not found.' });
      }
      const rec = recRows[0];

      // TODO(terms-staging): TERMS recs need a separate staging path that
      // writes proposed term changes (commission, brokerage, profit
      // commission) into a new staging table. EXIT/WATCH are advisory
      // only and never staged. For now, reject anything non-LINE_SIZE.
      if (rec.action_type !== 'LINE_SIZE') {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: `${rec.action_type} recommendations are not stageable through this endpoint.`,
          action_type: rec.action_type,
        });
      }
      if (rec.recommended_line_pct == null) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'recommended_line_pct missing on rec.' });
      }
      if (rec.status === 'STAGED') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Recommendation is already STAGED.' });
      }

      const warnings = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];
      if (warnings.length > 0 && warningAcknowledged !== true) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: 'Recommendation carries compliance warnings — acknowledge to stage.',
          compliance_warnings: warnings,
        });
      }

      // Supersede any existing STAGED row for (cedant, contract) — same
      // invariant as the cedant-portfolio path.
      const { rows: priorRows } = await client.query(
        `SELECT staging_id, source_rec_id, source_market_rec_id
           FROM public.cedant_portfolio_staging
          WHERE cedant_id=$1 AND contract_id=$2 AND status='STAGED'
          FOR UPDATE`,
        [rec.cedant_id, rec.contract_id],
      );
      for (const prior of priorRows) {
        await client.query(
          `UPDATE public.cedant_portfolio_staging
              SET status='DISCARDED', discarded_at=now()
            WHERE staging_id=$1`,
          [prior.staging_id],
        );
        // Revert any AI rec that was tied to the discarded staging row.
        if (prior.source_rec_id) {
          await client.query(
            `UPDATE public.cedant_ai_recommendation
                SET status='PENDING', acted_at=NULL, acted_by_user_id=NULL
              WHERE rec_id=$1 AND status='STAGED'`,
            [prior.source_rec_id],
          );
        }
        if (prior.source_market_rec_id) {
          await client.query(
            `UPDATE public.market_intelligence_recommendation
                SET status='PENDING', acted_at=NULL, acted_by_user_id=NULL
              WHERE rec_id=$1 AND status='STAGED'`,
            [prior.source_market_rec_id],
          );
        }
      }

      const ackedAt   = (warnings.length > 0 && warningAcknowledged === true) ? new Date() : null;
      const ackedById = ackedAt ? userId : null;
      const ins = await client.query(
        `INSERT INTO public.cedant_portfolio_staging
           (cedant_id, contract_id, proposed_line_pct, source, source_market_rec_id,
            rationale, compliance_warnings, warning_acknowledged_by_user_id,
            warning_acknowledged_at, created_by_user_id)
         VALUES ($1,$2,$3,'AI_MARKET_RECOMMENDATION',$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          rec.cedant_id, rec.contract_id, rec.recommended_line_pct, recId,
          rec.rationale,
          JSON.stringify(warnings), ackedById, ackedAt, userId,
        ],
      );

      await client.query(
        `UPDATE public.market_intelligence_recommendation
            SET status='STAGED', acted_at=now(), acted_by_user_id=$2
          WHERE rec_id=$1`,
        [recId, userId],
      );

      // Audit RECOMMENDATION_STAGED inside the same transaction so a
      // rollback drops the row, not leaves it as ghost trail.
      await logAudit(client, {
        entityType: 'MARKET_INTELLIGENCE_RECOMMENDATION',
        entityId:   recId,
        eventType:  'RECOMMENDATION_STAGED',
        actor:      userId,
        payload: {
          rec_id:                recId,
          contract_id:           rec.contract_id,
          action_type:           rec.action_type,
          recommended_line_pct:  rec.recommended_line_pct,
          warnings_acknowledged: warnings.length > 0 && warningAcknowledged === true,
          staging_id:            ins.rows[0]?.staging_id || null,
        },
      });

      await client.query('COMMIT');
      res.status(201).json({ staging: ins.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[ai/market] stage failed', { error: e?.message });
      return res.status(500).json({ error: 'Failed to stage recommendation' });
    } finally {
      client.release();
    }
  }),
);

// POST /api/ai/market/recommendation/:rec_id/reject
router.post(
  '/ai/market/recommendation/:rec_id/reject',
  validateBody(marketRecRejectSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { rec_id: recId } = req.params;
    const { reason } = req.body;

    const { rows } = await pool.query(
      `UPDATE public.market_intelligence_recommendation
          SET status='REJECTED', acted_at=now(), acted_by_user_id=$2
        WHERE rec_id=$1 AND status IN ('PENDING','STAGED')
        RETURNING *`,
      [recId, userId],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Recommendation not found or not in a rejectable state.' });
    }
    // RECOMMENDATION_REJECTED fires for every reject — reason is
    // optional payload, not a precondition for the audit row.
    await logAudit(null, {
      entityType: 'MARKET_INTELLIGENCE_RECOMMENDATION',
      entityId:   recId,
      eventType:  'RECOMMENDATION_REJECTED',
      actor:      userId,
      payload: {
        rec_id:      recId,
        contract_id: rows[0].contract_id,
        reason:      reason || null,
      },
    });
    res.json({ recommendation: rows[0] });
  }),
);

// POST /api/ai/market/log-view
//
// Records a REPORT_VIEWED audit row when the client opens the modal.
// The client debounces per (user, report_id, contract_id) per
// session — this endpoint trusts that debounce and writes whatever
// it receives. Both IDs are validated as UUIDs to keep junk out of
// the audit log.
router.post(
  '/ai/market/log-view',
  validateBody(marketReportLogViewSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { report_id: reportId, contract_id: contractId } = req.body;
    await logAudit(null, {
      entityType: 'MARKET_INTELLIGENCE_REPORT',
      entityId:   reportId,
      eventType:  'REPORT_VIEWED',
      actor:      userId,
      payload: { report_id: reportId, contract_id: contractId },
    });
    res.status(204).end();
  }),
);

export default router;
