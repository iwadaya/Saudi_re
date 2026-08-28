import { describe, it, expect } from 'vitest';
import {
  readExposure, selectCyberRate, resolveControlsFactor, cyberLossCost,
  computeCandidates, cyberLimit, CONTROL_KEYS,
} from './cyberLimit.js';

const RATE_MID = {
  industry_code: 'ALL', revenue_min: 100_000_000, revenue_max: 1_000_000_000,
  territory: 'WORLDWIDE', basic_limit: 5_000_000, rate_per_million: 12_000, source: 'test',
};
const RATE_MID_HEALTH = { ...RATE_MID, industry_code: 'HEALTHCARE', rate_per_million: 26_000 };
const RATE_LARGE = {
  ...RATE_MID, revenue_min: 1_000_000_000, revenue_max: null, rate_per_million: 9_000,
};

const CYBER_CURVE = {
  curve_code: 'CY-WW', kind: 'POWER', family_code: 'CYBER_LIMIT', territory: 'WORLDWIDE',
  basic_limit: 5_000_000, params: { doubling_loading: 0.45 },
};
const GL_CURVE = {
  curve_code: 'GL-WW', kind: 'POWER', family_code: 'LIABILITY_LIMIT', territory: 'WORLDWIDE',
  basic_limit: 1_000_000, params: { doubling_loading: 0.20 },
};

const CONTROLS = [
  { control_key: 'MFA', posture: 'ENFORCED_ALL', factor: 0.80, source: 'test' },
  { control_key: 'MFA', posture: 'PARTIAL', factor: 1.10, source: 'test' },
  { control_key: 'MFA', posture: 'NONE', factor: 1.60, source: 'test' },
  { control_key: 'EDR', posture: 'FULL', factor: 0.85, source: 'test' },
  { control_key: 'BACKUPS', posture: 'IMMUTABLE_TESTED', factor: 0.75, source: 'test' },
];

const section = (detail = {}, overrides = {}) => ({
  section_no: 1,
  rating_family: 'CYBER_LIMIT',
  exposure_base: 400_000_000,
  limit_amount: 10_000_000,
  attachment: 0,
  exposure_detail: { dependencies: ['AWS'], ...detail },
  ...overrides,
});

const rates = (o = {}) => ({
  cyberBaseRates: [RATE_MID, RATE_MID_HEALTH, RATE_LARGE],
  cyberControlFactors: CONTROLS,
  ilfCurves: [GL_CURVE, CYBER_CURVE],
  ...o,
});

describe('the dependency gate', () => {
  it('refuses to price an untagged risk', () => {
    const out = cyberLossCost({
      exposure: readExposure(section({ dependencies: [] })), rates: rates(),
    });
    expect(out.available).toBe(false);
    expect(out.diagnostics.gate).toBe('DEPENDENCIES_UNTAGGED');
    expect(out.unavailableReason).toMatch(/shared infrastructure/i);
  });

  it('checks the gate before anything else, so the reason is the gate', () => {
    // No revenue, no limit, no rates loaded — and the answer is still the gate,
    // because a price without a dependency tag is the thing that must not ship.
    const out = cyberLossCost({
      exposure: readExposure(section({ dependencies: [] }, { exposure_base: null, limit_amount: null })),
      rates: {},
    });
    expect(out.diagnostics.gate).toBe('DEPENDENCIES_UNTAGGED');
  });

  it('prices once the dependencies are tagged', () => {
    const out = cyberLossCost({ exposure: readExposure(section()), rates: rates() });
    expect(out.available).toBe(true);
    expect(out.diagnostics.dependencies).toEqual(['AWS']);
  });

  it('accepts tags as objects as well as strings', () => {
    const out = cyberLossCost({
      exposure: readExposure(section({ dependencies: [{ vendor_key: 'AZURE' }, 'OKTA'] })),
      rates: rates(),
    });
    expect(out.diagnostics.dependencies).toEqual(['AZURE', 'OKTA']);
  });
});

