// server/src/validation/ai.js
// Zod schemas for the /api/ai/* proxy routes. These validate the
// shape of inbound payloads before they're forwarded to upstream LLM
// providers, so we don't pay tokens to discover a typo in `messages`
// and so untrusted input can't be smuggled into provider-specific
// fields (system, tools, …).

import { z } from 'zod';

// ── /ai/slip-ingest ────────────────────────────────────────────────
// Body: { base64: string, mode: 'NP' | 'PROP' }
// Limit base64 to ~5MB string (= ~3.5MB PDF) — same threshold the
// route enforced manually before validation.
export const slipIngestSchema = z.object({
  base64: z.string()
    .min(1, 'base64 PDF data required')
    .max(5_000_000, 'PDF too large. Maximum ~3.5MB.'),
  mode: z.enum(['NP', 'PROP']).default('NP'),
});

// ── /ai/complete ───────────────────────────────────────────────────
// Body: { messages: [...], system?: string, max_tokens?: number }
// `messages` is the Anthropic Messages API shape, kept loose because
// content can be either a string or a list of content blocks. We cap
// max_tokens at 4000 to bound the worst-case spend per call.
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(z.unknown())]),
});

export const aiCompleteSchema = z.object({
  messages: z.array(messageSchema).min(1, 'messages array required'),
  system: z.string().optional(),
  max_tokens: z.number().int().positive().max(4000).optional(),
});

// ── /ai/fac/analyse-document ──────────────────────────────────────
// Triggers a fac_document_analysis run against a previously uploaded
// document. The runner reads the file bytes from storage (Cloudinary
// URL or local upload-dir path) on the server, so the client never
// re-uploads the payload here.
export const facAnalyseDocumentSchema = z.object({
  fac_risk_id:   z.string().uuid('fac_risk_id must be a UUID'),
  document_id:   z.string().uuid('document_id must be a UUID'),
  document_kind: z.enum(['PLACEMENT_SLIP', 'SURVEY_REPORT', 'CLAIMS_BORDEREAU',
                         'COPE_REPORT', 'WORDING', 'OTHER']),
});

// ── /ai/cedant/:cedantId/portfolio-recommendations (prompt 7.5.a) ──
// Body fields define how aggressive the recommendation should be and
// the underwriter's caps. Percentages are stored as fractions (0..1).
export const portfolioRecommendationsRequestSchema = z.object({
  target_year:               z.number().int().min(1900).max(2100),
  risk_appetite:             z.enum(['CONSERVATIVE','BALANCED','OPPORTUNISTIC']),
  max_line_size_pct:         z.number().min(0).max(1),
  max_cob_concentration_pct: z.number().min(0).max(1),
});

// Shape the model is required to return. Used to validate the parsed
// Claude response before persisting. Anything that fails this schema
// produces a 502 with raw_response echoed for debugging.
export const portfolioRecommendationsResponseSchema = z.object({
  summary: z.string().max(2000),
  portfolio_metrics: z.object({
    current_expected_return:     z.number(),
    recommended_expected_return: z.number(),
    return_uplift_pct:           z.number(),
    diversification_score:       z.number().min(0).max(1),
  }),
  recommendations: z.array(z.object({
    contract_id:          z.string().uuid(),
    current_line_pct:     z.number().min(0).max(1),
    recommended_line_pct: z.number().min(0).max(1),
    rationale:            z.string().max(500),
    confidence:           z.number().min(0).max(1),
    impact_on_return:     z.number(),
  })),
});

export const rejectRecommendationSchema = z.object({
  reason: z.string().max(2000).optional(),
});

// ── Staging endpoints (prompt 7.5.b) ───────────────────────────────
export const stageLineChangeSchema = z.object({
  contract_id:           z.string().uuid(),
  proposed_line_pct:     z.number().min(0).max(1),
  source:                z.enum(['AI_RECOMMENDATION','MANUAL_OVERRIDE']),
  source_rec_id:         z.string().uuid().optional(),
  warning_acknowledged:  z.boolean().optional(),
}).refine(
  v => v.source !== 'AI_RECOMMENDATION' || !!v.source_rec_id,
  { message: 'source_rec_id is required when source=AI_RECOMMENDATION', path: ['source_rec_id'] },
);

export const discardStagingSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const commitStagingSchema = z.object({
  staging_ids: z.array(z.string().uuid()).optional(),
});
