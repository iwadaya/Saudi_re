// server/tests/integration/pricingOfferGuards.integration.test.js
//
// Authority + state guards on the two offer-lifecycle mutations the audit
// flagged (F22/F29 and F23):
//
//   POST /api/treaties/:id/decline — DECLINED is terminal and unrecoverable, so
//   it takes the NTU authority rule: the contract's assignee OR a live eligible
//   approver. Any other authenticated user gets 403 and the state is untouched.
//
//   POST /api/treaties/:id/offer — replacing the contract_offer row is an
//   assignee edit, and it must never destroy in-flight approval state
//   (409 APPROVAL_IN_FLIGHT) nor resurrect a terminal/signed contract
//   (422 INVALID_TRANSITION).
//
// Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools, seedRefs } from './helpers.js';
import { pool } from '../../src/db/pool.js';

// Stable demo personas seeded by the migrations (037/132), used across the
// integration suite: CU is the demo Chief Underwriter, UW1 an underwriter.
const CU = '00000000-0000-0000-0000-000000000001';
const UW1 = '00000000-0000-0000-0000-000000000002';
const STRANGER = '00000000-0000-0000-0000-00000000dead'; // no relation to anything

const asUser = (id, role = 'UW') => ({ 'x-user-id': id, 'x-user-role': role });

