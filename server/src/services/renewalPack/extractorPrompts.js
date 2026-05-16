// System prompts the renewal-pack extractor sends to the LLM.
//
// The model never sees raw .xlsx bytes — only the deterministic JSON
// produced by parser.js. That has two benefits:
//   1. Token cost is bounded (parser already trimmed empty edges) and
//      sheet structure is normalised.
//   2. The model can cite cells precisely ("source": "Premium
//      Triangle:B5") because the input rows are anchored to the sheet
//      grid layout the parser exposes.
//
// Both prompts share the same envelope rules — leaf shape, confidence
// scale, null-when-missing — so they're factored into SHARED_RULES.

const LEAF_SPEC = `
LEAF FIELD SHAPE
Every leaf field must be wrapped:
{
  "value": <any JSON value, or null if missing>,
  "confidence": <0..1>,
  "source": "<sheet-name>:<cell-or-range>"   // e.g. "Cover:B3", "Premium Triangle:A2:F12"
}
Confidence scale:
  1.0   → direct cell read with no transformation
  0.7   → read from a labelled row/column with mild interpretation
  0.4   → inferred from related cells (e.g. growth assumption derived from EGNPI history)
  0.0   → field is missing; set value=null and source=null
NEVER set confidence > 0 with a null value.`;

const SHARED_RULES = `
GENERAL RULES
- Return ONLY a single JSON object. No markdown, no backticks, no commentary.
- Leave missing fields as { "value": null, "confidence": 0, "source": null } —
  do NOT guess.
- Do NOT invent CRESTA zones, layer counts, loss records or risk-profile
  bands. If a structure is absent from the parser input, emit an empty
  array — not a fabricated one.
- For numeric fields, return numbers (not strings, no commas, no "%").
- For year ranges, return [minYear, maxYear] integers.
- Cell ranges must reference sheets that actually appear in the parser
  input. If you cite a cell, the sheet name must match exactly.
${LEAF_SPEC}
`;

const PROP_SCHEMA = `
RESPONSE SHAPE — Proportional treaty
{
  "cedant":      leaf<string>,
  "treatyName":  leaf<string>,
  "classes":     leaf<string[]>,
  "uwYearRange": leaf<[int, int]>,

  "premium": {
    "triangle": {
      "uwYears":    int[],
      "devPeriods": number[],
      "values":     (number|null)[][],
      "source":     "<sheet>:<range>",
      "confidence": 0..1
    } | null,
    "latestEarned":     leaf<number>,
    "growthAssumption": leaf<number>     // % per year, e.g. 5 means +5%
  },

  "claims": {
    "triangle": <triangle shape as above> | null,
    "ultimateLossRatio": leaf<number>    // % loss ratio, e.g. 65 means 65%
  },

  "osTriangle": <triangle shape> | null,

  "largeLosses": LossRecord[],
  "catLosses":   LossRecord[],

  "riskProfile":   { "books": ProfileBook[] },
  "claimsProfile": { "books": ProfileBook[] },
  "cresta":        { "countries": CrestaCountry[] },

  "hasTriangles": boolean   // true iff at least one of the three triangles is non-null
}

LossRecord  = { uwYear, insuredName, description, date, classOfBusiness,
                paid, os, incurred }    (every field is a leaf)
ProfileBook = { label: string, bands: ProfileBand[], source?: string }
ProfileBand = { bandMin, bandMax, numPolicies, sumInsured, premiums,
                avgSumInsured, avgPremium, ratePct }   (every field is a leaf)
CrestaCountry = { countryCode, zones: Zone[] }
Zone = { zoneCode, zoneName, earthquake, windstorm, flood, srcc, others }
       (every field is a leaf)
`;

