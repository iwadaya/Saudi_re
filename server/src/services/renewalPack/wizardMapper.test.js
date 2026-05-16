// Unit tests for mapExtractionToPages.
//
// Feeds the mapper synthetic ProportionalExtraction / NonProportionalExtraction
// payloads (matching the Zod schemas) and asserts:
//   • each populated page in the extraction becomes a key in pages,
//   • pages with no data are omitted (the orchestrator wouldn't touch them),
//   • CRESTA zones that don't resolve via the lookup are surfaced as
//     unmatchedCresta + warnings and never end up in the cresta rows,
//   • treatyCategory gates pages that only apply to one branch (e.g.
//     a proportional quote skips the np_structure / egnpi_history
//     pages even if the LLM accidentally returned them).

import { describe, it, expect, vi } from 'vitest';
import { mapExtractionToPages, userVisibleFilledPages } from './wizardMapper.js';
import { ProportionalExtraction, NonProportionalExtraction } from '../../validation/renewalPack.js';

const lf = (value, confidence = 1, source = 'test:A1') => ({ value, confidence, source });

// ── extraction factories (matches the Zod schemas) ──────────────────────────

function buildPropExtraction(over = {}) {
  return ProportionalExtraction.parse({
    cedant:      lf('Acme Insurance Co'),
    treatyName:  lf('Property Quota Share 2025'),
    classes:     lf(['Fire', 'Engineering']),
    uwYearRange: lf([2017, 2026]),

    premium: {
      triangle: {
        uwYears: [2024, 2025, 2026],
        devPeriods: [12, 24, 36],
        values: [
          [1_000_000, 1_200_000, null],
          [1_100_000, null, null],
          [null, null, null],
        ],
        source: 'Premium Triangle:A1:D4',
        confidence: 1,
      },
      latestEarned:     lf(1_500_000),
      growthAssumption: lf(5),
    },
    claims: {
      triangle: {
        uwYears: [2024, 2025, 2026],
        devPeriods: [12, 24, 36],
        values: [[500_000, 600_000, null], [550_000, null, null], [null, null, null]],
        source: 'Claims Triangle:A1:D4',
        confidence: 1,
      },
      ultimateLossRatio: lf(62.5, 0.7, 'Premium Triangle:derived'),
    },
    osTriangle: null,

    largeLosses: [
      {
        uwYear: lf(2024),
        insuredName: lf('Big Refinery Co'),
        description: lf('Fire'),
        date: lf('2024-03-15'),
        classOfBusiness: lf('Energy'),
        paid: lf(2_000_000),
        os: lf(500_000),
        incurred: lf(2_500_000),
      },
    ],
    catLosses: [],
    riskProfile: { books: [] },
    claimsProfile: { books: [] },
    cresta: {
      countries: [
        {
          countryCode: lf('SA'),
          zones: [
            {
              zoneCode: lf('Z01'),
              zoneName: lf('Riyadh'),
              earthquake: lf(1_000_000),
              windstorm: lf(500_000),
              flood: lf(200_000),
              srcc: lf(0),
              others: lf(0),
            },
            {
              zoneCode: lf('Z99'),
              zoneName: lf('Atlantis'),
              earthquake: lf(0),
              windstorm: lf(0),
              flood: lf(0),
              srcc: lf(0),
              others: lf(0),
            },
          ],
        },
      ],
    },
    hasTriangles: true,
    ...over,
  });
}

