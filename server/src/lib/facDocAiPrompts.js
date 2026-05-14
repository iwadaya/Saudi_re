// server/src/lib/facDocAiPrompts.js
//
// System prompts for each facultative document kind, plus the Zod
// schema the runner uses to validate whatever the model returns.
// Prompts are data (functions over `contextLists`) so the runner can
// inline the live factor / occupancy / clause catalogue from the DB
// rather than hard-coding a list that drifts over time.

import { z } from 'zod';

const TARGET_SCREENS = z.enum([
  'FAC_RISK_DETAIL',
  'FAC_LOCATIONS',
  'FAC_COPE',
  'FAC_PRICING',
  'FAC_LOSS_HISTORY',
  'FAC_DEDUCTIBLES',
]);

const recommendationSchema = z.object({
  target_screen:   TARGET_SCREENS,
  target_field:    z.string().min(1),
  // unknown — the AI can suggest anything; the server validates by
  // target_field type and drops invalid suggestions before persisting.
  suggested_value: z.unknown(),
  rationale:       z.string().min(1).max(500, 'rationale must be ≤ 500 chars'),
  confidence:      z.number().min(0).max(1),
});

/** Schema for the JSON the model must return. */
export const facAiResponseSchema = z.object({
  summary:         z.string().max(500, 'summary must be ≤ 500 chars'),
  extracted:       z.record(z.unknown()),
  recommendations: z.array(recommendationSchema),
});

const DOCUMENT_KINDS = ['PLACEMENT_SLIP', 'SURVEY_REPORT', 'CLAIMS_BORDEREAU', 'COPE_REPORT', 'WORDING', 'OTHER'];

function bulletList(items, max = 80) {
  const arr = Array.isArray(items) ? items.slice(0, max) : [];
  return arr.map((s) => `  - ${s}`).join('\n') || '  (none provided)';
}

function fmtFactorBlock(factorOptions = {}, codes) {
  // Inlines `factor_code → [option_label, …]` so the model picks from a
  // closed set rather than inventing labels. The runner filters again
  // server-side via fac_factor_option, so anything past this list is
  // dropped on the way in.
  return codes.map((code) => {
    const opts = factorOptions[code] || [];
    return `factor.${code}:\n${bulletList(opts)}`;
  }).join('\n');
}

const RESPONSE_TAIL = `

RESPONSE FORMAT
Return a single JSON object with this exact shape:
{
  "summary": "string ≤ 500 chars",
  "extracted": { /* free-form key/value of fields you parsed */ },
  "recommendations": [
    {
      "target_screen": "FAC_RISK_DETAIL | FAC_LOCATIONS | FAC_COPE | FAC_PRICING | FAC_LOSS_HISTORY | FAC_DEDUCTIBLES",
      "target_field":  "canonical field code, e.g. cedant_name or factor.CONSTRUCTION",
      "suggested_value": <any JSON value matching the field's data type>,
      "rationale":     "≤ 500 chars, cite the document section that supports the suggestion",
      "confidence":    0.0 to 1.0
    }
  ]
}

Return ONLY a JSON object. No markdown. No backticks.`;

function placementSlipPrompt({ occupancyNames }) {
  return `You are extracting underwriting data from a reinsurance placement slip.

Identify the cedant, original insured, period, occupancy and the
top-line sum-insured figures. Map the occupation description against
the occupancy catalogue below and PROPOSE the closest match by NAME —
the server will resolve to a numeric code, you do not need to guess
the code yourself.

OCCUPANCY CATALOGUE (sample, choose closest by name):
${bulletList(occupancyNames, 50)}

Allowed target fields:
- cedant_name, original_insured (TEXT)
- inception_date, expiry_date (DATE: YYYY-MM-DD)
- occupancy_code (TEXT — the resolved name, the server maps to int)
- original_pd_si, original_bi_si (NUMERIC, in original currency)
- pd_pml_pct, bi_pml_pct (NUMERIC, 0..1 fraction)
- original_ccy (TEXT, 3-letter ISO)
- location.append (LOCATION_ARRAY — one entry per location)

For location.append, suggested_value should be an object like:
  { "location_name": "...", "address": "...", "original_pd_si": 0,
    "original_bi_si": 0, "pd_pml_pct": 0.0, "bi_pml_pct": 0.0 }${RESPONSE_TAIL}`;
}

