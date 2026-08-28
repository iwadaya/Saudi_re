// server/src/services/assignments.db.test.js
//
// DB-backed audit-trail assertions for the assignment service (audit F33).
//
// The mocked suite in assignments.test.js proves the POLICY (DRAFT-only,
// hierarchy) but by construction cannot catch schema drift: for months every
// contract_assignment_history INSERT failed with 42703 (services wrote an
// `action` column while the applied table — migration 002's shape, never
// replaced by 036's IF-NOT-EXISTS no-op — had `assignment_type`), logHistory
// swallowed the error, and the audit trail stayed permanently empty while all
// tests passed. This suite runs allocate()/reassign() against the REAL
// database (post-migration 147) and asserts the history rows actually land.
//
// Gated on TEST_WITH_DB=1 like every other DB-backed test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { shouldSkipDb, closePools } from '../../tests/integration/helpers.js';
import { allocate, reassign, getAssignmentHistory } from './assignments.js';

describe.skipIf(shouldSkipDb)('assignment history audit trail (real DB)', () => {
  const s = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Not present in uw_user — getHierarchyLevel degrades to level 99 for both,
  // which the policy allows (unassigned item / equal levels). The history
  // table has no user FKs, so the rows must still land.
  const userA = randomUUID();
  const userB = randomUUID();
  const ids = {};

  beforeAll(async () => {
    const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
    ids.country = (await one(
      `INSERT INTO public.country (country_code, country_name, region, is_active) VALUES ($1,$2,'R',false) RETURNING country_id`,
      [`Y${s.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase()}`, `AH Country ${s}`])).country_id;
    ids.currency = (await one(`SELECT currency_id FROM public.currency WHERE currency_code='USD' LIMIT 1`)).currency_id;
    ids.broker = (await one(
      `INSERT INTO public.brokers (broker_name, is_active) VALUES ($1,false) RETURNING broker_id`, [`AH Broker ${s}`])).broker_id;
    ids.cedant = (await one(
      `INSERT INTO public.companies (company_name, is_active) VALUES ($1,false) RETURNING company_id`, [`AH Cedant ${s}`])).company_id;
    ids.treatyType = (await one(
      `INSERT INTO public.treaty_type (treaty_type, category, is_active) VALUES ($1,'PROPORTIONAL',false) RETURNING treaty_type_id`,
      [`AH TType ${s}`])).treaty_type_id;
    ids.contract = (await one(
      `INSERT INTO public.contract
         (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, uw_status, inception_date)
       VALUES ($1,$2,$3,$4,$5,2026,'DRAFT','2026-01-01') RETURNING contract_id`,
      [ids.cedant, ids.broker, ids.country, ids.currency, ids.treatyType])).contract_id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM public.contract_assignment_history WHERE entity_id=$1`, [ids.contract]).catch(() => {});
    await pool.query(`DELETE FROM public.contract WHERE contract_id=$1`, [ids.contract]).catch(() => {});
    await pool.query(`DELETE FROM public.treaty_type WHERE treaty_type_id=$1`, [ids.treatyType]).catch(() => {});
    await pool.query(`DELETE FROM public.companies WHERE company_id=$1`, [ids.cedant]).catch(() => {});
    await pool.query(`DELETE FROM public.brokers WHERE broker_id=$1`, [ids.broker]).catch(() => {});
    await pool.query(`DELETE FROM public.country WHERE country_id=$1`, [ids.country]).catch(() => {});
    await closePools();
  });

  it('allocate() writes an ALLOCATED history row — the INSERT must not fall back to audit_log', async () => {
    const out = await allocate({
      entityType: 'CONTRACT', entityId: ids.contract, requestingUserId: userA, comment: 'taking it',
    });
    expect(out.allocated).toBe(true);

    const { rows } = await pool.query(
      `SELECT action, from_user_id, to_user_id, assigned_by, comment
         FROM public.contract_assignment_history
        WHERE entity_type='CONTRACT' AND entity_id=$1 AND action='ALLOCATED'`,
      [ids.contract],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ALLOCATED',
      from_user_id: null,
      to_user_id: userA,
      assigned_by: userA,
      comment: 'taking it',
    });
  });

  it('reassign() writes an ASSIGNED history row, and getAssignmentHistory() serves the trail', async () => {
    const out = await reassign({
      entityType: 'CONTRACT', entityId: ids.contract, reassignedBy: userA, newOwnerId: userB, comment: 'handoff',
    });
    expect(out).toMatchObject({ assigned: true, from: userA, to: userB });

    const { rows } = await pool.query(
      `SELECT action, from_user_id, to_user_id, assigned_by
         FROM public.contract_assignment_history
        WHERE entity_type='CONTRACT' AND entity_id=$1 AND action='ASSIGNED'`,
      [ids.contract],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_user_id: userA,
      to_user_id: userB,
      assigned_by: userA,
    });

    // The read path the UI uses must render the full (non-empty!) trail.
    const history = await getAssignmentHistory('CONTRACT', ids.contract);
    expect(history.map((h) => h.action).sort()).toEqual(['ALLOCATED', 'ASSIGNED']);
  });
});
