// server/tests/integration/claimsPla.integration.test.js
//
// PLA (Preliminary Loss Advice) section of the Claims module, end-to-end over
// HTTP against real Postgres:
//   bind a signed quote → PLA logged against the bound contract (SIGNED/BOUND
//   gate proven with a DRAFT contract) → edit while PENDING → close / reopen
//   round-trip → convert to a claim (opening ADVICE movement seeded from the
//   estimate, signed line snapshot, our-share maths) → post-conversion
//   immutability (no edit / re-convert / close) → list filters + summary KPIs,
// plus the audit_log trail (entity_type CLAIM_PLA) for every step.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, closePools, shouldSkipDb } from './helpers.js';
import { pool } from '../../src/db/pool.js';

// Unique uw_year sentinel for cleanup; offset from claimsFinance's 2000+(pid%90)
// band so parallel workers with adjacent pids don't collide.
const UW_YEAR = 1900 + (process.pid % 90);
const SIGNED_LINE = 20;
const ESTIMATE = 800_000;

describe.skipIf(shouldSkipDb)('integration: claims PLA section', () => {
  let harness;
  let refs;
  let contractId; // SIGNED contract (bound from a quote) — PLA target
  let draftId;    // DRAFT contract — PLAs must be rejected
  let plaId;
  let claimId;    // claim created by the conversion

  const num = (v) => Number(v);
  const auditCount = async (entityType, entityId, eventType) => Number((await pool.query(
    `SELECT count(*) n FROM public.audit_log WHERE entity_type=$1 AND entity_id=$2 AND event_type=$3`,
    [entityType, entityId, eventType])).rows[0].n);

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });

    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: UW_YEAR, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    await pool.query(
      `UPDATE public.quote SET status='SIGNED', uw_status='SIGNED', signed_line_pct=$2, signed_at=now() WHERE quote_id=$1`,
      [q.quote_id, SIGNED_LINE]);
    const bind = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/bind`);
    expect(bind.status).toBe(201);
    contractId = (await bind.json()).contract_id;

    const d = await pool.query(
      `INSERT INTO public.contract (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, inception_date)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01') RETURNING contract_id`,
      [refs.cedant_id, refs.broker_id, refs.country_id, refs.currency_id, refs.treaty_type_id, UW_YEAR]);
    draftId = d.rows[0].contract_id;
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM public.preliminary_loss_advice WHERE contract_id IN (SELECT contract_id FROM public.contract WHERE uw_year=$1)`, [UW_YEAR]);
      await pool.query(`DELETE FROM public.claim WHERE contract_id IN (SELECT contract_id FROM public.contract WHERE uw_year=$1)`, [UW_YEAR]);
      await pool.query(`DELETE FROM public.finance_treaty_entry WHERE contract_id IN (SELECT contract_id FROM public.contract WHERE uw_year=$1)`, [UW_YEAR]);
      const { rows: cs } = await pool.query(`SELECT contract_id FROM public.contract WHERE uw_year=$1`, [UW_YEAR]);
      for (const r of cs) { try { await harness.fetchApp('DELETE', `/api/treaties/${r.contract_id}`); } catch { /* best-effort */ } }
      const { rows: qs } = await pool.query(`SELECT quote_id FROM public.quote WHERE uw_year=$1`, [UW_YEAR]);
      for (const r of qs) { try { await harness.fetchApp('DELETE', `/api/quotes/${r.quote_id}`); } catch { /* best-effort */ } }
    } catch { /* best-effort */ }
    if (harness) await harness.close();
    await closePools();
  });

  it('rejects a PLA against a DRAFT contract with 422', async () => {
    const res = await harness.fetchApp('POST', '/api/claims/plas', {
      body: { contract_id: draftId, loss_date: '2026-02-01' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CONTRACT_NOT_SIGNED');
  });

  it('logs a PLA against the bound contract with a PLA-nnnnnn ref and our-share estimate', async () => {
    const res = await harness.fetchApp('POST', '/api/claims/plas', {
      body: {
        contract_id: contractId, loss_date: '2026-02-01', advice_date: '2026-02-10',
        loss_type: 'LARGE', insured_name: 'PLA Insured', cedant_claim_ref: 'CED-PLA-1',
        cause_of_loss: 'Fire', estimated_gross_loss_100: ESTIMATE,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    plaId = body.pla_id;
    expect(body.pla_ref).toMatch(/^PLA-\d{6}$/);
    expect(await auditCount('CLAIM_PLA', plaId, 'PLA_CREATED')).toBe(1);

    const detail = await harness.fetchApp('GET', `/api/claims/plas/${plaId}`).then((r) => r.json());
    expect(detail.status).toBe('PENDING');
    expect(num(detail.estimated_gross_loss_100)).toBe(ESTIMATE);
    // Our-share estimate at the signed line: 800,000 × 20% = 160,000.
    expect(num(detail.estimated_our_share)).toBe(ESTIMATE * SIGNED_LINE / 100);
    expect(num(detail.contract_signed_line_pct)).toBe(SIGNED_LINE);
    expect(detail.converted_claim_id).toBeNull();
  });

  it('edits a PENDING PLA', async () => {
    const res = await harness.fetchApp('PUT', `/api/claims/plas/${plaId}`, {
      body: { estimated_gross_loss_100: ESTIMATE + 200_000, description: 'Adjuster first estimate' },
    });
    expect(res.status).toBe(200);
    expect(await auditCount('CLAIM_PLA', plaId, 'PLA_UPDATED')).toBe(1);
    const detail = await harness.fetchApp('GET', `/api/claims/plas/${plaId}`).then((r) => r.json());
    expect(num(detail.estimated_gross_loss_100)).toBe(ESTIMATE + 200_000);
    expect(detail.description).toBe('Adjuster first estimate');
  });

  it('close → reopen round-trip; a CLOSED PLA is frozen and cannot convert', async () => {
    const close = await harness.fetchApp('POST', `/api/claims/plas/${plaId}/close`, { body: { reason: 'Below retention' } });
    expect(close.status).toBe(200);
    expect(await auditCount('CLAIM_PLA', plaId, 'PLA_CLOSED')).toBe(1);
    let detail = await harness.fetchApp('GET', `/api/claims/plas/${plaId}`).then((r) => r.json());
    expect(detail.status).toBe('CLOSED');
    expect(detail.closed_reason).toBe('Below retention');

    // CLOSED is frozen: no edits, no conversion, no double-close.
    expect((await harness.fetchApp('PUT', `/api/claims/plas/${plaId}`, { body: { insured_name: 'X' } })).status).toBe(422);
    const badConvert = await harness.fetchApp('POST', `/api/claims/plas/${plaId}/convert`, { body: {} });
    expect(badConvert.status).toBe(422);
    expect((await badConvert.json()).code).toBe('PLA_NOT_PENDING');
    expect((await harness.fetchApp('POST', `/api/claims/plas/${plaId}/close`, { body: {} })).status).toBe(422);

    const reopen = await harness.fetchApp('POST', `/api/claims/plas/${plaId}/reopen`, { body: { reason: 'Loss developing' } });
    expect(reopen.status).toBe(200);
    expect(await auditCount('CLAIM_PLA', plaId, 'PLA_REOPENED')).toBe(1);
    detail = await harness.fetchApp('GET', `/api/claims/plas/${plaId}`).then((r) => r.json());
    expect(detail.status).toBe('PENDING');
    expect(detail.closed_at).toBeNull();
    expect(detail.closed_reason).toBeNull();
  });

  it('converts the PLA into a claim: header copied, estimate seeds the opening OS, line snapshotted', async () => {
    const res = await harness.fetchApp('POST', `/api/claims/plas/${plaId}/convert`, {
      body: { reported_date: '2026-03-01' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    claimId = body.claim_id;
    expect(body.status).toBe('CONVERTED');
    expect(body.claim_ref).toMatch(/^CLM-\d{6}$/);
    expect(await auditCount('CLAIM_PLA', plaId, 'PLA_CONVERTED')).toBe(1);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_CREATED')).toBe(1);

    // The PLA row links to its claim.
    const pla = await harness.fetchApp('GET', `/api/claims/plas/${plaId}`).then((r) => r.json());
    expect(pla.status).toBe('CONVERTED');
    expect(pla.converted_claim_id).toBe(claimId);
    expect(pla.converted_claim_ref).toBe(body.claim_ref);

    // The claim carries the PLA header and the estimate as opening OS.
    const claim = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(claim.status).toBe('OPEN');
    expect(claim.insured_name).toBe('PLA Insured');
    expect(claim.cedant_claim_ref).toBe('CED-PLA-1');
    expect(claim.loss_type).toBe('LARGE');
    expect(String(claim.reported_date).slice(0, 10)).toBe('2026-03-01');
    expect(claim.movements.length).toBe(1);
    expect(claim.movements[0].movement_type).toBe('ADVICE');
    expect(num(claim.movements[0].gross_paid_100)).toBe(0);
    expect(num(claim.movements[0].gross_os_100)).toBe(ESTIMATE + 200_000);
    expect(num(claim.movements[0].share_pct)).toBe(SIGNED_LINE);
    expect(claim.movements[0].comment).toBe(`Converted from ${pla.pla_ref}`);
    // Our-share maths: 1,000,000 × 20% = 200,000.
    expect(num(claim.incurred_our_share)).toBe((ESTIMATE + 200_000) * SIGNED_LINE / 100);
  });

  it('a CONVERTED PLA is terminal: no edit, re-convert, close, or reopen', async () => {
    expect((await harness.fetchApp('PUT', `/api/claims/plas/${plaId}`, { body: { insured_name: 'X' } })).status).toBe(422);
    expect((await harness.fetchApp('POST', `/api/claims/plas/${plaId}/convert`, { body: {} })).status).toBe(422);
    expect((await harness.fetchApp('POST', `/api/claims/plas/${plaId}/close`, { body: {} })).status).toBe(422);
    expect((await harness.fetchApp('POST', `/api/claims/plas/${plaId}/reopen`, { body: {} })).status).toBe(422);
  });

  it('convert can restate the opening position instead of using the estimate', async () => {
    const created = await harness.fetchApp('POST', '/api/claims/plas', {
      body: { contract_id: contractId, loss_date: '2026-04-01', estimated_gross_loss_100: 100_000 },
    }).then((r) => r.json());
    const res = await harness.fetchApp('POST', `/api/claims/plas/${created.pla_id}/convert`, {
      body: { gross_paid_100: 10_000, gross_os_100: 40_000, comment: 'Firm figures per cedant SOA' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const claim = await harness.fetchApp('GET', `/api/claims/${body.claim_id}`).then((r) => r.json());
    expect(num(claim.movements[0].gross_paid_100)).toBe(10_000);
    expect(num(claim.movements[0].gross_os_100)).toBe(40_000);
    expect(claim.movements[0].comment).toBe('Firm figures per cedant SOA');
  });

  it('list filters (status / loss_type / q) and summary KPIs reflect the register', async () => {
    // A second PENDING PLA so the pending rollup has something to sum.
    const pending = await harness.fetchApp('POST', '/api/claims/plas', {
      body: { contract_id: contractId, loss_date: '2026-05-01', loss_type: 'CAT', cat_event_ref: 'IT Storm', insured_name: 'Pending Insured', estimated_gross_loss_100: 50_000 },
    }).then((r) => r.json());

    const hit = (rows, id) => rows.some((p) => p.pla_id === id);
    const get = (qs) => harness.fetchApp('GET', `/api/claims/plas${qs}`).then((r) => r.json());

    expect(hit(await get('?status=CONVERTED'), plaId)).toBe(true);
    expect(hit(await get('?status=PENDING'), plaId)).toBe(false);
    expect(hit(await get('?status=PENDING'), pending.pla_id)).toBe(true);
    expect(hit(await get('?loss_type=CAT'), pending.pla_id)).toBe(true);
    expect(hit(await get('?loss_type=LARGE'), pending.pla_id)).toBe(false);
    expect(hit(await get(`?q=${pending.pla_ref}`), pending.pla_id)).toBe(true);
    expect(hit(await get('?q=Pending%20Insured'), pending.pla_id)).toBe(true);
    expect(hit(await get(`?contract_id=${contractId}`), pending.pla_id)).toBe(true);

    const s = await harness.fetchApp('GET', '/api/claims/plas/summary').then((r) => r.json());
    expect(s.total_plas).toBeGreaterThanOrEqual(3);
    expect(s.pending_plas).toBeGreaterThanOrEqual(1);
    expect(s.converted_plas).toBeGreaterThanOrEqual(2);
    expect(num(s.pending_estimated_100)).toBeGreaterThanOrEqual(50_000);
    expect(num(s.pending_estimated_our_share)).toBeGreaterThanOrEqual(50_000 * SIGNED_LINE / 100);
  });
});
