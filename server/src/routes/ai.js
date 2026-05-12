// server/src/routes/ai.js — Server-side proxy for AI calls.
// Treaty-detail slip ingest uses OpenAI only. Other routes in this file may
// still use Anthropic where their callers depend on that response shape.
import { Router } from 'express';
import { env } from '../config/env.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { validateBody } from '../lib/validate.js';
import { slipIngestSchema, aiCompleteSchema } from '../validation/ai.js';

const router = Router();

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_VERSION = '2023-06-01';

const OPENAI_API = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = 'gpt-4o';

// ── System prompts (mirrors SlipIngestButton.jsx — single source of truth on server) ──
function buildSystemPrompt(mode) {
  const npFields = `
- inceptionDate: "YYYY-MM-DD" (treaty inception / effective date)
- renewalDate: "YYYY-MM-DD" (treaty expiry / renewal date)
- countryName: string (country or territory of cedant)
- cedantName: string (exact reinsured/cedant company name)
- brokerName: string (intermediary/broker name)
- currencyCode: string (e.g. "USD", "SAR", "NGN")
- treatyTypeName: string (e.g. "Excess of Loss", "Quota Share", "Surplus", "Stop Loss")
- lineOfBusiness: array of strings (classes of business covered, e.g. ["Fire", "Engineering", "Property"])
- numberOfLayers: integer
- deductible: number (retention/attachment point in contract currency — pick lowest attachment)
- maxRetention: number (maximum retention / total layer limit stack)
- xlType: "Gross XL" | "Net XL" (if determinable)
- accountingMethod: "Losses Occurring" | "Risks Attaching"
- accounts: "Quarterly" | "Half yearly" | "Annual"
- estGnpi: number (Estimated Gross Net Premium Income / Subject Premium)
- brokeragePct: number (brokerage percentage, e.g. 10 for 10%)
- taxesPct: number (taxes percentage)
- noClaimsBonusPct: number
- profitCommissionPct: number
- experienceStartYear: integer (earliest year of experience / data period)`;

  const propFields = `
- inceptionDate: "YYYY-MM-DD"
- renewalDate: "YYYY-MM-DD"
- countryName: string
- cedantName: string
- brokerName: string
- currencyCode: string
- treatyTypeName: string (e.g. "Quota Share", "Surplus", "Excess of Loss")
- lineOfBusiness: array of strings
- qsLimit: number (QS 100% treaty limit, if proportional)
- retentionPct: number (retention percentage for QS)
- cessionPct: number (cession percentage for QS)
- surplusMaxRetention: number (for surplus treaties)
- numLines: integer (number of surplus lines)
- eventLimit: number
- aal: number (annual aggregate limit)
- quotaShareEpi: number (quota share estimated premium / EPI / subject premium)
- surplusEpi: number (surplus estimated premium / EPI / subject premium)
- estGnpi: number (overall estimated premium / subject premium, only if no quota/surplus split is shown)
- brokeragePct: number
- taxesPct: number
- lossCapPct: number
- fixedCommissionQSPct: number
- experienceStartYear: integer`;

  return `You are a reinsurance slip data extraction engine. The user will provide a reinsurance slip PDF.

Extract the following fields and return ONLY a valid JSON object — no markdown, no explanation, no backticks.

Workflow assumption:
- If mode is PROP, treat the document as a proportional treaty slip and check proportional fields only.
- If mode is NP, treat the document as a non-proportional treaty slip and check non-proportional fields only.
- Do not switch modes based on ambiguous wording in the document.

Fields to extract (${mode} treaty):
${mode === 'NP' ? npFields : propFields}

Rules:
- Return null for any field you cannot find with confidence.
- For dates use ISO format YYYY-MM-DD.
- For percentages return the numeric value only (e.g. return 10 not "10%").
- For monetary amounts return the raw number without commas or currency symbols.
- For lineOfBusiness return an array of clean class names.
- If inception and expiry dates are given as a period (e.g. "1 January 2026 to 31 December 2026"), parse both.
- Cedant name: use the full legal name as written.
- Broker/intermediary: extract the broker company name.
- treatyTypeName: use the most specific type you can identify from the slip.
- accountingMethod: infer from "losses occurring" or "risks attaching" language; default to "Losses Occurring" if unclear.
- For NP treaties, deductible = lowest attachment point (retention); maxRetention = sum of all layer limits stacked above retention.
- Return ONLY the JSON object.`;
}

const USER_INSTRUCTION = 'Extract the treaty details from this reinsurance slip and return the JSON object.';

// ── Provider implementations ──

async function extractSlipData(base64, mode) {
  if (!env.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
  // Responses API accepts PDFs as input_file with a base64 data URL.
  const payload = {
    model: OPENAI_MODEL,
    max_output_tokens: 1000,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: buildSystemPrompt(mode) }],
      },
      {
        role: 'user',
        content: [
          { type: 'input_file', filename: 'slip.pdf', file_data: `data:application/pdf;base64,${base64}` },
          { type: 'input_text', text: USER_INSTRUCTION },
        ],
      },
    ],
  };
  const r = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const errBody = await r.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || `OpenAI ${r.status}`);
  }
  const data = await r.json();
  // Prefer the convenience aggregator if the SDK-style field is present;
  // otherwise walk the output array.
  let text = data?.output_text;
  if (!text) {
    const parts = [];
    for (const item of data?.output || []) {
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
    text = parts.join('');
  }
  if (!text) throw new Error('OpenAI returned no text');
  logger.info('[ai/slip-ingest] OpenAI extraction succeeded');
  return { text, provider: 'openai' };
}

// POST /api/ai/slip-ingest
// Body: { base64: string, mode: 'NP' | 'PROP' }
router.post('/ai/slip-ingest', validateBody(slipIngestSchema), asyncHandler(async (req, res) => {
  const { base64, mode } = req.body;
  try {
    const { text, provider } = await extractSlipData(base64, mode);
    res.json({ text, provider });
  } catch (e) {
    logger.error('[ai/slip-ingest] extraction failed', { error: e?.message });
    return res.status(502).json({ error: e?.message || 'AI extraction failed' });
  }
}));

// POST /api/ai/complete
// General-purpose Claude text completion proxy. This is separate from
// treaty-detail slip ingest, which uses OpenAI only.
router.post('/ai/complete', validateBody(aiCompleteSchema), asyncHandler(async (req, res) => {
  const { messages, system, max_tokens = 1000 } = req.body;

  if (!env.anthropicApiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const payload = {
    model: ANTHROPIC_MODEL,
    max_tokens,
    messages,
    ...(system ? { system } : {}),
  };

  const anthropicRes = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });

  if (!anthropicRes.ok) {
    const errBody = await anthropicRes.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Anthropic API error ${anthropicRes.status}`;
    logger.error('[ai/complete] Anthropic error', { error: msg });
    return res.status(502).json({ error: msg });
  }

  const data = await anthropicRes.json();
  res.json(data);
}));

export default router;
