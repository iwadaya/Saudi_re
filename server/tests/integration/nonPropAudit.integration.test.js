// server/tests/integration/nonPropAudit.integration.test.js
//
// P1-validation — non-prop route group, slice 2 (routes/nonProp.js).
// nonProp.js already validated + (mostly) locked its NP saves but wrote NO audit
// on ANY route. This slice:
//   • adds a `critical` in-transaction audit event to every mutating NP route
//     (treaty audits land in contract_audit_event, quote audits in audit_log),
//   • completes optimistic locking on the routes that lacked it (egnpi-year,
//     excess-ldfs, the generated large/cat-loss -ldfs, historical-performance,
//     stop-loss-pricing),
//   • closes the validation gap on the two generated `-ldfs` routes.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: non-prop saves — audit + locking + ldfs validation', () => {
  let harness;
  let treatyRefs;
  let quoteRefs;
  const contracts = [];
  const quotes = [];

  async function newNpContract() {
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...treatyRefs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01' },
    }).then((r) => r.json());
    contracts.push(c.contract_id);
    return c.contract_id;
  }

  async function newNpQuote() {
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...quoteRefs, uw_year: 2026, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    quotes.push(q.quote_id);
    return q.quote_id;
  }

  const contractUpdatedAt = async (id) => (await harness.fetchApp('GET', `/api/treaties/${id}`).then((r) => r.json())).updated_at;

  async function contractAudit(id, eventType) {
    const { rows } = await pool.query(
      `SELECT actor, payload FROM public.contract_audit_event WHERE contract_id=$1 AND event_type=$2`,
      [id, eventType],
    );
    return rows;
  }
  async function quoteAudit(id, eventType) {
    const { rows } = await pool.query(
      `SELECT actor, payload FROM public.audit_log WHERE entity_type='QUOTE' AND entity_id=$1 AND event_type=$2`,
      [id, eventType],
    );
    return rows;
  }

  beforeAll(async () => {
    harness = await bootApp();
    treatyRefs = await seedRefs({ category: 'NON_PROPORTIONAL' });
    quoteRefs = await seedRefs({ category: 'NON_PROPORTIONAL' });
  });

  afterAll(async () => {
    if (harness) {
      for (const id of quotes) { try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {} }
      for (const id of contracts) { try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {} }
      await harness.close();
    }
    await closePools();
  });

  const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

  // ── Treaty NP saves → contract_audit_event ────────────────────────────────

  it('every treaty NP save writes a critical audit event to contract_audit_event', async () => {
    const id = await newNpContract();
    await harness.fetchApp('POST', `/api/treaties/${id}/non-prop/save`, { body: { detail: { number_of_layers: 1, est_gnpi: 5_000_000 } } });
    await harness.fetchApp('PUT', `/api/treaties/${id}/np/egnpi-year`, { body: { rows: [{ uw_year: 2024, egnpi: 1_000_000 }] } });
    await harness.fetchApp('PUT', `/api/treaties/${id}/np-pricing`, { body: { outputs: [{ layer_number: 1, section: 'RISK', total_price: 10 }] } });
    await harness.fetchApp('PUT', `/api/treaties/${id}/np/excess-ldfs`, { body: { factors: [{ dev_month: 12, chosen_ldf: 1.2, chosen_cdf: 1.5 }] } });
    await harness.fetchApp('PUT', `/api/treaties/${id}/np/large-loss-ldfs`, { body: { ldfs: [{ dev_month: 12, chosen_ldf: 1.2, chosen_cdf: 1.5 }], ultimates: [{ year: 2024, count: 3, reported: 100, cdf: 1.5, ibnr: 50, ultimate: 150 }] } });
    await harness.fetchApp('PUT', `/api/treaties/${id}/np/historical-performance`, { body: { rows: [{ uw_year: 2024, premiums: 1000, claims: 400 }] } });
    await harness.fetchApp('PUT', `/api/treaties/${id}/np/stop-loss-pricing`, { body: { inputs: { attachment: 100 } } });

    const expected = [
      'NP_SAVED', 'NP_EGNPI_SAVED', 'NP_PRICING_SAVED', 'NP_EXCESS_LDFS_SAVED',
      'NP_LARGE_LOSS_LDFS_SAVED', 'NP_HISTORICAL_PERF_SAVED', 'NP_STOP_LOSS_PRICING_SAVED',
    ];
    for (const evt of expected) {
      const rows = await contractAudit(id, evt);
      expect(rows.length, `expected one ${evt}`).toBe(1);
      expect(rows[0].actor).toBe(DEMO_USER_ID);
    }
  });

  // ── Quote NP save (shared handler) → audit_log ────────────────────────────

  it('a quote -ldfs save writes its audit to audit_log under the QUOTE entity', async () => {
    const id = await newNpQuote();
    const res = await harness.fetchApp('PUT', `/api/quotes/${id}/np/cat-loss-ldfs`, {
      body: { ldfs: [{ dev_month: 12, chosen_ldf: 1.1, chosen_cdf: 1.3 }] },
    });
    expect(res.status).toBe(200);
    const rows = await quoteAudit(id, 'NP_CAT_LOSS_LDFS_SAVED');
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe(DEMO_USER_ID);
  });

  // ── Validation gap closed on the generated -ldfs routes ───────────────────

  it('the -ldfs routes now reject a malformed body with 400 VALIDATION_FAILED', async () => {
    const id = await newNpContract();
    const res = await harness.fetchApp('PUT', `/api/treaties/${id}/np/large-loss-ldfs`, {
      body: { ldfs: [{ dev_month: 99999 }] }, // dev_month exceeds the 0..600 cap
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
  });

  // ── Locking completed on a previously-unlocked route ──────────────────────

  it('egnpi-year (treaty) now honours If-Unmodified-Since — stale token → 409', async () => {
    const id = await newNpContract();
    const t0 = await contractUpdatedAt(id);
    // Sibling save (no header) bumps the contract's updated_at past t0.
    await harness.fetchApp('POST', `/api/treaties/${id}/non-prop/save`, { body: { detail: { number_of_layers: 1 } } });
    const stale = await harness.fetchApp('PUT', `/api/treaties/${id}/np/egnpi-year`, {
      body: { rows: [{ uw_year: 2024, egnpi: 1 }] }, headers: { 'if-unmodified-since': t0 },
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('STALE_WRITE');
  });

  it('egnpi-year (treaty) against a non-existent contract → 404', async () => {
    const res = await harness.fetchApp('PUT', '/api/treaties/00000000-0000-0000-0000-0000000000ff/np/egnpi-year', { body: { rows: [] } });
    expect(res.status).toBe(404);
  });
});