const NP_SCHEMA = `
RESPONSE SHAPE — Non-proportional treaty
{
  "cedant":      leaf<string>,
  "treatyName":  leaf<string>,
  "classes":     leaf<string[]>,
  "uwYearRange": leaf<[int, int]>,

  "layers": [
    {
      "layer":           leaf<string>,   // e.g. "L1"
      "limit":           leaf<number>,
      "attachment":      leaf<number>,
      "aggLimit":        leaf<number>,
      "egnpi":           leaf<number>,
      "rate":            leaf<number>,   // % rate-on-line
      "earnedPremium":   leaf<number>,
      "mdp":             leaf<number>,
      "mdpAlt":          leaf<number>,
      "reinstatements":  leaf<int>,
      "reinstatementPct":leaf<number>    // % per reinstatement
    }
  ],

  "egnpiHistory": [
    { "year": leaf<int>, "egnpi": leaf<number> }
  ],

  "largeLosses": LossRecord[],
  "catLosses":   LossRecord[],

  "riskProfile":   { "books": ProfileBook[] },
  "claimsProfile": { "books": ProfileBook[] },
  "cresta":        { "countries": CrestaCountry[] },

  "hasTriangles": false       // always false for NP
}

(LossRecord / ProfileBook / CrestaCountry shapes are the same as the
proportional schema.)
`;

const NP_HINTS = `
NON-PROPORTIONAL HINTS
- The "Treaty Layers" sheet drives the layers[] array. One entry per
  data row; never fabricate a layer if the sheet is empty.
- "EGNPI" sheet drives egnpiHistory; preserve year order as listed.
- Triangles are NOT applicable to NP treaties. Set hasTriangles=false.
- Layer "layer" labels should be returned verbatim from the sheet
  ("L1", "Layer 1", "1") — do not rename.`;

const PROP_HINTS = `
PROPORTIONAL HINTS
- "Premium Triangle", "Claims Triangle", "OS Claims Triangle" map to
  premium.triangle / claims.triangle / osTriangle respectively. Each
  triangle's uwYears, devPeriods, values arrays must have matching
  shapes (values.length === uwYears.length, values[i].length === devPeriods.length).
- growthAssumption: prefer an explicit number if it appears on the
  Cover sheet; otherwise derive from year-over-year premium growth in
  the premium triangle's latest diagonal (confidence ≤ 0.5).
- ultimateLossRatio: prefer an explicit number if the pack has one;
  otherwise compute (ultimate incurred ÷ ultimate premium) × 100 from
  the triangles (confidence ≤ 0.5).
- hasTriangles is true if AT LEAST one triangle is non-null.`;

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build the system prompt for the renewal-pack extractor.
 *
 * @param {'proportional'|'non_proportional'} type - From parser.js's classifier.
 */
export function buildExtractionSystemPrompt(type) {
  if (type === 'non_proportional') {
    return `You are a reinsurance renewal-pack data extraction engine.

You receive a JSON object produced by a deterministic parser that has
already read the broker's .xlsx workbook. Your job is to convert that
into a structured extraction matching the schema below.

${NP_SCHEMA}
${NP_HINTS}
${SHARED_RULES}`;
  }
  return `You are a reinsurance renewal-pack data extraction engine.

You receive a JSON object produced by a deterministic parser that has
already read the broker's .xlsx workbook. Your job is to convert that
into a structured extraction matching the schema below.

${PROP_SCHEMA}
${PROP_HINTS}
${SHARED_RULES}`;
}

/**
 * User-turn prompt: includes the parsed JSON inline so the model can
 * cite sheets / rows by name. We slice CRESTA / risk-profile down to
 * keep token use under control on very large packs; the parsed JSON's
 * structure is preserved either way.
 */
export function buildExtractionUserPrompt(parsedPack) {
  return `Parsed renewal pack (output of the deterministic parser):

${JSON.stringify(parsedPack, null, 2)}

Produce the extraction JSON now.`;
}

/**
 * On a Zod parse failure we get one retry. The follow-up prompt
 * surfaces the validation errors verbatim so the model can self-correct.
 */
export function buildRetryUserPrompt(parsedPack, previousOutput, zodErrorMessage) {
  return `Your previous response did not match the required schema.

VALIDATION ERRORS:
${zodErrorMessage}

YOUR PREVIOUS RESPONSE:
${previousOutput}

Re-emit the extraction JSON for the same parsed pack — fix only the
fields flagged above. Same rules apply.

Parsed renewal pack:
${JSON.stringify(parsedPack, null, 2)}`;
}
