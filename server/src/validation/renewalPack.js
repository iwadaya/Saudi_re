// Zod schemas for the renewal-pack extraction step.
//
// The extractor asks the LLM to wrap every leaf field as
//   { value, confidence: 0..1, source: "sheet:CellRange" }
// so a reviewer screen can show provenance ("we pulled cedant from
// Cover!B3 with 100% confidence") rather than an opaque blob.
//
// We expose two top-level schemas — one per treaty type — because the
// shape diverges materially: proportional has triangles + a growth
// assumption, non-proportional has layers + an EGNPI history. Sharing
// the leaf primitives keeps the two in sync.

import { z } from 'zod';

// ── leaf primitives ──────────────────────────────────────────────────────────

const sourceRef = z
  .string()
  .min(1)
  .max(120, 'source must be ≤ 120 chars');

/**
 * Every leaf field is wrapped in this envelope.
 *   value:      the actual extraction (any JSON-serialisable scalar)
 *   confidence: 0..1 — 1 means "direct cell read", lower means
 *               "inferred from context"
 *   source:     "<sheet>:<cell-or-range>" — e.g. "Cover:B3" or
 *               "Premium Triangle:A2:F12". Free-form string; we don't
 *               try to parse it (the reviewer UI does).
 */
function leaf(valueSchema) {
  return z
    .object({
      value: valueSchema.nullable(),
      confidence: z.number().min(0).max(1),
      source: sourceRef.nullable().optional(),
    })
    .strict();
}

const numLeaf = leaf(z.number());
const intLeaf = leaf(z.number().int());
const strLeaf = leaf(z.string());
const strArrLeaf = leaf(z.array(z.string()));
const yearRangeLeaf = leaf(z.tuple([z.number().int(), z.number().int()]));

// ── triangle ─────────────────────────────────────────────────────────────────

const triangleSchema = z
  .object({
    uwYears: z.array(z.number().int()),
    devPeriods: z.array(z.number()),
    values: z.array(z.array(z.number().nullable())),
    source: sourceRef.nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

// ── loss / profile / cresta sub-schemas ──────────────────────────────────────

const lossSchema = z
  .object({
    uwYear: intLeaf,
    insuredName: strLeaf,
    description: strLeaf,
    date: strLeaf,
    classOfBusiness: strLeaf,
    paid: numLeaf,
    os: numLeaf,
    incurred: numLeaf,
  })
  .strict();

const profileBandSchema = z
  .object({
    bandMin: numLeaf,
    bandMax: numLeaf,
    numPolicies: numLeaf,
    sumInsured: numLeaf,
    premiums: numLeaf,
    avgSumInsured: numLeaf,
    avgPremium: numLeaf,
    ratePct: numLeaf,
  })
  .strict();

const profileBookSchema = z
  .object({
    label: z.string(),
    bands: z.array(profileBandSchema),
    source: sourceRef.nullable().optional(),
  })
  .strict();

const crestaCountrySchema = z
  .object({
    countryCode: strLeaf,
    zones: z.array(
      z
        .object({
          zoneCode: strLeaf,
          zoneName: strLeaf,
          earthquake: numLeaf,
          windstorm: numLeaf,
          flood: numLeaf,
          srcc: numLeaf,
          others: numLeaf,
        })
        .strict(),
    ),
  })
  .strict();

// ── shared block (everything common to both types) ───────────────────────────

const commonShape = {
  cedant: strLeaf,
  treatyName: strLeaf,
  classes: strArrLeaf,
  uwYearRange: yearRangeLeaf,
  largeLosses: z.array(lossSchema),
  catLosses: z.array(lossSchema),
  riskProfile: z.object({ books: z.array(profileBookSchema) }).strict(),
  claimsProfile: z.object({ books: z.array(profileBookSchema) }).strict(),
  cresta: z.object({ countries: z.array(crestaCountrySchema) }).strict(),
};

// ── proportional ─────────────────────────────────────────────────────────────

export const ProportionalExtraction = z
  .object({
    ...commonShape,
    premium: z
      .object({
        triangle: triangleSchema.nullable().optional(),
        latestEarned: numLeaf,
        growthAssumption: numLeaf,
      })
      .strict(),
    claims: z
      .object({
        triangle: triangleSchema.nullable().optional(),
        ultimateLossRatio: numLeaf,
      })
      .strict(),
    osTriangle: triangleSchema.nullable().optional(),
    hasTriangles: z.boolean(),
  })
  .strict();

// ── non-proportional ─────────────────────────────────────────────────────────

const layerSchema = z
  .object({
    layer: strLeaf,
    limit: numLeaf,
    attachment: numLeaf,
    aggLimit: numLeaf,
    egnpi: numLeaf,
    rate: numLeaf,
    earnedPremium: numLeaf,
    mdp: numLeaf,
    mdpAlt: numLeaf,
    reinstatements: intLeaf,
    reinstatementPct: numLeaf,
  })
  .strict();

const egnpiHistoryRow = z
  .object({
    year: intLeaf,
    egnpi: numLeaf,
  })
  .strict();

export const NonProportionalExtraction = z
  .object({
    ...commonShape,
    layers: z.array(layerSchema),
    egnpiHistory: z.array(egnpiHistoryRow),
    hasTriangles: z.literal(false),
  })
  .strict();

// ── helpers (exported for tests) ─────────────────────────────────────────────

const renewalPackSchemas = {
  proportional: ProportionalExtraction,
  non_proportional: NonProportionalExtraction,
};

/** Schema lookup by parser-classified type. Throws on unknown type. */
export function schemaForType(type) {
  const schema = renewalPackSchemas[type];
  if (!schema) throw new Error(`No renewal-pack schema for type "${type}"`);
  return schema;
}
