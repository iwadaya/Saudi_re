import { describe, it, expect } from 'vitest';
import { resolveYearsFromServer, sameYears } from './formatters';

// resolveYearsFromServer backs the fix for the inflation/premiums tables
// rendering empty on first mount when appState.npTreatyDetail isn't hydrated:
// the year range is derived from the fetched treaty payload instead.
describe('resolveYearsFromServer', () => {
  it('builds the experience-start → renewal range from the non-prop detail + header', () => {
    const np = { detail: { experience_start_year: 2018 } };
    const header = { renewal_date: '2024-01-01' };
    expect(resolveYearsFromServer(header, np, [])).toEqual([2018, 2019, 2020, 2021, 2022, 2023, 2024]);
  });

  it('reads camelCase detail under terms.treaty_detail and falls back to header uw_year', () => {
    const np = { terms: { treaty_detail: { experienceStartYear: 2022 } } };
    expect(resolveYearsFromServer({ uw_year: 2024 }, np, [])).toEqual([2022, 2023, 2024]);
  });

  it('unions any UW years present in saved EGNPI rows', () => {
    const np = { detail: { experience_start_year: 2023 } };
    const egnpiRows = [{ uw_year: 2021 }, { uwYear: 2024 }];
    expect(resolveYearsFromServer({ renewal_date: '2023-06-01' }, np, egnpiRows)).toEqual([2021, 2023, 2024]);
  });

  it('resolves the range from the np payload contract_header when the header is empty', () => {
    // Mirrors a failed/slow getContract: the separate contract header is gone,
    // but the non-prop payload still carries its own authoritative header, so
    // the range must still resolve (no "Waiting for years." dead-end).
    const np = { detail: {}, contract_header: { uw_year: 2022, renewal_date: '2024-01-01' } };
    expect(resolveYearsFromServer({}, np, [])).toEqual([2022, 2023, 2024]);
  });

  it('falls back to the contract_header inception year for a single-year range', () => {
    const np = { detail: {}, contract_header: { inception_date: '2023-03-01' } };
    expect(resolveYearsFromServer({}, np, [])).toEqual([2023]);
  });

  it('returns [] when nothing resolves a start year', () => {
    expect(resolveYearsFromServer({}, {}, [])).toEqual([]);
    expect(resolveYearsFromServer(null, null, null)).toEqual([]);
  });
});

describe('sameYears', () => {
  it('is true only for element-wise equal arrays', () => {
    expect(sameYears([2020, 2021], [2020, 2021])).toBe(true);
    expect(sameYears([2020], [2020, 2021])).toBe(false);
    expect(sameYears([2020, 2022], [2020, 2021])).toBe(false);
    expect(sameYears(null, [])).toBe(false);
  });
});
