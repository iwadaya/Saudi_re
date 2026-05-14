// Unit tests for the IMF Datamapper client.
//
// IMF returns { values: { CODE: { ISO3: { '2024': v, '2025': v } } } }
// per indicator. The client splits past from forecast based on the
// current calendar year.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchImfSnapshot } from './imfClient.js';

let fetchSpy;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({
    ok: true,
    json: async () => fakeImf(url),
  }));
});
afterEach(() => { fetchSpy.mockRestore(); });

const cy = new Date().getUTCFullYear();

function fakeImf(url) {
  const m = String(url).match(/\/v1\/([^/]+)\/([^/?]+)/);
  const code = m?.[1] || 'X';
  const iso3 = m?.[2] || 'XXX';
  return {
    values: {
      [code]: {
        [iso3]: {
          [`${cy - 2}`]: 100,
          [`${cy - 1}`]: 110,
          [`${cy + 1}`]: 130,    // forecast
          [`${cy + 2}`]: 140,
        },
      },
    },
  };
}

describe('fetchImfSnapshot', () => {
  it('returns null without a country code', async () => {
    expect(await fetchImfSnapshot({})).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('separates latest historical from earliest forecast', async () => {
    const snap = await fetchImfSnapshot({ countryCodeIso3: 'KEN' });
    const ind = snap.indicators.gdp_usd_imf;
    expect(ind.latest_year).toBe(cy - 1);
    expect(ind.latest_value).toBe(110);
    expect(ind.forecast_year).toBe(cy + 1);
    expect(ind.forecast_value).toBe(130);
    expect(ind.series.length).toBe(4);
  });

  it('non-2xx falls back to empty per-indicator entries', async () => {
    fetchSpy.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const snap = await fetchImfSnapshot({ countryCodeIso3: 'KEN' });
    for (const k of Object.keys(snap.indicators)) {
      expect(snap.indicators[k].latest_value).toBeNull();
      expect(snap.indicators[k].forecast_value).toBeNull();
    }
  });

  it('upper-cases the iso3 code in the URL', async () => {
    await fetchImfSnapshot({ countryCodeIso3: 'ken' });
    const urls = fetchSpy.mock.calls.map(c => c[0]);
    for (const url of urls) expect(url).toMatch(/\/KEN($|\?)/);
  });
});
