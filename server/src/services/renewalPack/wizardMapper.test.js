// Tests for mapExtractionToWizardState.
//
// Feeds the mapper synthetic ProportionalExtraction / NonProportionalExtraction
// payloads (matching the Zod schemas) and asserts:
//   • output shape matches what the wizard hydrates from,
//   • fieldConfidence is keyed by the dotted paths we promised,
//   • CRESTA zones that don't resolve are flagged and surfaced in
//     unmatchedCresta + warnings — and never inserted with a fake zone_id.
//   • hasTriangles=false sets skipTriangleScreens=true.

import { describe, it, expect, vi } from 'vitest';
import { mapExtractionToWizardState } from './wizardMapper.js';
import { ProportionalExtraction, NonProportionalExtraction } from '../../validation/renewalPack.js';

const lf = (value, confidence = 1, source = 'test:A1') => ({ value, confidence, source });

// ── extraction factories (matches the Zod schemas) ───────────────────────────

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
    riskProfile: {
      books: [
        {
          label: 'Risk Profile 1',
          source: 'Risk Profile',
          bands: [
            {
              bandMin: lf(0),
              bandMax: lf(1_000_000),
              numPolicies: lf(120),
              sumInsured: lf(60_000_000),
              premiums: lf(180_000),
              avgSumInsured: lf(500_000),
              avgPremium: lf(1_500),
              ratePct: lf(0.3),
            },
          ],
        },
      ],
    },
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

// ── tests ────────────────────────────────────────────────────────────────────