describe('selectCyberRate', () => {
  const pool = [RATE_MID, RATE_MID_HEALTH, RATE_LARGE];

  it('picks the revenue band', () => {
    expect(selectCyberRate(pool, {
      industryCode: 'ALL', revenue: 2_000_000_000, territory: 'WORLDWIDE',
    }).rate).toBe(RATE_LARGE);
  });

  it('prefers the industry-specific rate', () => {
    expect(selectCyberRate(pool, {
      industryCode: 'HEALTHCARE', revenue: 400_000_000, territory: 'WORLDWIDE',
    }).rate).toBe(RATE_MID_HEALTH);
  });

  it('falls back to the all-industries rate and says so', () => {
    const r = selectCyberRate(pool, {
      industryCode: 'MANUFACTURING', revenue: 400_000_000, territory: 'WORLDWIDE',
    });
    expect(r.rate).toBe(RATE_MID);
    expect(r.fellBackToAllIndustries).toBe(true);
  });

  it('returns nothing below the lowest band', () => {
    expect(selectCyberRate(pool, {
      industryCode: 'ALL', revenue: 5_000_000, territory: 'WORLDWIDE',
    }).rate).toBeNull();
  });
});

describe('resolveControlsFactor', () => {
  it('multiplies the postures that are loaded', () => {
    const { factor, scored } = resolveControlsFactor(CONTROLS, {
      MFA: 'ENFORCED_ALL', EDR: 'FULL', BACKUPS: 'IMMUTABLE_TESTED',
    });
    expect(factor).toBeCloseTo(0.80 * 0.85 * 0.75, 12);
    expect(scored).toBe(3);
  });

  it('loads a bad posture as well as discounting a good one', () => {
    expect(resolveControlsFactor(CONTROLS, { MFA: 'NONE' }).factor).toBeCloseTo(1.60, 12);
  });

  it('reports a posture with no loaded factor instead of assuming it is neutral silently', () => {
    const { factor, missing } = resolveControlsFactor(CONTROLS, { PATCHING: 'MONTHLY' });
    expect(factor).toBe(1);
    expect(missing).toEqual(['PATCHING=MONTHLY']);
  });

  it('covers the controls the factor table constrains itself to', () => {
    expect(CONTROL_KEYS).toEqual(
      ['MFA', 'EDR', 'BACKUPS', 'PATCHING', 'VENDOR_CONCENTRATION', 'TRAINING'],
    );
  });
});

describe('cyberLossCost', () => {
  const price = (detail = {}, overrides = {}, r = rates()) => cyberLossCost({
    exposure: readExposure(section(detail, overrides)), rates: r,
  });

  it('rates per million of the basic limit and steps to the limit written', () => {
    const out = price();
    // 5m basic ÷ 1m × 12,000 = 60,000 at the basic limit; ILF(10m)/ILF(5m)
    // under a 45% doubling loading on a curve whose basic limit is 5m.
    const alpha = Math.log2(1.45);
    expect(out.diagnostics.basic_limit_loss_cost).toBeCloseTo(60_000, 6);
    expect(out.lossCost).toBeCloseTo(60_000 * 2 ** alpha, 4);
    expect(out.diagnostics.curve).toBe('CY-WW');
  });

  it('never borrows the general-liability curve', () => {
    const out = price({}, {}, rates({ ilfCurves: [GL_CURVE] }));
    expect(out.available).toBe(false);
    expect(out.unavailableReason).toMatch(/family is CYBER_LIMIT/);
  });

  it('applies the controls posture to the basic-limit cost', () => {
    const good = price({ controls: { MFA: 'ENFORCED_ALL', BACKUPS: 'IMMUTABLE_TESTED' } });
    const bad = price({ controls: { MFA: 'NONE' } });
    expect(good.diagnostics.controls_factor).toBeCloseTo(0.80 * 0.75, 12);
    expect(bad.lossCost).toBeGreaterThan(good.lossCost);
  });

  it('says plainly that a missing control factor is the largest silent error here', () => {
    const out = price({ controls: { PATCHING: 'ANNUAL' } });
    expect(out.diagnostics.warnings.join(' ')).toMatch(/poorly-controlled risk as an average one/i);
  });

  it('says so when no posture is scored at all', () => {
    expect(price().diagnostics.warnings.join(' ')).toMatch(/untouched base rate/i);
  });

  it('prices an excess cyber layer as the difference of two ILFs', () => {
    const primary = price({}, { attachment: 0, limit_amount: 10_000_000 });
    const excess = price({}, { attachment: 10_000_000, limit_amount: 10_000_000 });
    expect(excess.lossCost).toBeLessThan(primary.lossCost);
    expect(excess.diagnostics.attachment).toBe(10_000_000);
  });

  it('reports the cost per million of limit, which is how cyber is compared', () => {
    const out = price();
    expect(out.diagnostics.loss_cost_per_million).toBeCloseTo(out.lossCost / 10, 6);
  });

  it('reports unavailable without revenue, a limit, or a loaded rate', () => {
    expect(price({}, { exposure_base: null }).unavailableReason).toMatch(/revenue/i);
    expect(price({}, { limit_amount: null }).unavailableReason).toMatch(/limit/i);
    expect(price({}, {}, rates({ cyberBaseRates: [] })).unavailableReason)
      .toMatch(/cyber base rate/i);
  });
});

