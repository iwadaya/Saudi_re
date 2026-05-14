// server/src/validation/marketReport.js
//
// Zod schemas for /api/ai/market (prompt 8.2). Two shapes live here:
//
//   • marketReportRequestSchema  — inbound POST body
//   • marketReportSchema         — what Claude is required to return
//
// The model schema is permissive about nullable numerics because the
// system prompt explicitly allows nulls when a number cannot be
// verified by web search. Anything outside that contract produces a 502
// with raw_response echoed for debugging.

import { z } from 'zod';

// ── inbound request ───────────────────────────────────────────────
export const marketReportRequestSchema = z.object({
  country_id:           z.string().uuid('country_id must be a UUID'),
  class_of_business_id: z.string().uuid('class_of_business_id must be a UUID'),
  target_year:          z.number().int().min(1900).max(2100),
  force_refresh:        z.boolean().optional(),
});

// ── shape Claude must return ──────────────────────────────────────
const sourceIdx = z.number().int().min(1);

const topCarrierSchema = z.object({
  name:             z.string().min(1).max(200),
  market_share_pct: z.number().nullable().optional(),
  am_best_rating:   z.string().max(20).nullable().optional(),
});

const marketSizePremiumSchema = z.object({
  value:      z.number(),
  currency:   z.string().min(1).max(10),
  year:       z.number().int().min(1900).max(2100),
  source_idx: sourceIdx,
});

const marketLandscapeSchema = z.object({
  regulator:                z.string().min(1).max(500),
  regulator_recent_actions: z.array(z.string().max(1000)),
  top_carriers:             z.array(topCarrierSchema),
  market_size_premium:      marketSizePremiumSchema,
  market_growth_pct:        z.number().nullable(),
  recent_context:           z.string().max(2000),
});

const marketBenchmarksSchema = z.object({
  loss_ratio_market_avg:      z.number().nullable(),
  loss_ratio_year:            z.number().int().min(1900).max(2100).nullable(),
  commission_market_norm_pct: z.number().nullable(),
  retention_market_norm_pct:  z.number().nullable(),
  roe_market_avg_pct:         z.number().nullable(),
  notes:                      z.string().max(2000),
});

const trendSchema = z.object({
  title:      z.string().min(1).max(200),
  body:       z.string().max(2000),
  severity:   z.enum(['INFO', 'WARNING', 'OPPORTUNITY']),
  source_idx: sourceIdx.optional(),
});

const reportRecommendationSchema = z.object({
  title:       z.string().min(1).max(200),
  body:        z.string().max(2000),
  action_type: z.enum(['LINE_SIZE', 'TERMS', 'EXIT', 'WATCH']),
  confidence:  z.number().min(0).max(1),
  source_idx:  sourceIdx.optional(),
});

const sourceSchema = z.object({
  idx:     sourceIdx,
  url:     z.string().url(),
  title:   z.string().min(1).max(500),
  snippet: z.string().max(500),
});

export const marketReportSchema = z.object({
  executive_summary: z.string().min(1).max(2000),
  market_landscape:  marketLandscapeSchema,
  market_benchmarks: marketBenchmarksSchema,
  trends:            z.array(trendSchema),
  recommendations:   z.array(reportRecommendationSchema),
  sources:           z.array(sourceSchema),
});