describe('mapExtractionToWizardState — proportional', () => {
  it('produces a wizardState shape the wizard PUT body schema accepts', async () => {
    const extraction = buildPropExtraction();
    const lookup = vi.fn(async ({ zoneName }) => {
      if (zoneName === 'Riyadh') {
        return { zone_db_id: '00000000-0000-0000-0000-000000000001', country_id: 'sa-uuid', zone_id: 'Z01', zone_name: 'Riyadh' };
      }
      return null;
    });
    const { wizardState, fieldConfidence, warnings, unmatchedCresta } =
      await mapExtractionToWizardState(extraction, { crestaLookup: lookup });

    // Header — cedant goes into cedant_name (text), cedant_id stays null
    // because the underwriter resolves it via the lookup screen.
    expect(wizardState.header.cedant_name).toBe('Acme Insurance Co');
    expect(wizardState.header.cedant_id).toBeNull();
    expect(wizardState.header.status).toBe('DRAFT');
    expect(wizardState.header.uw_year).toBe(2026);
    expect(wizardState.header.contract_description).toBe('Property Quota Share 2025');
    expect(wizardState.header.classes_text).toEqual(['Fire', 'Engineering']);

    // Detail — triangulations_available + experience_start_year populated.
    expect(wizardState.detail.triangulations_available).toBe(true);
    expect(wizardState.detail.experience_start_year).toBe(2017);
    expect(wizardState.detail.quota_share_epi).toBe(1_500_000);
    expect(wizardState.detail.growth_assumption_pct).toBe(5);
    expect(wizardState.detail.ultimate_loss_ratio_pct).toBe(62.5);

    // Triangles
    expect(wizardState.triangles.premium.uwYears).toEqual([2024, 2025, 2026]);
    expect(wizardState.triangles.premium.values[0]).toEqual([1_000_000, 1_200_000, null]);
    expect(wizardState.triangles.os).toBeNull();
    expect(wizardState.skipTriangleScreens).toBe(false);

    // Losses
    expect(wizardState.largeLosses).toHaveLength(1);
    expect(wizardState.largeLosses[0]).toMatchObject({
      uwYear: 2024,
      insuredName: 'Big Refinery Co',
      paid: 2_000_000,
      is_selected: true,
    });

    // Risk profile
    expect(wizardState.riskProfile.books).toHaveLength(1);
    expect(wizardState.riskProfile.books[0].bands[0]).toMatchObject({
      band_min: 0,
      band_max: 1_000_000,
      num_policies: 120,
    });

    // CRESTA — Riyadh resolves, Atlantis does not.
    expect(wizardState.cresta.zones).toHaveLength(2);
    const riyadh = wizardState.cresta.zones.find((z) => z.zone_name === 'Riyadh');
    expect(riyadh.zone_id).toBe('Z01');
    expect(riyadh.zone_db_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(riyadh.needsManualCrestaMatch).toBe(false);

    const atlantis = wizardState.cresta.zones.find((z) => z.zone_name === 'Atlantis');
    expect(atlantis.needsManualCrestaMatch).toBe(true);
    expect(atlantis.zone_id).toBeNull();

    expect(unmatchedCresta).toEqual(['Atlantis']);
    expect(warnings.some((w) => w.includes('CRESTA zone "Atlantis" did not resolve'))).toBe(true);

    // fieldConfidence is keyed by dotted paths
    expect(fieldConfidence['header.cedant_name']).toBe(1);
    expect(fieldConfidence['claims.ultimateLossRatio']).toBe(0.7);
    expect(fieldConfidence['cresta.countries[0].zones[1].zoneName']).toBe(1);
  });

  it('sets skipTriangleScreens=true and triangles=null when hasTriangles is false', async () => {
    const extraction = buildPropExtraction({
      hasTriangles: false,
      premium: {
        triangle: null,
        latestEarned: lf(1_500_000),
        growthAssumption: lf(5),
      },
      claims: { triangle: null, ultimateLossRatio: lf(60) },
      osTriangle: null,
    });
    const { wizardState } = await mapExtractionToWizardState(extraction);
    expect(wizardState.skipTriangleScreens).toBe(true);
    expect(wizardState.triangles).toBeNull();
    expect(wizardState.detail.triangulations_available).toBe(false);
  });

  it('without crestaLookup, every CRESTA zone is unmatched (no auto-create)', async () => {
    const extraction = buildPropExtraction();
    const { wizardState, warnings, unmatchedCresta } =
      await mapExtractionToWizardState(extraction);
    expect(unmatchedCresta).toEqual(['Riyadh', 'Atlantis']);
    expect(wizardState.cresta.zones.every((z) => z.needsManualCrestaMatch)).toBe(true);
    expect(wizardState.cresta.zones.every((z) => z.zone_db_id === null)).toBe(true);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('handles a crestaLookup that throws (e.g. DB error) — warns and keeps row unmatched', async () => {
    const extraction = buildPropExtraction();
    const lookup = vi.fn(async () => { throw new Error('cresta table unavailable'); });
    const { unmatchedCresta, warnings } =
      await mapExtractionToWizardState(extraction, { crestaLookup: lookup });
    expect(warnings.some((w) => w.includes('CRESTA lookup failed'))).toBe(true);
    // Still unmatched because the lookup never produced a match.
    expect(unmatchedCresta.length).toBeGreaterThanOrEqual(2);
  });
});

describe('mapExtractionToWizardState — non-proportional', () => {
  it('produces NP layer rows, EGNPI history and skipTriangleScreens=true', async () => {
    const extraction = buildNpExtraction();
    const { wizardState, fieldConfidence, warnings, unmatchedCresta } =
      await mapExtractionToWizardState(extraction);

    expect(wizardState.skipTriangleScreens).toBe(true);
    expect(wizardState.triangles).toBeNull();
    expect(wizardState.header.cedant_name).toBe('Lambda Re');
    expect(wizardState.header.uw_year).toBe(2025);

    expect(wizardState.np_structure.layers).toHaveLength(2);
    expect(wizardState.np_structure.layers[0]).toMatchObject({
      layer_number: 1,
      label: 'L1',
      attachment: 1_000_000,
      layer_limit: 5_000_000,
      aggregate_limit: 10_000_000,
      egnpi: 20_000_000,
      rate: 2.5,
      num_reinstatements: 2,
      reinstatement_pct: 100,
    });

    expect(wizardState.egnpi_history).toHaveLength(3);
    expect(wizardState.egnpi_history[2]).toEqual({ uw_year: 2025, egnpi: 50_000_000 });

    // detail picks up the latest EGNPI from the history
    expect(wizardState.detail.est_gnpi).toBe(50_000_000);
    expect(wizardState.detail.number_of_layers).toBe(2);

    // dotted fieldConfidence for layer fields
    expect(fieldConfidence['np_structure.layers[0].layer']).toBe(1);
    expect(fieldConfidence['np_structure.layers[1].egnpi']).toBe(1);
    expect(fieldConfidence['egnpiHistory[2].year']).toBe(1);

    expect(warnings).toEqual([]);
    expect(unmatchedCresta).toEqual([]);
  });
});

describe('mapExtractionToWizardState — surface checks', () => {
  it('output keys match wizard schema expectations (header / detail / commissions / lossParticipation / class_ids / epi_split)', async () => {
    const extraction = buildPropExtraction();
    const { wizardState } = await mapExtractionToWizardState(extraction);
    for (const k of ['header', 'detail', 'commissions', 'lossParticipation', 'class_ids', 'epi_split']) {
      expect(Object.prototype.hasOwnProperty.call(wizardState, k)).toBe(true);
    }
  });

  it('throws when extraction is not an object', async () => {
    await expect(mapExtractionToWizardState(null)).rejects.toThrow(/extraction is required/);
  });
});
