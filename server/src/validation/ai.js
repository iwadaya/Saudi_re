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