describe('computeCandidates and the descriptor', () => {
  it('offers the cyber rate as its exposure candidate', () => {
    const c = computeCandidates({ section: section(), rates: rates() });
    expect(c.map((x) => x.code)).toEqual(['CYBER_RATE']);
  });

  it('lets the placement structure override the section limit (F13)', () => {
    // An XL placement prices its own layer, not the original 4m tower —
    // otherwise the exposure candidate is whole-tower money blended against
    // a burning cost that IS cut to the layer.
    const sec = section({}, { limit_amount: 4_000_000, attachment: 0 });
    const full = computeCandidates({ section: sec, rates: rates() })[0].result;
    const layered = computeCandidates({
      section: sec,
      structure: { attachment: 2_000_000, limit: 2_000_000, isNonProportional: true },
      rates: rates(),
    })[0].result;
    // Basic-limit cost = 5m ÷ 1m × 12,000 = 60,000 (no controls scored);
    // full tower = 60,000 × ILF(4m); the 2m xs 2m layer is the ILF difference.
    const alpha = Math.log2(1.45);
    expect(full.lossCost).toBeCloseTo(60_000 * (4 / 5) ** alpha, 4);          // ≈ 53,235.62
    expect(layered.lossCost)
      .toBeCloseTo(60_000 * ((4 / 5) ** alpha - (2 / 5) ** alpha), 4);        // ≈ 16,521.40
    expect(layered.lossCost).toBeLessThan(full.lossCost);
    expect(layered.diagnostics.attachment).toBe(2_000_000);
    expect(layered.diagnostics.limit).toBe(2_000_000);
  });

  it('leaves the section structure alone on a proportional placement', () => {
    const bare = computeCandidates({ section: section(), rates: rates() })[0].result;
    const prop = computeCandidates({
      section: section(),
      structure: { attachment: 0, limit: Infinity, isNonProportional: false },
      rates: rates(),
    })[0].result;
    expect(prop.lossCost).toBeCloseTo(bare.lossCost, 9);
    expect(prop.diagnostics.limit).toBe(10_000_000);
  });

  it('caps credibility at half — cyber experience ages badly', () => {
    expect(cyberLimit.credibility.maxZ).toBe(0.50);
    expect(cyberLimit.implemented).toBe(true);
    expect(cyberLimit.ratingBasis).toBe('LIMIT_ILF');
  });

  it('marks the dependency tags as required on the exposure form', () => {
    const field = cyberLimit.exposureFields.find((f) => f.key === 'dependencies');
    expect(field.required).toBe(true);
  });
});