describe.skipIf(shouldSkipDb)('integration: decline authority + saveOffer guards', () => {
  let harness;
  let refs;
  const created = [];

  beforeAll(async () => { harness = await bootApp(); refs = await seedRefs(); });

  afterAll(async () => {
    for (const id of created) {
      await pool.query('DELETE FROM public.offer_approval_event WHERE contract_id=$1', [id]).catch(() => {});
      await pool.query('DELETE FROM public.contract_workflow_event WHERE contract_id=$1', [id]).catch(() => {});
      await pool.query('DELETE FROM public.contract_audit_event WHERE contract_id=$1', [id]).catch(() => {});
      await pool.query('DELETE FROM public.contract_offer WHERE contract_id=$1', [id]).catch(() => {});
      await pool.query('DELETE FROM public.contract WHERE contract_id=$1', [id]).catch(() => {});
    }
    await harness.close();
    await closePools();
  });

  /** Insert a contract directly so uw_status / assignee are exactly as staged. */
  async function mkContract({ uwStatus = 'DRAFT', status = 'DRAFT', assignee = UW1 } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO public.contract
         (cedant_id,broker_id,country_id,currency_id,treaty_type_id,uw_year,uw_status,status,assigned_to_user_id,inception_date)
       VALUES ($1,$2,$3,$4,$5,2026,$6,$7::public.contract_status,$8,'2026-01-01')
       RETURNING contract_id`,
      [refs.cedant_id, refs.broker_id, refs.country_id, refs.currency_id, refs.treaty_type_id, uwStatus, status, assignee]);
    created.push(rows[0].contract_id);
    return rows[0].contract_id;
  }

  async function uwStatusOf(id) {
    return (await pool.query('SELECT uw_status FROM public.contract WHERE contract_id=$1', [id])).rows[0].uw_status;
  }

  describe('POST /treaties/:id/decline (F22/F29)', () => {
    it('403s a stranger and leaves the contract untouched', async () => {
      const id = await mkContract({ uwStatus: 'AWAITING_APPROVAL', status: 'AWAITING_APPROVAL' });
      await pool.query(
        `INSERT INTO public.contract_offer (contract_id, status, approval_step, submitted_by_id, written_line_pct)
         VALUES ($1,'AWAITING_APPROVAL',1,$2,25)`, [id, UW1]);

      const res = await harness.fetchApp('POST', `/api/treaties/${id}/decline`, {
        body: { reason: 'I felt like it' }, headers: asUser(STRANGER),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe('DECLINE_FORBIDDEN');
      expect(await uwStatusOf(id)).toBe('AWAITING_APPROVAL'); // not DECLINED — still recoverable
    });

    it('lets the assignee decline', async () => {
      const id = await mkContract({ uwStatus: 'DRAFT' });
      const res = await harness.fetchApp('POST', `/api/treaties/${id}/decline`, {
        body: { reason: 'cedant withdrew' }, headers: asUser(UW1),
      });
      expect(res.status).toBe(200);
      expect(await uwStatusOf(id)).toBe('DECLINED');
    });

    it('lets a live eligible approver (not the assignee) decline a submitted offer', async () => {
      const id = await mkContract({ uwStatus: 'AWAITING_APPROVAL', status: 'AWAITING_APPROVAL' });
      await pool.query(
        `INSERT INTO public.contract_offer (contract_id, status, approval_step, submitted_by_id, written_line_pct)
         VALUES ($1,'AWAITING_APPROVAL',1,$2,25)`, [id, UW1]);

      const res = await harness.fetchApp('POST', `/api/treaties/${id}/decline`, {
        body: { reason: 'declined on review' }, headers: asUser(CU, 'CU'),
      });
      expect(res.status).toBe(200);
      expect(await uwStatusOf(id)).toBe('DECLINED');
    });
  });

  describe('POST /treaties/:id/offer (F23)', () => {
    it('403s a non-assignee (READ_ONLY edit-lock)', async () => {
      const id = await mkContract({ uwStatus: 'DRAFT' });
      const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer`, {
        body: { written_line_pct: 10 }, headers: asUser(STRANGER),
      });
      expect(res.status).toBe(403);
    });

    it('lets the assignee save a fresh offer and marks the contract OFFERED', async () => {
      const id = await mkContract({ uwStatus: 'DRAFT' });
      const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer`, {
        body: { written_line_pct: 10, premium_driver: 'growth' }, headers: asUser(UW1),
      });
      expect(res.status).toBe(200);
      const c = (await pool.query('SELECT status, uw_status FROM public.contract WHERE contract_id=$1', [id])).rows[0];
      expect(c.status).toBe('OFFERED');
      expect(c.uw_status).toBe('DRAFT');
    });

    it('409s while an approval is in flight — peer decisions survive', async () => {
      const id = await mkContract({ uwStatus: 'AWAITING_APPROVAL', status: 'AWAITING_APPROVAL' });
      await pool.query(
        `INSERT INTO public.contract_offer
           (contract_id, status, approval_step, submitted_by_id, written_line_pct, breach_type, peer1_user_id, peer1_decision)
         VALUES ($1,'AWAITING_APPROVAL',2,$2,25,'LIMIT',$3,'APPROVED')`, [id, UW1, CU]);

      const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer`, {
        body: { written_line_pct: 99 }, headers: asUser(UW1),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('APPROVAL_IN_FLIGHT');
      const offer = (await pool.query(
        'SELECT status, approval_step, breach_type, peer1_decision, submitted_by_id FROM public.contract_offer WHERE contract_id=$1',
        [id])).rows[0];
      expect(offer).toMatchObject({
        status: 'AWAITING_APPROVAL', approval_step: 2, breach_type: 'LIMIT',
        peer1_decision: 'APPROVED', submitted_by_id: UW1,
      });
      const c = (await pool.query('SELECT status FROM public.contract WHERE contract_id=$1', [id])).rows[0];
      expect(c.status).toBe('AWAITING_APPROVAL'); // not force-flipped to OFFERED
    });

    it('422s on a SIGNED contract — a signed treaty cannot be re-offered', async () => {
      const id = await mkContract({ uwStatus: 'SIGNED', status: 'SIGNED' });
      const res = await harness.fetchApp('POST', `/api/treaties/${id}/offer`, {
        body: { written_line_pct: 50 }, headers: asUser(UW1),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('INVALID_TRANSITION');
      const c = (await pool.query('SELECT status, uw_status FROM public.contract WHERE contract_id=$1', [id])).rows[0];
      expect(c).toMatchObject({ status: 'SIGNED', uw_status: 'SIGNED' });
    });
  });
});
