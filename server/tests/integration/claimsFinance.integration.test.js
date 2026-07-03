// server/tests/integration/claimsFinance.integration.test.js
//
// Claims + Finance modules, end-to-end over HTTP against real Postgres:
//   bind a signed quote → finance_treaty_entry appears atomically (source BIND,
//   EPI × line snapshot) → claim booked against the bound contract (opening
//   ADVICE movement, our-share maths) → cumulative PAYMENT restatement →
//   close (CLOSURE zeroes OS) → 422 movement-on-closed → reopen (OS stays 0)
//   → note → finance claims rollup → acknowledge → 422 double-acknowledge,
// plus the audit_log trail for every step.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, closePools, shouldSkipDb } from './helpers.js';
import { pool } from '../../src/db/pool.js';

// Unique uw_year sentinel for cleanup; offset from quoteBind's 2100+(pid%90)
// band so parallel workers with adjacent pids don't collide.
const UW_YEAR = 2000 + (process.pid % 90);
const SIGNED_LINE = 12.5;
const EPI = 4_000_000;

describe.skipIf(shouldSkipDb)('integration: claims + finance modules', () => {
  let harness;
  let refs;
  let contractId;   // SIGNED contract (bound from a quote) — claims target
  let draftId;      // DRAFT contract — claims must be rejected
  let entryId;      // finance_treaty_entry created by the bind push
  let claimId;

  const num = (v) => Number(v);
  const auditCount = async (entityType, entityId, eventType) => Number((await pool.query(
    `SELECT count(*) n FROM public.audit_log WHERE entity_type=$1 AND entity_id=$2 AND event_type=$3`,
    [entityType, entityId, eventType])).rows[0].n);

  beforeAll(async () => {
    harness = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });

    // A signed quote with pricing, bound into a SIGNED contract via the real
    // bind endpoint — the finance push runs inside that same transaction.
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: UW_YEAR, status: 'DRAFT', inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    await pool.query(`INSERT INTO public.quote_pricing_outputs (quote_id, epi) VALUES ($1,$2)`, [q.quote_id, EPI]);
    await pool.query(
      `UPDATE public.quote SET status='SIGNED', uw_status='SIGNED', signed_line_pct=$2, signed_at=now() WHERE quote_id=$1`,
      [q.quote_id, SIGNED_LINE]);
    const bind = await harness.fetchApp('POST', `/api/quotes/${q.quote_id}/bind`);
    expect(bind.status).toBe(201);
    contractId = (await bind.json()).contract_id;

    // A DRAFT contract to prove the SIGNED/BOUND gate.
    const d = await pool.query(
      `INSERT INTO public.contract (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, inception_date)
       VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01') RETURNING contract_id`,
      [refs.cedant_id, refs.broker_id, refs.country_id, refs.currency_id, refs.treaty_type_id, UW_YEAR]);
    draftId = d.rows[0].contract_id;
  });

  afterAll(async () => {
    try {
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

  it('bind pushed the contract into finance atomically with the EPI × line snapshot', async () => {
    const { rows } = await pool.query(
      `SELECT entry_id, source, status, signed_line_pct, epi_100, epi_our_share
         FROM public.finance_treaty_entry WHERE contract_id=$1`, [contractId]);
    expect(rows.length).toBe(1);
    entryId = rows[0].entry_id;
    expect(rows[0].source).toBe('BIND');
    expect(rows[0].status).toBe('PENDING_SETUP');
    expect(num(rows[0].signed_line_pct)).toBe(SIGNED_LINE);
    expect(num(rows[0].epi_100)).toBe(EPI);
    expect(num(rows[0].epi_our_share)).toBe(EPI * SIGNED_LINE / 100); // 500,000
    expect(await auditCount('FINANCE_ENTRY', entryId, 'PUSHED_TO_FINANCE')).toBe(1);

    // Visible through the finance API with contract context.
    const entry = await harness.fetchApp('GET', `/api/finance/entries/${entryId}`).then((r) => r.json());
    expect(entry.contract_id).toBe(contractId);
    expect(entry.uw_year).toBe(UW_YEAR);
    expect(entry.claims_count).toBe(0);
  });

  it('lists the bound contract as claims-eligible, but not the DRAFT one', async () => {
    const eligible = await harness.fetchApp('GET', '/api/claims/eligible-contracts').then((r) => r.json());
    const ids = eligible.map((c) => c.contract_id);
    expect(ids).toContain(contractId);
    expect(ids).not.toContain(draftId);
  });

  it('rejects a claim against a DRAFT contract with 422', async () => {
    const res = await harness.fetchApp('POST', '/api/claims', {
      body: { contract_id: draftId, loss_date: '2026-03-01' },
    });
    expect(res.status).toBe(422);
  });

  it('creates a claim with an opening ADVICE movement snapshotting the signed line', async () => {
    const res = await harness.fetchApp('POST', '/api/claims', {
      body: {
        contract_id: contractId, loss_date: '2026-03-01', loss_type: 'LARGE',
        insured_name: 'IT Insured', cedant_claim_ref: 'CED-1',
        gross_paid_100: 0, gross_os_100: 400_000, comment: 'Initial advice',
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    claimId = body.claim_id;
    expect(body.claim_ref).toMatch(/^CLM-\d{6}$/);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_CREATED')).toBe(1);

    const detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.status).toBe('OPEN');
    expect(detail.movements.length).toBe(1);
    expect(detail.movements[0].movement_type).toBe('ADVICE');
    expect(num(detail.movements[0].share_pct)).toBe(SIGNED_LINE);
    // Our-share maths on the latest position: 400,000 × 12.5% = 50,000.
    expect(num(detail.os_our_share)).toBe(50_000);
    expect(num(detail.incurred_our_share)).toBe(50_000);
  });

  it('books a cumulative PAYMENT restatement with correct our-share maths', async () => {
    const res = await harness.fetchApp('POST', `/api/claims/${claimId}/movements`, {
      body: { movement_type: 'PAYMENT', gross_paid_100: 250_000, gross_os_100: 150_000, comment: 'Partial payment' },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).movement_no).toBe(2);
    expect(await auditCount('CLAIM', claimId, 'MOVEMENT_BOOKED')).toBe(1);

    const detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    // Latest movement IS the position: paid 250,000 × 12.5% = 31,250.
    expect(num(detail.gross_paid_100)).toBe(250_000);
    expect(num(detail.paid_our_share)).toBe(31_250);
    expect(num(detail.os_our_share)).toBe(18_750);
    expect(num(detail.incurred_our_share)).toBe(50_000);
  });

  it('close zeroes OS, blocks further movements, reopen restates with OS = 0', async () => {
    const close = await harness.fetchApp('POST', `/api/claims/${claimId}/close`, { body: { reason: 'Settled' } });
    expect(close.status).toBe(200);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_CLOSED')).toBe(1);

    let detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.status).toBe('CLOSED');
    const closure = detail.movements.at(-1);
    expect(closure.movement_type).toBe('CLOSURE');
    expect(num(closure.gross_paid_100)).toBe(250_000); // paid preserved
    expect(num(closure.gross_os_100)).toBe(0);          // OS zeroed

    // Ledger is frozen while closed.
    const blocked = await harness.fetchApp('POST', `/api/claims/${claimId}/movements`, {
      body: { movement_type: 'PAYMENT', gross_paid_100: 260_000, gross_os_100: 0 },
    });
    expect(blocked.status).toBe(422);

    const reopen = await harness.fetchApp('POST', `/api/claims/${claimId}/reopen`, { body: { reason: 'Late development' } });
    expect(reopen.status).toBe(200);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_REOPENED')).toBe(1);

    detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.status).toBe('REOPENED');
    const reopened = detail.movements.at(-1);
    expect(reopened.movement_type).toBe('REOPEN');
    expect(num(reopened.gross_paid_100)).toBe(250_000);
    expect(num(reopened.gross_os_100)).toBe(0); // deliberately NOT resurrected
  });

  it('accepts working notes', async () => {
    const res = await harness.fetchApp('POST', `/api/claims/${claimId}/notes`, { body: { note: 'Adjuster appointed' } });
    expect(res.status).toBe(201);
    const detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.notes.some((n) => n.note === 'Adjuster appointed')).toBe(true);
  });

  it('surfaces the claim in the finance ledger rollup', async () => {
    const entry = await harness.fetchApp('GET', `/api/finance/entries/${entryId}`).then((r) => r.json());
    expect(entry.claims_count).toBe(1);
    expect(num(entry.paid_our_share)).toBe(31_250);
    expect(num(entry.os_our_share)).toBe(0); // reopen left OS at 0
  });

  it('acknowledges once (PENDING_SETUP → ACTIVE) and 422s a second acknowledge', async () => {
    const ack = await harness.fetchApp('POST', `/api/finance/entries/${entryId}/acknowledge`);
    expect(ack.status).toBe(200);
    expect((await ack.json()).status).toBe('ACTIVE');
    expect(await auditCount('FINANCE_ENTRY', entryId, 'FINANCE_ACKNOWLEDGED')).toBe(1);

    const again = await harness.fetchApp('POST', `/api/finance/entries/${entryId}/acknowledge`);
    expect(again.status).toBe(422);
  });

  it('claims summary and finance summary reflect the booked data', async () => {
    const cs = await harness.fetchApp('GET', '/api/claims/summary').then((r) => r.json());
    expect(cs.open_claims).toBeGreaterThanOrEqual(1);
    const fs = await harness.fetchApp('GET', '/api/finance/summary').then((r) => r.json());
    expect(fs.total_entries).toBeGreaterThanOrEqual(1);
    expect(fs.active).toBeGreaterThanOrEqual(1);
  });
});
