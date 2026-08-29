import { describe, it, expect } from 'vitest';
import { buildExposureProfile } from './exposure.js';

const RISK = { pd_sum_insured: '400000000', bi_sum_insured: '100000000' };

describe('buildExposureProfile — source precedence', () => {
  it('prefers locations, which describe the risk in the most detail', () => {
    const profile = buildExposureProfile({
      risk: RISK,
      sections: [{ sum_insured: '500000000' }],
      locations: [
        { pd_si: '300000000', bi_si: '60000000' },
        { pd_si: '100000000', bi_si: '40000000' },
      ],
    });

    expect(profile.basis).toBe('LOCATIONS');
    expect(profile.pd_si).toBe(400_000_000);
    expect(profile.bi_si).toBe(100_000_000);
    expect(profile.total_si).toBe(500_000_000);
    expect(profile.pd_si_share).toBeCloseTo(0.8, 9);
    expect(profile.bi_included).toBe(true);
    expect(profile.top_location_si).toBe(360_000_000);
    expect(profile.warnings).toEqual([]);
  });

  it('falls back to the risk header when there are no locations', () => {
    const profile = buildExposureProfile({ risk: RISK, sections: [], locations: [] });
    expect(profile.basis).toBe('RISK_HEADER');
    expect(profile.total_si).toBe(500_000_000);
    expect(profile.pd_si_share).toBeCloseTo(0.8, 9);
    expect(profile.bi_included).toBe(true);
  });

  it('falls back to the section totals when the header carries no split', () => {
    const profile = buildExposureProfile({
      risk: { pd_sum_insured: 0, bi_sum_insured: 0 },
      sections: [{ sum_insured: '120000000' }, { sum_insured: '80000000' }],
    });
    expect(profile.basis).toBe('SECTIONS');
    expect(profile.total_si).toBe(200_000_000);
    expect(profile.bi_included).toBe(false);
    expect(profile.top_location_si).toBe(120_000_000);
    expect(profile.warnings.some((w) => /100% material damage/.test(w))).toBe(true);
  });

  it('reports NONE rather than guessing when there is nothing to go on', () => {
    const profile = buildExposureProfile({ risk: null });
    expect(profile.basis).toBe('NONE');
    expect(profile.total_si).toBe(0);
    expect(profile.pd_si_share).toBe(1);
    expect(profile.bi_included).toBe(false);
  });
});

describe('buildExposureProfile — the BI trap (F10)', () => {
  // The old screen took pd_si_share from the locations only, defaulting to
  // 1.0 when there were none, but took bi_included from the header. A risk
  // with BI on the header and no locations therefore computed a BI rate and
  // weighted it at zero. One profile makes that state unrepresentable.
  it('keeps the BI flag and the PD share on the same source', () => {
    const profile = buildExposureProfile({ risk: RISK, locations: [] });
    expect(profile.bi_included).toBe(true);
    expect(profile.pd_si_share).toBeLessThan(1);
  });

  it('reports no BI and a full PD share together', () => {
    const profile = buildExposureProfile({
      risk: { pd_sum_insured: '500000000', bi_sum_insured: 0 },
    });
    expect(profile.bi_included).toBe(false);
    expect(profile.pd_si_share).toBe(1);
  });
});

describe('buildExposureProfile — PML as a 0..1 fraction (F9/F12)', () => {
  // Two storage conventions meet here: fac_location.pd_pml_pct / bi_pml_pct
  // are 0..1 fractions, fac_risk.pml_pct is a 0..100 percentage. The profile
  // converts once, at this boundary, and only ever carries the fraction.
  it('weights the location PMLs into one fraction of total SI', () => {
    const profile = buildExposureProfile({
      risk: RISK,
      locations: [
        { pd_si: '300000000', bi_si: '100000000', pd_pml_pct: 0.5, bi_pml_pct: 0.25 },
        { pd_si: '100000000', bi_si: 0 },   // no stated PML → full value, no relief
      ],
    });
    // MPL = 300m×0.5 + 100m×0.25 + 100m×1 = 275m over 500m total SI.
    expect(profile.pml_pct).toBeCloseTo(0.55, 9);
  });

  it('falls back to the risk header PML, converting 0..100 to a fraction once', () => {
    const profile = buildExposureProfile({ risk: { ...RISK, pml_pct: 40 } });
    expect(profile.basis).toBe('RISK_HEADER');
    expect(profile.pml_pct).toBeCloseTo(0.4, 9);
  });

  it('uses the risk header PML when locations exist but state none', () => {
    const profile = buildExposureProfile({
      risk: { pml_pct: '40' },
      locations: [{ pd_si: '100000000', bi_si: 0 }],
    });
    expect(profile.basis).toBe('LOCATIONS');
    expect(profile.pml_pct).toBeCloseTo(0.4, 9);
  });

  it('is null — not 1 — when no PML is recorded anywhere', () => {
    expect(buildExposureProfile({ risk: RISK }).pml_pct).toBeNull();
    expect(buildExposureProfile({ risk: null }).pml_pct).toBeNull();
  });

  it('treats a zero header PML as absent, never as a nil MPL', () => {
    expect(buildExposureProfile({ risk: { ...RISK, pml_pct: 0 } }).pml_pct).toBeNull();
  });

  it('clamps a percent-scale value typed into a location fraction field', () => {
    const profile = buildExposureProfile({
      risk: null,
      locations: [{ pd_si: '100000000', bi_si: 0, pd_pml_pct: 40 }],
    });
    expect(profile.pml_pct).toBe(1);
  });
});

describe('buildExposureProfile — reconciliation', () => {
  it('warns when the sections and the chosen basis disagree', () => {
    const profile = buildExposureProfile({
      risk: RISK,
      sections: [{ sum_insured: '900000000' }],
      locations: [{ pd_si: '400000000', bi_si: '100000000' }],
    });
    expect(profile.basis).toBe('LOCATIONS');
    expect(profile.total_si).toBe(500_000_000);
    expect(profile.warnings.some((w) => /Sections total/.test(w))).toBe(true);
  });

  it('stays quiet when they agree within tolerance', () => {
    const profile = buildExposureProfile({
      risk: RISK,
      sections: [{ sum_insured: '502000000' }],   // 0.4% apart
      locations: [{ pd_si: '400000000', bi_si: '100000000' }],
    });
    expect(profile.warnings).toEqual([]);
  });
});

describe('buildExposureProfile — one premium basis (F11)', () => {
  // Adding a single location used to flip the premium from the risk header
  // total onto the location total with no warning. It still changes the
  // basis — locations are better data — but the profile now says so, and
  // the share and the total always move together.
  it('names the basis it used so the change is visible', () => {
    const header = buildExposureProfile({ risk: RISK });
    const located = buildExposureProfile({
      risk: RISK, locations: [{ pd_si: '10000000', bi_si: '0' }],
    });
    expect(header.basis).toBe('RISK_HEADER');
    expect(located.basis).toBe('LOCATIONS');
    expect(located.total_si).toBe(10_000_000);
    expect(located.pd_si_share).toBe(1);
  });
});
