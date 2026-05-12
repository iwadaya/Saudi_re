// server/tests/integration/treaties.integration.test.js
//
// Mirror of quotes.integration.test.js for the treaty (contract)
// lifecycle. Keeps the two tracks in lock-step so schema or wire
// drift between them fails loudly.
//
// Exercises:
//   • POST   /api/treaties
//   • PUT    /api/treaties/:id (Zod-validated body)
//   • GET    /api/treaties/:id
//   • GET    /api/treaties (pagination + filter headers)
//   • 400   VALIDATION_FAILED with fields[]
//   • 409   STALE_WRITE via If-Unmodified-Since
//   • DELETE /api/treaties/:id (best-effort cleanup)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

function dateInRiyadh(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

describe.skipIf(shouldSkipDb)('integration: /api/treaties end-to-end', () => {
  let harness;
  const created = [];

  beforeAll(async () => { harness = await bootApp(); });
  afterAll(async () => {
    if (harness) {
      for (const id of created) {
        try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {}
      }
      await harness.close();
    }
    await closePools();
  });

  it('creates → partial-saves → reads back the same values', async () => {
    // CREATE
    const createRes = await harness.fetchApp('POST', '/api/treaties', {
      body: { uw_year: 2026, status: 'DRAFT', experience_source: 'TRIANGLE' },
    });
    expect(createRes.status).toBe(201);
    const c = await createRes.json();
    expect(c.contract_id).toBeTruthy();
    created.push(c.contract_id);

    // PUT partial — header slice only
    const patch = await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}`, {
      body: {
        terms: {
          header: {
            uw_year: 2027,
            uw_status: 'DRAFT',
            contract_description: 'treaty-integration-test',
            inception_date: '2027-03-15',
          },
        },
      },
    });
    expect(patch.status).toBe(200);

    // GET back — confirm round-trip
    const get = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}`);
    expect(get.status).toBe(200);
    const loaded = await get.json();
    // The treaty GET returns flat fields, not a header slice (mirrors the
    // actual endpoint's shape). Verify the fields we patched landed.
    expect(loaded.header.uw_year).toBe(2027);
    expect(loaded.header.contract_description).toBe('treaty-integration-test');
    expect(dateInRiyadh(loaded.header.inception_date)).toBe('2027-03-15');
  });

  it('rejects an invalid status enum with 400 + fields[]', async () => {
    const bad = await harness.fetchApp('PUT', '/api/treaties/00000000-0000-0000-0000-000000000000', {
      body: { terms: { header: { uw_year: 2026, uw_status: 'SOMETIMES' } } },
    });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields.some((f) => f.path.includes('uw_status'))).toBe(true);
  });

  it('list endpoint returns the standard pagination headers', async () => {
    const res = await harness.fetchApp('GET', '/api/treaties?limit=3');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-total-count')).toMatch(/^\d+$/);
    expect(res.headers.get('x-page-size')).toBe('3');
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it('list honours the status filter', async () => {
    // Create a SIGNED treaty to ensure at least one row matches
    const signed = await harness.fetchApp('POST', '/api/treaties', {
      body: { uw_year: 2025, uw_status: 'SIGNED' },
    }).then((r) => r.json());
    created.push(signed.contract_id);

    const res = await harness.fetchApp('GET', '/api/treaties?status=SIGNED&limit=50');
    expect(res.status).toBe(200);
    const rows = await res.json();
    // Every returned row must match the filter
    for (const row of rows) {
      expect(row.uw_status).toBe('SIGNED');
    }
    // And the one we just created must be in there
    expect(rows.some((r) => r.contract_id === signed.contract_id)).toBe(true);
  });

  it('honours If-Unmodified-Since — stale timestamp → 409 STALE_WRITE', async () => {
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { uw_year: 2026 },
    }).then((r) => r.json());
    created.push(c.contract_id);

    const first = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}`).then((r) => r.json());
    const staleTs = first.updated_at;

    await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}`, {
      body: { terms: { header: { contract_description: 'bump 1' } } },
    });

    const stale = await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}`, {
      headers: { 'if-unmodified-since': staleTs },
      body: { terms: { header: { contract_description: 'bump 2' } } },
    });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.code).toBe('STALE_WRITE');
  });

  it('supports two-session stale override and records STALE_WRITE_OVERRIDE', async () => {
    const c = await harness.fetchApp('POST', '/api/treaties', {
      body: { uw_year: 2026 },
    }).then((r) => r.json());
    created.push(c.contract_id);

    const sessionBRead = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}`).then((r) => r.json());
    const staleTs = sessionBRead.updated_at;

    const sessionA = await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}`, {
      body: { terms: { _actor: 'Alice Underwriter', header: { contract_description: 'session A save' } } },
    });
    expect(sessionA.status).toBe(200);

    const staleAttempt = await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}`, {
      headers: { 'if-unmodified-since': staleTs },
      body: { terms: { _actor: 'Bob Underwriter', header: { contract_description: 'session B stale save' } } },
    });
    expect(staleAttempt.status).toBe(409);
    await expect(staleAttempt.json()).resolves.toMatchObject({ code: 'STALE_WRITE' });

    const override = await harness.fetchApp('PUT', `/api/treaties/${c.contract_id}`, {
      headers: { 'if-unmodified-since': '*' },
      body: { terms: { _actor: 'Bob Underwriter', header: { contract_description: 'session B override' } } },
    });
    expect(override.status).toBe(200);
    await expect(override.json()).resolves.toMatchObject({ ok: true, contract_id: c.contract_id });

    const loaded = await harness.fetchApp('GET', `/api/treaties/${c.contract_id}`).then((r) => r.json());
    expect(loaded.header.contract_description).toBe('session B override');

    const { rows } = await pool.query(
      `SELECT event_type,actor,payload
         FROM public.contract_audit_event
        WHERE contract_id=$1 AND event_type='STALE_WRITE_OVERRIDE'
        ORDER BY created_at DESC
        LIMIT 1`,
      [c.contract_id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('Bob Underwriter');
    expect(rows[0].payload).toMatchObject({
      overwrittenBy: 'Bob Underwriter',
      previousActor: 'Alice Underwriter',
      overrideHeader: 'If-Unmodified-Since: *',
    });
  });
});
