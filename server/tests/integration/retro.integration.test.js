// server/tests/integration/retro.integration.test.js
//
// Retro module, end-to-end over HTTP against real Postgres:
//   permissions gate (RM / exec can manage, underwriter cannot) →
//   programme create with class + country scope → duplicate 409 →
//   list + detail → update (terms + scope replacement) →
//   coverage grid (inwards contract cell picks up the ACTIVE programme,
//   out-of-scope cell does not, DRAFT programme is invisible) →
//   summary → delete cascade, plus the audit_log trail.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, closePools, shouldSkipDb } from './helpers.js';
import { pool } from '../../src/db/pool.js';

// Unique uw_year sentinel for cleanup / grid isolation; distinct band from
// claimsFinance (2000+) and quoteBind (2100+).
const UW_YEAR = 1991 + (process.pid % 9);

describe.skipIf(shouldSkipDb)('integration: retro module', () => {
  let harness;
  let refs;          // in-scope country etc.
  let otherRefs;     // out-of-scope country
  let cobA;          // in-scope class
  let cobB;          // out-of-scope class
  let progId;        // the ACTIVE programme under test
  let contractId;    // inwards contract in (refs.country, cobA)

  const rm = { 'x-user-role': 'RM', 'x-user-id': '00000000-0000-0000-0000-000000000001' };
  const uw = { 'x-user-role': 'TUW', 'x-user-id': '00000000-0000-0000-0000-000000000002' };

  const auditCount = async (entityId, eventType) => Number((await pool.query(
    `SELECT count(*) n FROM public.audit_log WHERE entity_type='RETRO_PROGRAMME' AND entity_id=$1 AND event_type=$2`,
    [entityId, eventType])).rows[0].n);

  beforeAll(async () => {
    harness = await bootApp();
    [refs, otherRefs] = await Promise.all([seedRefs(), seedRefs()]);
    const suffix = `${Date.now()}-${process.pid}`;
    const { rows: cobs } = await pool.query(
      `INSERT INTO public.class_of_business (class_of_business, is_active)
       VALUES ($1,false), ($2,false) RETURNING class_of_business_id`,
      // is_active=false keeps IT rows out of live dropdowns (migration 141/142)
      [`IT Retro CobA ${suffix}`, `IT Retro CobB ${suffix}`]);
    cobA = cobs[0].class_of_business_id;
    cobB = cobs[1].class_of_business_id;

    // Inwards contract in (refs.country × cobA) with a prop capacity — the
    // coverage grid's subject cell.
    const create = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: UW_YEAR, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: `${UW_YEAR}-01-01` },
    });
    if (create.status !== 201) throw new Error(`treaty create failed: ${create.status} ${await create.text()}`);
    contractId = (await create.json()).contract_id;
    await pool.query(
      `UPDATE public.contract SET primary_class_of_business_id=$2, signed_line_pct=10 WHERE contract_id=$1`,
      [contractId, cobA]);
    await pool.query(
      `INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id) VALUES ($1,$2)`,
      [contractId, cobA]);
    await pool.query(
      `INSERT INTO public.contract_prop_details (contract_id, total_capacity) VALUES ($1, 80000000)`,
      [contractId]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM public.retro_programme WHERE uw_year=$1', [UW_YEAR]);
    if (contractId) {
      await pool.query('DELETE FROM public.contract_prop_details WHERE contract_id=$1', [contractId]);
      await pool.query('DELETE FROM public.contract_class_of_business WHERE contract_id=$1', [contractId]);
      await pool.query('DELETE FROM public.contract WHERE contract_id=$1', [contractId]);
    }
    await pool.query('DELETE FROM public.class_of_business WHERE class_of_business_id = ANY($1::uuid[])', [[cobA, cobB].filter(Boolean)]);
    await harness?.close();
    await closePools();
  });

  it('reports manage rights: RM and CU yes, underwriter no', async () => {
    expect((await harness.fetchApp('GET', '/api/retro/permissions', { headers: rm }).then((r) => r.json())).can_manage).toBe(true);
    expect((await harness.fetchApp('GET', '/api/retro/permissions').then((r) => r.json())).can_manage).toBe(true); // default CU
    expect((await harness.fetchApp('GET', '/api/retro/permissions', { headers: uw }).then((r) => r.json())).can_manage).toBe(false);
  });

  it('blocks non-managers from writing (403 RETRO_FORBIDDEN)', async () => {
    const res = await harness.fetchApp('POST', '/api/retro/programmes', {
      headers: uw,
      body: { uw_year: UW_YEAR, programme_name: 'Forbidden XL' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('RETRO_FORBIDDEN');
  });

  it('creates a programme with class + country scope', async () => {
    const res = await harness.fetchApp('POST', '/api/retro/programmes', {
      headers: rm,
      body: {
        uw_year: UW_YEAR, programme_name: 'Property Cat XL', programme_type: 'XL_CAT',
        status: 'ACTIVE', reinsurer: 'Global Re', currency_code: 'usd',
        attachment: '5,000,000', occurrence_limit: '20,000,000', aggregate_limit: 40000000,
        reinstatements: 1, rol_pct: 12.5, premium: 2500000,
        class_of_business_ids: [cobA], country_ids: [refs.country_id],
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    progId = body.retro_programme_id;
    expect(body.programme_name).toBe('Property Cat XL');
    expect(await auditCount(progId, 'RETRO_PROGRAMME_CREATED')).toBe(1);
  });

  it('rejects a duplicate (year, name) with 409', async () => {
    const res = await harness.fetchApp('POST', '/api/retro/programmes', {
      headers: rm,
      body: { uw_year: UW_YEAR, programme_name: 'Property Cat XL' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DUPLICATE_PROGRAMME');
  });

  it('lists by year with scope + pack counts; detail returns packs array', async () => {
    const list = await harness.fetchApp('GET', `/api/retro/programmes?year=${UW_YEAR}`).then((r) => r.json());
    const row = list.find((p) => p.retro_programme_id === progId);
    expect(row).toBeTruthy();
    expect(row.classes.map((c) => c.class_of_business_id)).toEqual([cobA]);
    expect(row.countries.map((c) => c.country_id)).toEqual([refs.country_id]);
    expect(row.packs_count).toBe(0);
    expect(Number(row.occurrence_limit)).toBe(20000000);

    const detail = await harness.fetchApp('GET', `/api/retro/programmes/${progId}`).then((r) => r.json());
    expect(detail.packs).toEqual([]);
    expect(detail.currency_code).toBe('USD');
  });

  it('updates terms and REPLACES scope when arrays are supplied', async () => {
    const res = await harness.fetchApp('PUT', `/api/retro/programmes/${progId}`, {
      headers: rm,
      body: { occurrence_limit: 25000000, class_of_business_ids: [cobA, cobB] },
    });
    expect(res.status).toBe(200);
    const detail = await harness.fetchApp('GET', `/api/retro/programmes/${progId}`).then((r) => r.json());
    expect(Number(detail.occurrence_limit)).toBe(25000000);
    expect(detail.classes.map((c) => c.class_of_business_id).sort()).toEqual([cobA, cobB].sort());
    // Countries untouched (array not supplied).
    expect(detail.countries.map((c) => c.country_id)).toEqual([refs.country_id]);
    expect(await auditCount(progId, 'RETRO_PROGRAMME_UPDATED')).toBe(1);
  });

  it('coverage grid: the in-scope inwards cell shows the programme, out-of-scope does not, DRAFT is invisible', async () => {
    // A DRAFT whole-account programme must NOT appear anywhere in coverage.
    await harness.fetchApp('POST', '/api/retro/programmes', {
      headers: rm,
      body: {
        uw_year: UW_YEAR, programme_name: 'Draft WA XL', status: 'DRAFT',
        covers_all_classes: true, covers_all_countries: true, occurrence_limit: 999999999,
      },
    });

    const cov = await harness.fetchApp('GET', `/api/retro/coverage?year=${UW_YEAR}`).then((r) => r.json());
    expect(cov.year).toBe(UW_YEAR);
    const cell = cov.cells.find((x) => x.country_id === refs.country_id && x.class_of_business_id === cobA);
    expect(cell).toBeTruthy();
    expect(cell.contract_count).toBe(1);
    expect(cell.gross_limit_100).toBe(80000000);
    expect(cell.signed_exposure).toBeCloseTo(8000000, 2);   // 10% signed line
    expect(cell.has_retro).toBe(true);
    expect(cell.retro_limit).toBe(25000000);
    expect(cell.programmes.map((p) => p.programme_name)).toEqual(['Property Cat XL']);

    // No cell in the out-of-scope country picks the programme up.
    const stray = cov.cells.filter((x) => x.country_id === otherRefs.country_id && x.has_retro);
    expect(stray).toEqual([]);
  });

  it('coverage grid: covers_all flags widen a programme to every cell', async () => {
    await harness.fetchApp('POST', '/api/retro/programmes', {
      headers: rm,
      body: {
        uw_year: UW_YEAR, programme_name: 'WA Stop Loss', programme_type: 'STOP_LOSS',
        status: 'ACTIVE', covers_all_classes: true, covers_all_countries: true,
        occurrence_limit: 10000000,
      },
    });
    const cov = await harness.fetchApp('GET', `/api/retro/coverage?year=${UW_YEAR}`).then((r) => r.json());
    const cell = cov.cells.find((x) => x.country_id === refs.country_id && x.class_of_business_id === cobA);
    expect(cell.programmes.map((p) => p.programme_name).sort()).toEqual(['Property Cat XL', 'WA Stop Loss']);
    expect(cell.retro_limit).toBe(35000000);
  });

  it('summary rolls up the year', async () => {
    const s = await harness.fetchApp('GET', `/api/retro/summary?year=${UW_YEAR}`).then((r) => r.json());
    expect(s.total_programmes).toBe(3);
    expect(s.active).toBe(2);
    expect(s.draft).toBe(1);
    expect(Number(s.active_occurrence_limit)).toBe(35000000);
  });

  it('retro packs: upload → listed on detail → download → non-manager blocked → delete', async () => {
    const form = new FormData();
    form.append('file', new Blob(['placement slip body'], { type: 'text/plain' }), 'slip.txt');
    form.append('title', '2026 placement slip');
    const up = await harness.fetchApp('POST', `/api/retro/programmes/${progId}/packs`, { headers: rm, body: form });
    expect(up.status).toBe(201);
    const doc = await up.json();
    expect(doc.file_name).toBe('slip.txt');
    expect(await auditCount(progId, 'RETRO_PACK_UPLOADED')).toBe(1);

    const detail = await harness.fetchApp('GET', `/api/retro/programmes/${progId}`).then((r) => r.json());
    expect(detail.packs.map((d) => d.document_id)).toContain(doc.document_id);
    expect(detail.packs_count).toBe(1);

    const dl = await harness.fetchApp('GET', `/api/retro/packs/${doc.document_id}/download`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('placement slip body');

    // Underwriters can read packs but not remove them.
    const denied = await harness.fetchApp('DELETE', `/api/retro/packs/${doc.document_id}`, { headers: uw });
    expect(denied.status).toBe(403);

    const del = await harness.fetchApp('DELETE', `/api/retro/packs/${doc.document_id}`, { headers: rm });
    expect(del.status).toBe(200);
    expect((await harness.fetchApp('GET', `/api/retro/packs/${doc.document_id}/download`)).status).toBe(404);
    expect(await auditCount(progId, 'RETRO_PACK_DELETED')).toBe(1);
  });

  it('applicable: returns the ACTIVE programmes covering a contract (scope + covers-all), never DRAFT', async () => {
    const res = await harness.fetchApp('GET', `/api/retro/applicable?contract_id=${contractId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.uw_year).toBe(UW_YEAR);
    const names = body.programmes.map((p) => p.programme_name).sort();
    // 'Property Cat XL' matches on (cobA, refs.country); 'WA Stop Loss' via
    // covers-all; 'Draft WA XL' is DRAFT and must not appear.
    expect(names).toEqual(['Property Cat XL', 'WA Stop Loss']);
    const catXl = body.programmes.find((p) => p.programme_name === 'Property Cat XL');
    expect(Number(catXl.occurrence_limit)).toBe(25000000);
    expect(Number(catXl.attachment)).toBe(5000000);
    // Share-of-book data: our 80m contract is the whole in-scope book here.
    expect(Number(body.subject_exposure)).toBe(80000000);
    expect(body.subject_in_book).toBe(true);
    expect(Number(catXl.book_exposure)).toBe(80000000);
    expect(catXl.book_contracts).toBe(1);
  });

  it('applicable: book_exposure grows with every in-scope contract, so the client can scale to the treaty share', async () => {
    // A 240m sibling in the same (country × class) cell → book 320m, our share 25%.
    const sib = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...refs, uw_year: UW_YEAR, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: `${UW_YEAR}-01-01` },
    }).then((r) => r.json());
    try {
      await pool.query(
        'UPDATE public.contract SET primary_class_of_business_id=$2 WHERE contract_id=$1',
        [sib.contract_id, cobA]);
      await pool.query(
        'INSERT INTO public.contract_prop_details (contract_id, total_capacity) VALUES ($1, 240000000)',
        [sib.contract_id]);

      const body = await harness.fetchApp('GET', `/api/retro/applicable?contract_id=${contractId}`).then((r) => r.json());
      const catXl = body.programmes.find((p) => p.programme_name === 'Property Cat XL');
      expect(Number(body.subject_exposure)).toBe(80000000);
      expect(Number(catXl.book_exposure)).toBe(320000000);
      expect(catXl.book_contracts).toBe(2);
      // The covers-all programme sees the same book in this isolated year.
      const wa = body.programmes.find((p) => p.programme_name === 'WA Stop Loss');
      expect(Number(wa.book_exposure)).toBe(320000000);
    } finally {
      await pool.query('DELETE FROM public.contract_prop_details WHERE contract_id=$1', [sib.contract_id]);
      await pool.query('DELETE FROM public.contract WHERE contract_id=$1', [sib.contract_id]);
    }
  });

  it('applicable: a contract outside the scoped country only sees covers-all programmes', async () => {
    const stray = await harness.fetchApp('POST', '/api/treaties', {
      body: { ...otherRefs, uw_year: UW_YEAR, status: 'DRAFT', experience_source: 'TRIANGLE', inception_date: `${UW_YEAR}-01-01` },
    }).then((r) => r.json());
    try {
      const body = await harness.fetchApp('GET', `/api/retro/applicable?contract_id=${stray.contract_id}`).then((r) => r.json());
      expect(body.programmes.map((p) => p.programme_name)).toEqual(['WA Stop Loss']);
    } finally {
      await pool.query('DELETE FROM public.contract WHERE contract_id=$1', [stray.contract_id]);
    }
  });

  it('applicable: 400 without an id, 404 for an unknown contract', async () => {
    expect((await harness.fetchApp('GET', '/api/retro/applicable')).status).toBe(400);
    expect((await harness.fetchApp('GET', '/api/retro/applicable?contract_id=00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('delete removes the programme and its scope rows (cascade)', async () => {
    const res = await harness.fetchApp('DELETE', `/api/retro/programmes/${progId}`, { headers: rm });
    expect(res.status).toBe(200);
    expect((await harness.fetchApp('GET', `/api/retro/programmes/${progId}`)).status).toBe(404);
    const { rows } = await pool.query(
      'SELECT count(*)::int n FROM public.retro_programme_class WHERE retro_programme_id=$1', [progId]);
    expect(rows[0].n).toBe(0);
    expect(await auditCount(progId, 'RETRO_PROGRAMME_DELETED')).toBe(1);
  });
});
