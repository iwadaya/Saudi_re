// server/src/lib/axcoClient.test.js
//
// Stubbed behaviour:
//   • Missing api key / codes → returns null (no fetch).
//   • Key set + base URL missing → throws a clear error.
//   • Key + URL set → fires a fetch and normalises the response.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { buildSnapshotUrl, normaliseSnapshot } from './axcoClient.js';

const envMock = { axcoApiKey: '', axcoBaseUrl: '' };
vi.mock('../config/env.js', () => ({
  get env() { return envMock; },
}));

// Re-import after mocking so the module sees our env proxy.
const { fetchMarketSnapshot } = await import('./axcoClient.js');

describe('axcoClient.fetchMarketSnapshot', () => {
  let fetchSpy;
  beforeEach(() => {
    envMock.axcoApiKey = '';
    envMock.axcoBaseUrl = '';
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('returns null when AXCO_API_KEY is not configured', async () => {
    const out = await fetchMarketSnapshot({ countryCode: 'SA', cobCode: 'PROP' });
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when country/cob codes are missing even with key', async () => {
    envMock.axcoApiKey = 'k';
    envMock.axcoBaseUrl = 'https://api.axcoinfo.com/v1';
    expect(await fetchMarketSnapshot({ countryCode: '',   cobCode: 'PROP' })).toBeNull();
    expect(await fetchMarketSnapshot({ countryCode: 'SA', cobCode: '' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when API key is set but base URL is missing', async () => {
    envMock.axcoApiKey = 'k';
    envMock.axcoBaseUrl = '';
    await expect(fetchMarketSnapshot({ countryCode: 'SA', cobCode: 'PROP' }))
      .rejects.toThrow(/AXCO_BASE_URL/);
  });

  it('fetches and normalises a typical Axco response', async () => {
    envMock.axcoApiKey = 'k';
    envMock.axcoBaseUrl = 'https://api.axcoinfo.com/v1';
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        regulator: { name: 'IA', recent_actions: ['New rule'] },
        leaders: [{ name: 'Carrier A', market_share_pct: 22, rating: 'A' }],
        statistics: {
          gross_written_premium: 783660000,
          currency: 'USD',
          year: 2024,
          loss_ratio_pct: 62,
          commission_pct: 25,
          retention_pct: 30,
          roe_pct: 12,
        },
        market_growth_pct: 7.5,
      }),
    });
    const snap = await fetchMarketSnapshot({ countryCode: 'SA', cobCode: 'PROP' });
    expect(snap).not.toBeNull();
    expect(snap.source).toBe('AXCO');
    expect(snap.axco_country_code).toBe('SA');
    expect(snap.axco_class_code).toBe('PROP');
    expect(snap.regulator.name).toBe('IA');
    expect(snap.top_carriers[0]).toMatchObject({
      name: 'Carrier A', market_share_pct: 22, am_best_rating: 'A',
    });
    expect(snap.market_size_premium).toMatchObject({
      value: 783660000, currency: 'USD', year: 2024,
    });
    expect(snap.market_growth_pct).toBe(7.5);
    expect(snap.benchmarks).toMatchObject({
      loss_ratio_pct: 62, commission_pct: 25, retention_pct: 30, roe_pct: 12, year: 2024,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.axcoinfo.com/v1/markets/SA/classes/PROP/snapshot',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Authorization': 'Bearer k',
          'Accept': 'application/json',
        }),
      }),
    );
  });

  it('returns null on non-2xx response (graceful fallback)', async () => {
    envMock.axcoApiKey = 'k';
    envMock.axcoBaseUrl = 'https://api.axcoinfo.com/v1';
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const snap = await fetchMarketSnapshot({ countryCode: 'SA', cobCode: 'PROP' });
    expect(snap).toBeNull();
  });

  it('returns null on network error (graceful fallback)', async () => {
    envMock.axcoApiKey = 'k';
    envMock.axcoBaseUrl = 'https://api.axcoinfo.com/v1';
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const snap = await fetchMarketSnapshot({ countryCode: 'SA', cobCode: 'PROP' });
    expect(snap).toBeNull();
  });
});

describe('axcoClient.normaliseSnapshot', () => {
  it('passthroughs a v1-shape payload and stamps fresh metadata', () => {
    const v1 = {
      source: 'AXCO',
      benchmarks: { loss_ratio_pct: 60, commission_pct: 20, retention_pct: 25, roe_pct: 10, year: 2024 },
      regulator: { name: 'X', recent_actions: [] },
      top_carriers: [],
      market_size_premium: null,
      market_growth_pct: null,
      commentary: null,
    };
    const out = normaliseSnapshot({ raw: v1, countryCode: 'KE', cobCode: 'MTR' });
    expect(out.axco_country_code).toBe('KE');
    expect(out.axco_class_code).toBe('MTR');
    expect(out.benchmarks.loss_ratio_pct).toBe(60);
    expect(out.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('coerces an Axco-shape payload to v1', () => {
    const out = normaliseSnapshot({
      raw: {
        regulator: 'CMA',
        statistics: { gross_written_premium: 500000000, currency: 'USD', year: 2024, loss_ratio_pct: 65 },
      },
      countryCode: 'KE',
      cobCode: 'PROP',
    });
    expect(out.regulator.name).toBe('CMA');
    expect(out.market_size_premium.value).toBe(500000000);
    expect(out.benchmarks.loss_ratio_pct).toBe(65);
  });
});

describe('axcoClient.buildSnapshotUrl', () => {
  it('encodes parts and strips trailing slash from base', () => {
    expect(buildSnapshotUrl({ baseUrl: 'https://api.axcoinfo.com/v1/', countryCode: 'SA', cobCode: 'PROP MAR' }))
      .toBe('https://api.axcoinfo.com/v1/markets/SA/classes/PROP%20MAR/snapshot');
  });
});
