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
// A second, real uw_user (seeded 'underwriter', level 4) to act as the approver
// so approvals are never self-approvals. Its id satisfies the reviewed_by FK.
const APPROVER_ID = '00000000-0000-0000-0000-000000000002';

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

  it('M1 — finance status: role-gated, state-machine enforced, no acknowledge bypass', async () => {
    const setStatus = (status, extra = {}) =>
      harness.fetchApp('POST', `/api/finance/entries/${entryId}/status`, { body: { status }, ...extra });

    // Below approver tier → 403 (was ungated: any underwriter could flip status).
    const junior = await setStatus('SUSPENDED', { headers: { 'x-user-level': '5' } });
    expect(junior.status).toBe(403);

    // Legal ACTIVE → SUSPENDED → ACTIVE round-trip (entry is ACTIVE from the ack).
    expect((await setStatus('SUSPENDED')).status).toBe(200);
    expect((await setStatus('ACTIVE')).status).toBe(200);

    // No-op (same status) is rejected.
    expect((await setStatus('ACTIVE')).status).toBe(422);

    // Cannot drive an entry back to PENDING_SETUP, and PENDING→ACTIVE is not a
    // /status path — that would bypass the acknowledge attribution.
    const illegal = await setStatus('PENDING_SETUP');
    expect(illegal.status).toBe(422);
    expect((await illegal.json()).code).toBe('ILLEGAL_FINANCE_TRANSITION');

    // Leaves the entry ACTIVE for downstream assertions.
    const cur = await harness.fetchApp('GET', `/api/finance/entries/${entryId}`).then((r) => r.json());
    expect(cur.status).toBe('ACTIVE');
  });

  it('approval workflow: claims start DRAFT and submit freezes the claim', async () => {
    let detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.approval_status).toBe('DRAFT');

    const submit = await harness.fetchApp('POST', `/api/claims/${claimId}/submit`, { body: {} });
    expect(submit.status).toBe(200);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_SUBMITTED')).toBe(1);
    detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.approval_status).toBe('WAITING_APPROVAL');
    expect(detail.submitted_at).toBeTruthy();

    // Frozen under review: no movements, edits, or lifecycle changes.
    const mv = await harness.fetchApp('POST', `/api/claims/${claimId}/movements`, {
      body: { movement_type: 'RESERVE_CHANGE', gross_paid_100: 250_000, gross_os_100: 100_000 },
    });
    expect(mv.status).toBe(422);
    const edit = await harness.fetchApp('PUT', `/api/claims/${claimId}`, { body: { insured_name: 'Changed' } });
    expect(edit.status).toBe(422);
    const close = await harness.fetchApp('POST', `/api/claims/${claimId}/close`, { body: {} });
    expect(close.status).toBe(422);
    // And a double-submit is an illegal transition.
    const again = await harness.fetchApp('POST', `/api/claims/${claimId}/submit`, { body: {} });
    expect(again.status).toBe(422);
  });

  it('approval workflow: reject returns it to the handler, resubmit + approve finalises', async () => {
    const reject = await harness.fetchApp('POST', `/api/claims/${claimId}/reject`, { body: { reason: 'Reserve unsupported' } });
    expect(reject.status).toBe(200);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_REJECTED')).toBe(1);
    let detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.approval_status).toBe('REJECTED');
    expect(detail.review_comment).toBe('Reserve unsupported');

    // Approve is only legal from WAITING_APPROVAL.
    const badApprove = await harness.fetchApp('POST', `/api/claims/${claimId}/approve`, { body: {} });
    expect(badApprove.status).toBe(422);

    // Rejected claims are editable again, then resubmit (as the default submitter).
    const edit = await harness.fetchApp('PUT', `/api/claims/${claimId}`, { body: { insured_name: 'IT Insured (revised)' } });
    expect(edit.status).toBe(200);
    expect((await harness.fetchApp('POST', `/api/claims/${claimId}/submit`, { body: {} })).status).toBe(200);

    // H1 — segregation of duties: the SUBMITTER cannot approve their own claim.
    const selfApprove = await harness.fetchApp('POST', `/api/claims/${claimId}/approve`, { body: { reason: 'me again' } });
    expect(selfApprove.status).toBe(403);
    expect((await selfApprove.json()).code).toBe('SELF_APPROVAL_FORBIDDEN');

    // H1 — approval needs an approver-tier actor; a below-threshold user is 403.
    const juniorApprove = await harness.fetchApp('POST', `/api/claims/${claimId}/approve`, {
      body: { reason: 'no authority' }, headers: { 'x-user-id': APPROVER_ID, 'x-user-level': '5' },
    });
    expect(juniorApprove.status).toBe(403);

    // A DIFFERENT approver (level ≤ 4) finalises it.
    const approve = await harness.fetchApp('POST', `/api/claims/${claimId}/approve`, {
      body: { reason: 'Looks right' }, headers: { 'x-user-id': APPROVER_ID, 'x-user-role': 'CU' },
    });
    expect(approve.status).toBe(200);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_SUBMITTED')).toBe(2);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_APPROVED')).toBe(1);

    detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.approval_status).toBe('FINALISED');
    expect(detail.reviewed_at).toBeTruthy();

    // H2 — a movement on a FINALISED claim restates the position, so the stale
    // approval drops back to DRAFT for re-review (the ledger still accepts it).
    const mv = await harness.fetchApp('POST', `/api/claims/${claimId}/movements`, {
      body: { movement_type: 'RESERVE_CHANGE', gross_paid_100: 250_000, gross_os_100: 100_000, comment: 'Reserve re-established' },
    });
    expect(mv.status).toBe(201);
    detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.approval_status).toBe('DRAFT');
    expect(detail.reviewed_at).toBeFalsy();

    // Re-review cycle restores FINALISED (submitter submits, approver approves).
    expect((await harness.fetchApp('POST', `/api/claims/${claimId}/submit`, { body: {} })).status).toBe(200);
    const reApprove = await harness.fetchApp('POST', `/api/claims/${claimId}/approve`, {
      body: { reason: 'Re-approved after restatement' }, headers: { 'x-user-id': APPROVER_ID, 'x-user-role': 'CU' },
    });
    expect(reApprove.status).toBe(200);
    detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.approval_status).toBe('FINALISED');
  });

  it('eligible-contracts supports the country → cedant cascade, UW-year filter, and search', async () => {
    await pool.query(
      `UPDATE public.contract SET contract_description='IT Motor XL Programme', alt_contract_id='ALT-IT-42' WHERE contract_id=$1`,
      [contractId]);

    const hit = (rows) => rows.some((c) => c.contract_id === contractId);
    const get = (qs) => harness.fetchApp('GET', `/api/claims/eligible-contracts${qs}`).then((r) => r.json());

    // Rows carry the cascade + search fields.
    const all = await get('');
    const mine = all.find((c) => c.contract_id === contractId);
    expect(mine.country_id).toBe(refs.country_id);
    expect(mine.cedant_id).toBe(refs.cedant_id);
    expect(mine.contract_description).toBe('IT Motor XL Programme');
    expect(mine.alt_contract_id).toBe('ALT-IT-42');

    expect(hit(await get(`?country_id=${refs.country_id}`))).toBe(true);
    expect(hit(await get('?country_id=00000000-0000-0000-0000-00000000dead'))).toBe(false);
    expect(hit(await get(`?cedant_id=${refs.cedant_id}`))).toBe(true);
    expect(hit(await get(`?uw_year=${UW_YEAR}`))).toBe(true);
    expect(hit(await get(`?uw_year=${UW_YEAR + 1}`))).toBe(false);
    // Search by contract id, alt id, and description.
    expect(hit(await get(`?q=${contractId}`))).toBe(true);
    expect(hit(await get('?q=ALT-IT-42'))).toBe(true);
    expect(hit(await get('?q=Motor%20XL'))).toBe(true);
    expect(hit(await get('?q=zzz-no-such-treaty'))).toBe(false);
    // Filters combine.
    expect(hit(await get(`?country_id=${refs.country_id}&cedant_id=${refs.cedant_id}&uw_year=${UW_YEAR}&q=Motor`))).toBe(true);
  });

  it('takes, serves, and deletes attachments (audited)', async () => {
    const form = new FormData();
    form.append('file', new Blob(['cedant advice body'], { type: 'text/plain' }), 'advice.txt');
    const up = await harness.fetchApp('POST', `/api/claims/${claimId}/documents`, { body: form });
    expect(up.status).toBe(201);
    const doc = await up.json();
    expect(doc.file_name).toBe('advice.txt');
    expect(await auditCount('CLAIM', claimId, 'CLAIM_DOCUMENT_UPLOADED')).toBe(1);

    // Listed on the claim detail.
    const detail = await harness.fetchApp('GET', `/api/claims/${claimId}`).then((r) => r.json());
    expect(detail.documents.length).toBe(1);
    expect(detail.documents[0].document_id).toBe(doc.document_id);

    // Served back with the original bytes.
    const dl = await harness.fetchApp('GET', `/api/claims/documents/${doc.document_id}/download`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('cedant advice body');
    expect(await auditCount('CLAIM', claimId, 'CLAIM_DOCUMENT_DOWNLOADED')).toBe(1);

    // Junk extensions are rejected before any persistence.
    const bad = new FormData();
    bad.append('file', new Blob(['#!/bin/sh'], { type: 'application/x-sh' }), 'evil.sh');
    const badRes = await harness.fetchApp('POST', `/api/claims/${claimId}/documents`, { body: bad });
    expect(badRes.status).toBe(415);

    // Delete removes the row and audits critically.
    const del = await harness.fetchApp('DELETE', `/api/claims/documents/${doc.document_id}`);
    expect(del.status).toBe(200);
    expect((await harness.fetchApp('GET', `/api/claims/documents/${doc.document_id}/download`)).status).toBe(404);
    expect(await auditCount('CLAIM', claimId, 'CLAIM_DOCUMENT_DELETED')).toBe(1);
  });

  it('dashboard summary carries the approval KPIs', async () => {
    const cs = await harness.fetchApp('GET', '/api/claims/summary').then((r) => r.json());
    for (const k of ['draft_claims', 'waiting_approval_claims', 'rejected_claims', 'finalised_claims', 'total_paid_our_share']) {
      expect(cs[k]).toBeDefined();
    }
    expect(cs.finalised_claims).toBeGreaterThanOrEqual(1);
    // The register filters by approval state.
    const finalised = await harness.fetchApp('GET', '/api/claims?approval_status=FINALISED').then((r) => r.json());
    expect(finalised.some((c) => c.claim_id === claimId)).toBe(true);
    const waiting = await harness.fetchApp('GET', '/api/claims?approval_status=WAITING_APPROVAL').then((r) => r.json());
    expect(waiting.some((c) => c.claim_id === claimId)).toBe(false);
  });
});
