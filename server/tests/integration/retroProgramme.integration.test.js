// server/tests/integration/retroProgramme.integration.test.js
//
// The admin-maintained outward retro contract (migration 140, routes/
// retroProgrammes.js). Covers the upsert-by-(year, currency) key the admin
// screen relies on, the lookup the offer modal's retro cover analysis calls,
// the level-2 write gate, and the deliberate absence of FX fallback — a
// programme placed in another currency is not this treaty's cover.
//
// Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

describe.skipIf(shouldSkipDb)('integration: retro programme', () => {
  let harness;
  // A year far enough out that no other fixture or seed owns it.
  const YEAR = 2189;
  const created = [];

  beforeAll(async () => { harness = await bootApp(); });

  afterAll(async () => {
    await pool.query('DELETE FROM public.retro_programme WHERE uw_year = $1', [YEAR]);
    await harness.close();
    await closePools();
  });

  const save = (body, opts = {}) => harness.fetchApp('POST', '/api/retro-programmes', { body, ...opts });

  const BASE = {
    uw_year: 2189, currency: 'USD', label: '2189 Cat XL Retro', reinsurer: 'Retro Re',
    retention_amt: 5000000, limit_amt: 45000000, rol_pct: 8,
    used_limit_amt: 0, cession_pct: 0, commission_pct: 25, max_line_pct: 25,
  };

  it('creates the year\'s programme and reads it back as numbers', async () => {
    const res = await save(BASE);
    expect(res.status).toBe(200);
    const { programme } = await res.json();
    created.push(programme.retro_programme_id);
    expect(programme).toMatchObject({
      uw_year: YEAR, currency: 'USD', retention_amt: 5000000, limit_amt: 45000000,
      rol_pct: 8, commission_pct: 25, max_line_pct: 25, is_active: true,
    });
    // Numerics come back as numbers, not the strings pg hands over.
    expect(typeof programme.retention_amt).toBe('number');
    expect(typeof programme.rol_pct).toBe('number');
  });

  it('upserts on (year, currency) rather than stacking rows', async () => {
    const res = await save({ ...BASE, rol_pct: 9.5, used_limit_amt: 12000000, notes: 'Q2 burn' });
    expect(res.status).toBe(200);
    const { programme } = await res.json();
    expect(programme.retro_programme_id).toBe(created[0]);
    expect(programme.rol_pct).toBe(9.5);
    expect(programme.used_limit_amt).toBe(12000000);
    expect(programme.notes).toBe('Q2 burn');

    const list = await harness.fetchApp('GET', `/api/retro-programmes?year=${YEAR}`).then((r) => r.json());
    expect(list.programmes).toHaveLength(1);
  });

  it('keeps a second currency as its own placement', async () => {
    const res = await save({ ...BASE, currency: 'sar', retention_amt: 20000000, limit_amt: 180000000 });
    expect(res.status).toBe(200);
    const { programme } = await res.json();
    expect(programme.currency).toBe('SAR');          // normalised by the schema
    created.push(programme.retro_programme_id);

    const list = await harness.fetchApp('GET', `/api/retro-programmes?year=${YEAR}`).then((r) => r.json());
    expect(list.programmes.map((p) => p.currency)).toEqual(['SAR', 'USD']);
  });

  it('looks up the exact (year, currency) the treaty is written in', async () => {
    const hit = await harness.fetchApp('GET', `/api/retro-programmes/lookup?year=${YEAR}&currency=USD`)
      .then((r) => r.json());
    expect(hit.programme.retro_programme_id).toBe(created[0]);
    expect(hit.availableCurrencies).toEqual(['SAR', 'USD']);
  });

  it('returns no programme — never an FX-converted one — for an unplaced currency', async () => {
    const miss = await harness.fetchApp('GET', `/api/retro-programmes/lookup?year=${YEAR}&currency=EUR`)
      .then((r) => r.json());
    expect(miss.programme).toBeNull();
    expect(miss.availableCurrencies).toEqual(['SAR', 'USD']);
  });

  it('returns no programme for a year nobody has captured yet', async () => {
    const miss = await harness.fetchApp('GET', `/api/retro-programmes/lookup?year=${YEAR - 1}&currency=USD`)
      .then((r) => r.json());
    expect(miss.programme).toBeNull();
    expect(miss.availableCurrencies).toEqual([]);
  });

  it('400s a lookup without a usable year and currency', async () => {
    expect((await harness.fetchApp('GET', '/api/retro-programmes/lookup?currency=USD')).status).toBe(400);
    expect((await harness.fetchApp('GET', `/api/retro-programmes/lookup?year=${YEAR}&currency=DOLLAR`)).status).toBe(400);
  });

  it('rejects a body the pricing maths could not use', async () => {
    expect((await save({ ...BASE, uw_year: '' })).status).toBe(400);           // year is the key
    expect((await save({ ...BASE, rol_pct: 140 })).status).toBe(400);          // not a rate on line
    expect((await save({ ...BASE, max_line_pct: 0 })).status).toBe(400);       // no line is writable
    expect((await save({ ...BASE, retention_amt: -1 })).status).toBe(400);
    expect((await save({ ...BASE, currency: 'US' })).status).toBe(400);
  });

  it('lets any authenticated user read but only level 2 write', async () => {
    const junior = { headers: { 'x-user-level': '5' } };
    const read = await harness.fetchApp('GET', `/api/retro-programmes?year=${YEAR}`, junior);
    expect(read.status).toBe(200);

    const write = await save({ ...BASE, rol_pct: 1 }, junior);
    expect(write.status).toBe(403);

    const del = await harness.fetchApp('DELETE', `/api/retro-programmes/${created[0]}`, junior);
    expect(del.status).toBe(403);
  });

  it('deletes a placement and 404s the second attempt', async () => {
    const id = created.pop();                        // the SAR row
    expect((await harness.fetchApp('DELETE', `/api/retro-programmes/${id}`)).status).toBe(200);
    expect((await harness.fetchApp('DELETE', `/api/retro-programmes/${id}`)).status).toBe(404);
    expect((await harness.fetchApp('DELETE', '/api/retro-programmes/not-a-uuid')).status).toBe(400);

    const list = await harness.fetchApp('GET', `/api/retro-programmes?year=${YEAR}`).then((r) => r.json());
    expect(list.programmes.map((p) => p.currency)).toEqual(['USD']);
  });

  it('writes an audit trail for the save', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM public.audit_log
        WHERE entity_type = 'RETRO_PROGRAMME' AND entity_id = $1
        ORDER BY created_at`,
      [created[0]],
    );
    expect(rows.map((r) => r.event_type)).toContain('RETRO_PROGRAMME_SAVED');
  });
});