function surveyReportPrompt({ factorOptions }) {
  return `You are reading a property survey report. Recommend factor
selections that the underwriter should pick on the Pricing screen.
Each recommendation must select an option from the closed list below
— anything outside the list will be discarded.

FACTOR CATALOGUE (suggested_value MUST match one of the option labels
for the given factor):
${fmtFactorBlock(factorOptions, ['CONSTRUCTION', 'AGE_OF_RISK', 'CLAIM_EXPERIENCE',
  'FIRE_FIGHTING', 'EXTERNAL_EXPOSURE', 'NATCAT_EXPOSURE', 'MANAGEMENT',
  'SURVEY_RATING'])}

Cite the section of the survey supporting each suggestion in the
rationale. Confidence should be lower (0.4–0.7) for inferred fields and
higher (0.8–0.95) for fields stated directly in the report.${RESPONSE_TAIL}`;
}

function claimsBordereauPrompt() {
  return `You are reading a claims bordereau. Produce ONE recommendation
per loss with target_field="loss_history.append" and target_screen=
"FAC_LOSS_HISTORY". suggested_value should be an object like:

  {
    "loss_year": 2023,
    "loss_date": "2023-04-12",
    "loss_description": "Boiler fire in unit B",
    "cause_of_loss": "Fire",
    "fgu_paid": 125000,
    "fgu_outstanding": 0,
    "is_open": false
  }

Skip rows that look like adjustments rather than new losses. Aggregate
duplicates conservatively — when in doubt emit them as separate rows.${RESPONSE_TAIL}`;
}

function copeReportPrompt({ factorOptions }) {
  return `You are reading a COPE (Construction / Occupation / Protection
/ Exposure) report. Recommend two kinds of edits:

1. COPE columns on FAC_COPE — target_field examples:
   cope.construction_year (INT)
   cope.fire_walls (TEXT, e.g. "Reinforced concrete; full separation")
   cope.sprinkler_system (TEXT)
   cope.sprinkler_type (TEXT, e.g. "Wet pipe NFPA-13")
   cope.fire_brigade_distance_km (NUMERIC)

2. Factor selections (same closed list as the survey report):
${fmtFactorBlock(factorOptions, ['CONSTRUCTION', 'AGE_OF_RISK', 'CLAIM_EXPERIENCE',
  'FIRE_FIGHTING', 'EXTERNAL_EXPOSURE', 'NATCAT_EXPOSURE', 'MANAGEMENT',
  'SURVEY_RATING'])}

Suggested_value must match the option labels above for factor.* fields.${RESPONSE_TAIL}`;
}

function wordingPrompt({ clauseNames }) {
  return `You are reading a policy wording document. Determine which of
the following clauses are referenced or attached, and toggle them on
the FAC_DEDUCTIBLES checklist.

CLAUSE CATALOGUE:
${bulletList(clauseNames, 20)}

For each clause that is present, emit a recommendation with:
  target_screen:  "FAC_DEDUCTIBLES"
  target_field:   "clause.LM7" / "clause.ABI" / "clause.LMA_3100" / etc.
  suggested_value: { "is_checked": true, "comments": "<sub-limit or section reference>" }

If a clause is explicitly excluded, do not emit a recommendation for
it — leave the underwriter to decide.${RESPONSE_TAIL}`;
}

function otherPrompt() {
  return `Summarise this document in plain language (≤ 500 characters).
Return an empty recommendations array — this document kind does not
trigger automatic edits.${RESPONSE_TAIL}`;
}

const BUILDERS = {
  PLACEMENT_SLIP:   placementSlipPrompt,
  SURVEY_REPORT:    surveyReportPrompt,
  CLAIMS_BORDEREAU: claimsBordereauPrompt,
  COPE_REPORT:      copeReportPrompt,
  WORDING:          wordingPrompt,
  OTHER:            otherPrompt,
};

/**
 * Build a system prompt for the given document kind.
 *
 * @param {'PLACEMENT_SLIP'|'SURVEY_REPORT'|'CLAIMS_BORDEREAU'|'COPE_REPORT'|'WORDING'|'OTHER'} documentKind
 * @param {{
 *   factorOptions?: Record<string, string[]>,
 *   occupancyNames?: string[],
 *   clauseNames?: string[]
 * }} [contextLists]
 * @returns {string}
 */
export function buildFacSystemPrompt(documentKind, contextLists = {}) {
  if (!DOCUMENT_KINDS.includes(documentKind)) {
    throw new Error(`Unknown document_kind: ${documentKind}`);
  }
  const builder = BUILDERS[documentKind];
  return builder(contextLists);
}

export const FAC_AI_DOCUMENT_KINDS = DOCUMENT_KINDS;
