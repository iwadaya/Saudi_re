// server/src/startup/ensureReferenceData.db.test.js
//
// Boot-time reference-data safety (audit F36).
//
// ensureReferenceData used to hard-DELETE every non-canonical treaty_type on
// every boot (after a dead-code attempt to NULL out NOT NULL FK columns, with
// every error swallowed) — silently destroying user-created reference rows.
// The fix soft-deactivates instead. This suite runs the real function against
// the real database and pins the new contract:
//
//   1. a user-created treaty type SURVIVES boot — it is deactivated
//      (hidden from dropdowns), never deleted;
//   2. rows already soft-deleted are respected (left exactly as they are);
//   3. canonical treaty types stay active;
//   4. nothing is ever deleted from treaty_type by boot.
//
// Gated on TEST_WITH_DB=1 like every other DB-backed test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/pool.js';
import { shouldSkipDb, closePools } from '../../tests/integration/helpers.js';
import { ensureReferenceData } from './ensureReferenceData.js';

describe.skipIf(shouldSkipDb)('ensureReferenceData: treaty_type boot behaviour (real DB)', () => {
  const s = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const userTypeName = `User Type ${s}`;          // user-created, active — the row the old code destroyed
  const deletedTypeName = `User Deleted ${s}`;    // user-created, already soft-deleted
  let userTypeId, deletedTypeId;

  beforeAll(async () => {
    userTypeId = (await pool.query(
      `INSERT INTO public.treaty_type (treaty_type, category, is_active) VALUES ($1,'PROPORTIONAL',true) RETURNING treaty_type_id`,
      [userTypeName])).rows[0].treaty_type_id;
    deletedTypeId = (await pool.query(
      `INSERT INTO public.treaty_type (treaty_type, category, is_active) VALUES ($1,'NON_PROPORTIONAL',false) RETURNING treaty_type_id`,
      [deletedTypeName])).rows[0].treaty_type_id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM public.treaty_type WHERE treaty_type_id IN ($1,$2)`, [userTypeId, deletedTypeId]).catch(() => {});
    await closePools();
  });

  it('a user-created treaty type survives boot, soft-deactivated instead of deleted', async () => {
    await ensureReferenceData();

    const { rows } = await pool.query(
      `SELECT treaty_type_id, is_active FROM public.treaty_type WHERE treaty_type=$1`,
      [userTypeName],
    );
    expect(rows).toHaveLength(1);                      // NOT deleted
    expect(rows[0].treaty_type_id).toBe(userTypeId);
    expect(rows[0].is_active).toBe(false);             // hidden from dropdowns

    // Already-soft-deleted rows are respected — still present, still inactive.
    const deleted = await pool.query(
      `SELECT is_active FROM public.treaty_type WHERE treaty_type_id=$1`, [deletedTypeId]);
    expect(deleted.rows).toHaveLength(1);
    expect(deleted.rows[0].is_active).toBe(false);
  });

  it('boot never deletes treaty_type rows and keeps the canonical set active', async () => {
    // Second run: converged — still nothing deleted, canonical types active.
    await ensureReferenceData();

    // Both fixture rows are still present after a converged double-boot
    // (the old code deleted unreferenced non-canonical rows on every run).
    const mine = await pool.query(
      `SELECT treaty_type_id FROM public.treaty_type WHERE treaty_type_id IN ($1,$2)`,
      [userTypeId, deletedTypeId],
    );
    expect(mine.rows).toHaveLength(2);

    const canonical = await pool.query(
      `SELECT count(*)::int AS n FROM public.treaty_type WHERE is_active AND treaty_type = ANY($1::text[])`,
      [[
        'Quota Share', 'Quota Share & Surplus', 'First Surplus', 'Second Surplus',
        'Third Surplus', 'Fac Oblig', 'Risk XL', 'CAT XL', 'Risk & CAT XL',
        'Stop Loss', 'Aggregate XL',
      ]],
    );
    expect(canonical.rows[0].n).toBe(11);
  });
});