function buildNpExtraction(over = {}) {
  return NonProportionalExtraction.parse({
    cedant:      lf('Lambda Re'),
    treatyName:  lf('Property XL 2025'),
    classes:     lf(['Property XL']),
    uwYearRange: lf([2017, 2025]),

    layers: [
      {
        layer: lf('L1'),
        limit: lf(5_000_000),
        attachment: lf(1_000_000),
        aggLimit: lf(10_000_000),
        egnpi: lf(20_000_000),
        rate: lf(2.5),
        earnedPremium: lf(500_000),
        mdp: lf(500_000),
        mdpAlt: lf(400_000),
        reinstatements: lf(2),
        reinstatementPct: lf(100),
      },
      {
        layer: lf('L2'),
        limit: lf(10_000_000),
        attachment: lf(6_000_000),
        aggLimit: lf(20_000_000),
        egnpi: lf(40_000_000),
        rate: lf(1.5),
        earnedPremium: lf(600_000),
        mdp: lf(1_000_000),
        mdpAlt: lf(800_000),
        reinstatements: lf(1),
        reinstatementPct: lf(50),
      },
    ],
    egnpiHistory: [
      { year: lf(2023), egnpi: lf(30_000_000) },
      { year: lf(2024), egnpi: lf(40_000_000) },
      { year: lf(2025), egnpi: lf(50_000_000) },
    ],

    largeLosses: [],
    catLosses: [],
    riskProfile: { books: [] },
    claimsProfile: { books: [] },
    cresta: { countries: [] },
    hasTriangles: false,
    ...over,
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('mapExtractionToPages — proportional', () => {
  it('emits premium_history + claims_history_paid pages with normalised cells', async () => {
    const extraction = buildPropExtraction();
    const lookup = vi.fn(async ({ zoneName }) => {
      if (zoneName === 'Riyadh') {
        return { zone_db_id: '00000000-0000-0000-0000-000000000001', country_id: 'sa-uuid', zone_id: 'Z01', zone_name: 'Riyadh' };
      }
      return null;
    });
    const { pages, fieldConfidence, warnings, unmatchedCresta } =
      await mapExtractionToPages(extraction, { treatyCategory: 'PROPORTIONAL', crestaLookup: lookup });

    expect(pages.premium_history).toBeTruthy();
    expect(pages.premium_history.cells).toHaveLength(3); // (2024,12), (2024,24), (2025,12) — nulls filtered
    expect(pages.premium_history.cells[0]).toMatchObject({ origin_year: 2024, dev_months: 12, cum_value: 1_000_000 });
    expect(pages.premium_history.cells[1]).toMatchObject({ origin_year: 2024, dev_months: 24, cum_value: 1_200_000 });
    expect(pages.premium_history.cells[2]).toMatchObject({ origin_year: 2025, dev_months: 12, cum_value: 1_100_000 });

    expect(pages.claims_history_paid).toBeTruthy();
    expect(pages.claims_history_paid.cells.length).toBeGreaterThan(0);

    // osTriangle was null → no claims_history_os page emitted.
    expect(pages.claims_history_os).toBeUndefined();

    // Large losses produced a page (only one record but it counts).
    expect(pages.large_losses).toBeTruthy();
    expect(pages.large_losses.report_data.large).toHaveLength(1);
    expect(pages.large_losses.report_data.large[0]).toMatchObject({
      uwYear: 2024, insuredName: 'Big Refinery Co', paid: 2_000_000,
    });

    // CRESTA — only Riyadh resolved, so only Riyadh is in pages.cresta.rows.
    expect(pages.cresta).toBeTruthy();
    expect(pages.cresta.rows).toHaveLength(1);
    expect(pages.cresta.rows[0]).toMatchObject({
      zone_id: 'Z01', zone_name: 'Riyadh', eq_agg: 1_000_000, ws_agg: 500_000,
    });
    expect(unmatchedCresta).toEqual(['Atlantis']);
    expect(warnings.some((w) => w.includes('CRESTA zone "Atlantis"'))).toBe(true);

    // np pages are gated off for a proportional quote even if the
    // extraction accidentally contained NP-shaped data.
    expect(pages.np_structure).toBeUndefined();
    expect(pages.egnpi_history).toBeUndefined();

    // fieldConfidence is keyed by dotted paths. Header bits and any
    // leaf the mapper visited (e.g. triangle confidence, large-loss
    // fields) are recorded; fields not surfaced by the mapper aren't.
    expect(fieldConfidence['header.cedant_name']).toBe(1);
    expect(fieldConfidence['largeLosses[0].insuredName']).toBe(1);
  });

  it('omits triangle pages when triangles are null', async () => {
    const extraction = buildPropExtraction({
      premium: { triangle: null, latestEarned: lf(1_000_000), growthAssumption: lf(3) },
      claims: { triangle: null, ultimateLossRatio: lf(60) },
      osTriangle: null,
      hasTriangles: false,
    });
    const { pages } = await mapExtractionToPages(extraction, { treatyCategory: 'PROPORTIONAL' });
    expect(pages.premium_history).toBeUndefined();
    expect(pages.claims_history_paid).toBeUndefined();
    expect(pages.claims_history_os).toBeUndefined();
  });

  it('without crestaLookup, every CRESTA zone is unmatched and pages.cresta is omitted', async () => {
    const extraction = buildPropExtraction();
    const { pages, unmatchedCresta, warnings } =
      await mapExtractionToPages(extraction, { treatyCategory: 'PROPORTIONAL' });
    expect(unmatchedCresta).toEqual(['Riyadh', 'Atlantis']);
    expect(pages.cresta).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('crestaLookup that throws — warns and treats zone as unmatched', async () => {
    const extraction = buildPropExtraction();
    const lookup = vi.fn(async () => { throw new Error('cresta table unavailable'); });
    const { pages, warnings } =
      await mapExtractionToPages(extraction, { treatyCategory: 'PROPORTIONAL', crestaLookup: lookup });
    expect(warnings.some((w) => w.includes('CRESTA lookup failed'))).toBe(true);
    expect(pages.cresta).toBeUndefined();
  });
});

describe('mapExtractionToPages — non-proportional', () => {
  it('emits np_structure + egnpi_history pages, skips PROP-only triangle pages', async () => {
    const extraction = buildNpExtraction();
    const { pages, warnings, unmatchedCresta } =
      await mapExtractionToPages(extraction, { treatyCategory: 'NON_PROPORTIONAL' });

    expect(pages.np_structure).toBeTruthy();
    expect(pages.np_structure.layers).toHaveLength(2);
    expect(pages.np_structure.layers[0]).toMatchObject({
      layer_number: 1, label: 'L1', attachment: 1_000_000, layer_limit: 5_000_000,
      egnpi: 20_000_000, rate: 2.5, num_reinstatements: 2, reinstatement_pct: 100,
    });

    expect(pages.egnpi_history).toBeTruthy();
    expect(pages.egnpi_history.rows).toHaveLength(3);
    expect(pages.egnpi_history.rows[2]).toMatchObject({ uw_year: 2025, egnpi: 50_000_000 });

    // PROP-only triangle pages are gated off.
    expect(pages.premium_history).toBeUndefined();
    expect(pages.claims_history_paid).toBeUndefined();
    expect(pages.claims_history_os).toBeUndefined();

    expect(warnings).toEqual([]);
    expect(unmatchedCresta).toEqual([]);
  });

  it('PROP quote + NP-shaped extraction → no PROP pages emitted, doesn\'t crash', async () => {
    const extraction = buildNpExtraction();
    const { pages } = await mapExtractionToPages(extraction, { treatyCategory: 'PROPORTIONAL' });
    // PROP branch sees nothing PROP-y in the extraction; NP-only pages
    // are gated off because treatyCategory says PROP. End result:
    // basically nothing is written, which is the documented behaviour
    // for the prop-quote + np-pack mismatch case.
    expect(pages.premium_history).toBeUndefined();
    expect(pages.claims_history_paid).toBeUndefined();
    expect(pages.np_structure).toBeUndefined();
    expect(pages.egnpi_history).toBeUndefined();
  });
});

describe('mapExtractionToPages — surface checks', () => {
  it('throws when extraction is not an object', async () => {
    await expect(mapExtractionToPages(null)).rejects.toThrow(/extraction is required/);
  });

  it('only emits pages that actually have data — empty extraction = empty pages map', async () => {
    // Minimal valid PROP extraction with no triangles, no losses, no CRESTA.
    const extraction = buildPropExtraction({
      premium: { triangle: null, latestEarned: lf(0), growthAssumption: lf(0) },
      claims:  { triangle: null, ultimateLossRatio: lf(0) },
      osTriangle: null,
      largeLosses: [],
      catLosses: [],
      cresta: { countries: [] },
      hasTriangles: false,
    });
    const { pages } = await mapExtractionToPages(extraction, { treatyCategory: 'PROPORTIONAL' });
    expect(Object.keys(pages)).toEqual([]);
  });
});

describe('userVisibleFilledPages', () => {
  it('collapses claims_history_paid / claims_history_os to claims_history', () => {
    expect(userVisibleFilledPages(['premium_history', 'claims_history_paid', 'claims_history_os']))
      .toEqual(['premium_history', 'claims_history']);
  });
  it('passes other pages through unchanged', () => {
    expect(userVisibleFilledPages(['cresta', 'large_losses', 'np_structure']))
      .toEqual(['cresta', 'large_losses', 'np_structure']);
  });
  it('dedupes claims_history when both halves are present', () => {
    expect(userVisibleFilledPages(['claims_history_paid', 'claims_history_os'])).toEqual(['claims_history']);
  });
});
