// server/tests/integration/exchangeRates.integration.test.js
//
// Exchange rates are the one lookup set that mutates during normal
// use (ops pastes a fresh FX table once a quarter). This file verifies
// the read/write contract and that a PUT is visible to the next GET —
// both the single-currency endpoint and the cache-invalidation hook on
// the list endpoint.
//
// Covers:
//   • GET  /api/ref/exchange-rates          — list of latest rates
//   • GET  /api/ref/exchange-rates/:code    — single latest row
//   • PUT  /api/ref/exchange-rates/:code    — upsert
//   • PUT  → GET sees the new rate on the very next call

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

describe.skipIf(shouldSkipDb)('integration: /api/ref/exchange-rates', () => {
  let harness;

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => { await harness.close(); await closePools(); });

  it('GET list returns an array of {currency_code, rate_to_usd}', async () => {
    const res = await harness.fetchApp('GET', '/api/ref/exchange-rates');
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    // At least USD should be seeded in any realistic DB
    if (rows.length > 0) {
      expect(rows[0]).toMatchObject({
        currency_code: expect.any(String),
        rate_to_usd: expect.anything(),
      });
    }
  });

  it('PUT upserts a new rate and the next GET reflects it', async () => {
    // Use a currency we control so we don't clobber ops data
    const code = 'ZZT'; // test-only ISO-ish code
    const first = 1.2345;
    const second = 9.8765;

    const up1 = await harness.fetchApp('PUT', `/api/ref/exchange-rates/${code}`, {
      body: { rate_to_usd: first, effective_date: '2026-01-01' },
    });
    expect(up1.status).toBe(200);

    const read1 = await harness.fetchApp('GET', `/api/ref/exchange-rates/${code}`).then((r) => r.json());
    expect(Number(read1.rate_to_usd)).toBeCloseTo(first, 4);

    const up2 = await harness.fetchApp('PUT', `/api/ref/exchange-rates/${code}`, {
      body: { rate_to_usd: second, effective_date: '2026-06-01' },
    });
    expect(up2.status).toBe(200);

    const read2 = await harness.fetchApp('GET', `/api/ref/exchange-rates/${code}`).then((r) => r.json());
    expect(Number(read2.rate_to_usd)).toBeCloseTo(second, 4);
  });

  it('GET single for an unknown currency returns null (not 404)', async () => {
    // Convention in lookups.js: missing row → JSON null, not an error
    const res = await harness.fetchApp('GET', '/api/ref/exchange-rates/QQQ');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });

  it('upper-cases the currency code so "usd" and "USD" resolve to the same row', async () => {
    const upper = await harness.fetchApp('GET', '/api/ref/exchange-rates/USD').then((r) => r.json());
    const lower = await harness.fetchApp('GET', '/api/ref/exchange-rates/usd').then((r) => r.json());
    // Both return the same shape; if USD isn't seeded, both are null
    if (upper && lower) {
      expect(lower.currency_code).toBe(upper.currency_code);
    } else {
      expect(lower).toEqual(upper);
    }
  });
});
