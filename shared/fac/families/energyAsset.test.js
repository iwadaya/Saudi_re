import { describe, it, expect } from 'vitest';
import {
  readExposure, selectEnergyRate, energyLossCost, sublimitLossCost,
  computeCandidates, energyAsset, SUBLIMIT_KINDS, SUBLIMIT_LABEL,
} from './energyAsset.js';

const REFINERY_STD = {
  asset_type: 'REFINERY', process_hazard_band: 'STANDARD', territory: 'WORLDWIDE',
  rate_pm: 1.8, windstorm_season_load_pm: null, source: 'test',
};
const REFINERY_SEVERE = { ...REFINERY_STD, process_hazard_band: 'SEVERE', rate_pm: 3.4 };
const OFFSHORE_GOM = {
  asset_type: 'OFFSHORE_PLATFORM', process_hazard_band: 'STANDARD', territory: 'GOM',
  rate_pm: 5.0, windstorm_season_load_pm: 2.5, source: 'test',
};

const SUBLIMIT_RATES = [
  { sublimit_kind: 'CONTROL_OF_WELL', sublimit_key: 'DEFAULT', rate_pm: 6.0, source: 'test' },
  { sublimit_kind: 'OEE', sublimit_key: 'DEFAULT', rate_pm: 4.0, source: 'test' },
  { sublimit_kind: 'REMOVAL_OF_WRECK', sublimit_key: 'DEFAULT', rate_pm: 1.2, source: 'test' },
  { sublimit_kind: 'LOPI', sublimit_key: 'DEFAULT', rate_pm: 2.0, source: 'test' },
];

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'ENERGY_ASSET',
  sum_insured: 800_000_000,
  exposure_detail: { asset_type: 'REFINERY', process_hazard_band: 'STANDARD', ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  energyBaseRates: [REFINERY_STD, REFINERY_SEVERE, OFFSHORE_GOM],
  energySublimitRates: SUBLIMIT_RATES,
  ...o,
});

describe('readExposure', () => {
  it('reads the asset, the band and whether the band was actually stated', () => {
    const e = readExposure(section());
    expect(e.assetValue).toBe(800_000_000);
    expect(e.assetType).toBe('REFINERY');
    expect(e.hazardBand).toBe('STANDARD');
    expect(e.hazardBandStated).toBe(true);
    expect(readExposure(section({ process_hazard_band: null })).hazardBandStated).toBe(false);
  });

  it('reads sub-limits as limits, whether stated bare or with a key', () => {
    const e = readExposure(section({
      sublimits: {
        CONTROL_OF_WELL: 150_000_000,
        OEE: { limit: 50_000_000, key: 'DEEPWATER' },
        REMOVAL_OF_WRECK: 0,
      },
    }));
    expect(e.sublimits.CONTROL_OF_WELL).toEqual({ limit: 150_000_000, key: 'DEFAULT' });
    expect(e.sublimits.OEE).toEqual({ limit: 50_000_000, key: 'DEEPWATER' });
    // A zero limit is not a sub-limit.
    expect(e.sublimits.REMOVAL_OF_WRECK).toBeUndefined();
  });

  it('knows the sub-limits an energy slip carries', () => {
    expect(SUBLIMIT_KINDS).toEqual(
      ['CONTROL_OF_WELL', 'OEE', 'SEEPAGE_POLLUTION', 'REMOVAL_OF_WRECK', 'LOPI'],
    );
    expect(SUBLIMIT_LABEL.CONTROL_OF_WELL).toBe('Control of Well');
  });
});

describe('selectEnergyRate', () => {
  const pool = [REFINERY_STD, REFINERY_SEVERE, OFFSHORE_GOM];

  it('keys on the hazard band as well as the asset type', () => {
    expect(selectEnergyRate(pool, {
      assetType: 'REFINERY', hazardBand: 'SEVERE', territory: 'WORLDWIDE',
    }).rate).toBe(REFINERY_SEVERE);
  });

  it('never relaxes the hazard band to find a rate', () => {
    // This is the mistake the family exists to prevent: an EXTREME-band plant
    // must not silently take the SEVERE rate.
    expect(selectEnergyRate(pool, {
      assetType: 'REFINERY', hazardBand: 'EXTREME', territory: 'WORLDWIDE',
    }).rate).toBeNull();
  });

  it('does relax the territory, and says so', () => {
    const r = selectEnergyRate(pool, {
      assetType: 'REFINERY', hazardBand: 'STANDARD', territory: 'KSA',
    });
    expect(r.rate).toBe(REFINERY_STD);
    expect(r.fellBackToWorldwide).toBe(true);
  });
});

