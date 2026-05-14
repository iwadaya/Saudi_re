// Unit tests for the World Bank Open Data client.
//
// The real API returns [meta, [{date, value}, ...]] per indicator;
// our client fetches multiple indicators in parallel and normalises
// each into a `latest_value` + `series` slice.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWorldBankSnapshot } from './worldBankClient.js';

let fetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({
    ok: true,
    json: async () => fakeWB(url),
  }));
});
afterEach(() => { fetchSpy.mockRestore(); });

// Generates a deterministic World Bank-shape response per indicator
// so we can assert latest selection across a known series.
function fakeWB(url) {
  // Pull the indicator code out of the URL so each call returns a
  // unique series + we can prove the right indicator was hit.
  const m = String(url).match(/\/indicator\/([^?]+)/);
  const code = m?.[1] || 'UNKNOWN';
  return [
    { page: 1, total: 3 },
    [
      { date: '2024', value: code === 'SP.POP.TOTL' ? 56000000 : 7.2 },
      { date: '2023', value: null },
      { date: '2022', value: code === 'SP.POP.TOTL' ? 54000000 : 6.5 },
    ],
  ];
}

describe('fetchWorldBankSnapshot', () => {
  it('returns null on missing country code', async () => {
    expect(await fetchWorldBankSnapshot({})).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches each indicator and picks the most recent non-null value', async () => {
    const snap = await fetchWorldBankSnapshot({ countryCode: 'KE' });
    expect(snap).not.toBeNull();
    expect(snap.source).toBe('WORLD_BANK');
    expect(snap.country_code).toBe('KE');

    const pop = snap.indicators.population;
    expect(pop.latest_value).toBe(56000000);
    expect(pop.latest_year).toBe(2024);
    // Series excludes the null but preserves both real years
    expect(pop.series.map(s => s.year)).toContain(2022);
    expect(pop.series.map(s => s.year)).toContain(2024);

    // Inflation comes from a different indicator code
    expect(snap.indicators.inflation_cpi.latest_value).toBeCloseTo(7.2, 5);
  });

  it('upper-cases the country code in the URL', async () => {
    await fetchWorldBankSnapshot({ countryCode: 'ke' });
    const urls = fetchSpy.mock.calls.map(c => c[0]);
    for (const url of urls) expect(url).toMatch(/\/country\/KE\//);
  });

  it('non-2xx response yields a per-indicator empty entry, not a throw', async () => {
    fetchSpy.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const snap = await fetchWorldBankSnapshot({ countryCode: 'KE' });
    expect(snap).not.toBeNull();
    for (const k of Object.keys(snap.indicators)) {
      expect(snap.indicators[k].latest_value).toBeNull();
      expect(snap.indicators[k].series).toEqual([]);
    }
  });
});