describe('energyLossCost', () => {
  const price = (detail = {}, overrides = {}, r = rates()) => energyLossCost({
    exposure: readExposure(section(detail, overrides)), rates: r,
  });

  it('rates the asset values at the band rate', () => {
    const out = price();
    expect(out.available).toBe(true);
    expect(out.ratePm).toBeCloseTo(1.8, 12);
    expect(out.lossCost).toBeCloseTo((800_000_000 * 1.8) / 1000, 4);
  });

  it('prices a severe-band plant at the severe rate, not the standard one', () => {
    expect(price({ process_hazard_band: 'SEVERE' }).ratePm).toBeCloseTo(3.4, 12);
  });

  it('adds the named-windstorm season load only when the asset is exposed', () => {
    const exposed = price(
      { asset_type: 'OFFSHORE_PLATFORM', territory: 'GOM', named_windstorm_exposed: true },
    );
    const notExposed = price({ asset_type: 'OFFSHORE_PLATFORM', territory: 'GOM' });
    expect(exposed.ratePm).toBeCloseTo(7.5, 12);
    expect(notExposed.ratePm).toBeCloseTo(5.0, 12);
    expect(exposed.diagnostics.windstorm_load_pm).toBeCloseTo(2.5, 12);
  });

  it('says so when a windstorm-exposed asset has no windstorm load loaded', () => {
    const out = price({ named_windstorm_exposed: true });
    expect(out.diagnostics.windstorm_load_pm).toBe(0);
    expect(out.diagnostics.warnings.join(' ')).toMatch(/seasonal exposure is not in this price/i);
  });

  it('warns when the hazard band was defaulted rather than stated', () => {
    const out = price({ process_hazard_band: null });
    expect(out.diagnostics.warnings.join(' ')).toMatch(/set it explicitly/i);
  });

  it('reports unavailable, naming the band, when no rate is loaded for it', () => {
    const out = price({ process_hazard_band: 'EXTREME' });
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toContain('EXTREME');
    expect(out.unavailableReason).toMatch(/never relaxed/i);
  });

  it('reports unavailable without asset values or an asset type', () => {
    expect(price({}, { sum_insured: null }).unavailableReason).toMatch(/asset values/i);
    expect(price({ asset_type: null }).unavailableReason).toMatch(/asset type/i);
  });
});

describe('sublimitLossCost', () => {
  it('rates a sub-limit on its own limit', () => {
    const r = sublimitLossCost({
      kind: 'CONTROL_OF_WELL', limit: 150_000_000, rates: SUBLIMIT_RATES,
    });
    expect(r.available).toBe(true);
    expect(r.lossCost).toBeCloseTo((150_000_000 * 6.0) / 1000, 4);
  });

  it('falls back to the DEFAULT key when the stated one is not loaded', () => {
    const r = sublimitLossCost({
      kind: 'OEE', limit: 50_000_000, key: 'DEEPWATER', rates: SUBLIMIT_RATES,
    });
    expect(r.available).toBe(true);
  });

  it('refuses to price a sub-limit as a percentage of the asset rate', () => {
    const r = sublimitLossCost({
      kind: 'SEEPAGE_POLLUTION', limit: 25_000_000, rates: SUBLIMIT_RATES,
    });
    expect(r.available).toBe(false);
    expect(r.unavailableReason).toMatch(/not a percentage of the asset rate/i);
  });

  it('needs a limit to rate against', () => {
    expect(sublimitLossCost({ kind: 'OEE', limit: 0, rates: SUBLIMIT_RATES }).available)
      .toBe(false);
  });
});

describe('computeCandidates', () => {
  it('gives the asset rate alone when the slip carries no sub-limits', () => {
    const c = computeCandidates({ section: section(), rates: rates() });
    expect(c.map((x) => x.code)).toEqual(['ENERGY_RATE']);
  });

  it('gives each sub-limit its own candidate, never folded into the asset rate', () => {
    const c = computeCandidates({
      section: section({
        asset_type: 'OFFSHORE_PLATFORM', territory: 'GOM',
        sublimits: { CONTROL_OF_WELL: 150_000_000, REMOVAL_OF_WRECK: 40_000_000 },
      }),
      rates: rates(),
    });
    expect(c.map((x) => x.code)).toEqual([
      'ENERGY_RATE', 'SUBLIMIT_CONTROL_OF_WELL', 'SUBLIMIT_REMOVAL_OF_WRECK',
    ]);
    // The asset rate is untouched by the sub-limits sitting beside it.
    expect(c[0].result.ratePm).toBeCloseTo(5.0, 12);
    expect(c[1].result.lossCost).toBeCloseTo((150_000_000 * 6.0) / 1000, 4);
  });

  it('derives the LOPI limit from daily production value and the indemnity period', () => {
    const c = computeCandidates({
      section: section({ daily_production_value: 2_000_000, lopi_indemnity_days: 180 }),
      rates: rates(),
    });
    const lopi = c.find((x) => x.code === 'SUBLIMIT_LOPI');
    expect(lopi.result.diagnostics.limit).toBe(360_000_000);
    expect(lopi.result.lossCost).toBeCloseTo((360_000_000 * 2.0) / 1000, 4);
  });

  it('lets an explicitly stated LOPI limit win over the derived one', () => {
    const c = computeCandidates({
      section: section({
        daily_production_value: 2_000_000, lopi_indemnity_days: 180,
        sublimits: { LOPI: 100_000_000 },
      }),
      rates: rates(),
    });
    expect(c.find((x) => x.code === 'SUBLIMIT_LOPI').result.diagnostics.limit).toBe(100_000_000);
  });

  it('reports an unrated sub-limit without silencing the asset rate', () => {
    const c = computeCandidates({
      section: section({ sublimits: { SEEPAGE_POLLUTION: 25_000_000 } }),
      rates: rates(),
    });
    expect(c[0].result.available).toBe(true);
    expect(c[1].result.available).toBe(false);
  });
});

describe('the family descriptor', () => {
  it('sits in the energy segment and rates per mille of asset values', () => {
    expect(energyAsset.code).toBe('ENERGY_ASSET');
    expect(energyAsset.segment).toBe('ENERGY_POWER');
    expect(energyAsset.ratingBasis).toBe('SI_PER_MILLE');
    expect(energyAsset.implemented).toBe(true);
  });

  it('caps credibility low — energy losses are few and enormous', () => {
    expect(energyAsset.credibility.maxZ).toBe(0.60);
  });
});
