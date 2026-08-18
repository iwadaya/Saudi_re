// server/tests/integration/facReferenceGovernance.integration.test.js
//
// Phase 5 against a real database: how rates get loaded, and who is on the
// hook for them.
//
// Every facultative rate table ships empty because a rate nobody can
// attribute is a rate nobody can defend. This is the path that puts real
// numbers in with a name against them — and the tests that matter most here
// are the refusals: the submitter cannot approve their own revision, and a
// half-applied revision is not a state the system can reach.
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const SUBMITTER = '00000000-0000-0000-0000-000000000002';   // Underwriter 1
const APPROVER  = '00000000-0000-0000-0000-000000000001';   // Chief Underwriter
const SRC = 'GOVERNANCE_INTEGRATION_TEST';

describe.skipIf(shouldSkipDb)('integration: fac reference-data governance', () => {
  let harness;
  const versions = [];

  const as = (userId) => ({ headers: { 'x-user-id': userId } });

  async function newDraft(label, extra = {}) {
    const res = await harness.fetchApp('POST', '/api/fac/admin/rate-versions', {
      body: { version_label: label, owner_note: 'Actuarial', ...extra },
      ...as(SUBMITTER),
    });
    const v = await res.json();
    if (v.version_id) versions.push(v.version_id);
    return v;
  }

  const stage = (id, rows, userId = SUBMITTER) => harness.fetchApp(
    'POST', `/api/fac/admin/rate-versions/${id}/stage`, { body: { rows }, ...as(userId) },
  );

  const hullRow = (rate = 3.5, tonnageMin = 20000) => ({
    target_table: 'fac_hull_base_rate',
    operation: 'INSERT',
    payload: {
      vessel_type: 'GOVERNANCE_TEST_BULKER',
      tonnage_min: tonnageMin,
      // The table's own CHECK requires max > min, and it still applies to a
      // published revision — the governance layer does not get to bypass it.
      tonnage_max: tonnageMin + 60000,
      rate_pm: rate, source: SRC,
    },
  });

  beforeAll(async () => { harness = await bootApp(); });

  afterAll(async () => {
    await pool.query('DELETE FROM public.fac_hull_base_rate WHERE source = $1', [SRC]);
    for (const id of versions) {
      try {
        await pool.query('DELETE FROM public.fac_rate_table_version WHERE version_id = $1', [id]);
      } catch { /* best effort */ }
    }
    // Publishing supersedes whatever was in force, which here is the seeded
    // FAC-REF-2026.1 that the rest of the suite expects to find open-ended.
    // Deleting this suite's versions is not enough — the one it displaced has
    // to be put back, or a later test finds no reference set in force.
    await pool.query(
      `UPDATE public.fac_rate_table_version
          SET effective_to = NULL, status = 'APPROVED'
        WHERE version_label = 'FAC-REF-2026.1'`,
    );
    if (harness) await harness.close();
    await closePools();
  });

  // ── The lifecycle ───────────────────────────────────────────────────────

  it('opens a draft with an owner recorded against it', async () => {
    const v = await newDraft('GOV-TEST-1');
    expect(v.status).toBe('DRAFT');
    expect(v.owner_note).toBe('Actuarial');
    expect(v.created_by).toBe(SUBMITTER);
  });

  it('refuses to submit a revision that stages nothing', async () => {
    const v = await newDraft('GOV-TEST-EMPTY');
    const res = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOTHING_STAGED');
  });

  it('carries a revision from draft to live, and only then are the rates there', async () => {
    const v = await newDraft('GOV-TEST-HAPPY');
    expect((await stage(v.version_id, [hullRow()])).status).toBe(200);

    // Staged is not live. Nothing edits a rate table in place.
    const before = await pool.query(
      'SELECT COUNT(*)::int AS n FROM public.fac_hull_base_rate WHERE source = $1', [SRC],
    );
    expect(before.rows[0].n).toBe(0);

    const submitted = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    ).then((r) => r.json());
    expect(submitted.status).toBe('PENDING_APPROVAL');
    expect(submitted.submitted_by).toBe(SUBMITTER);

    const approved = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/approve`, as(APPROVER),
    ).then((r) => r.json());
    expect(approved.status).toBe('APPROVED');
    expect(approved.approved_by).toBe(APPROVER);

    const published = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/publish`, as(APPROVER),
    ).then((r) => r.json());
    expect(published.applied).toBe(1);
    expect(published.byTable.fac_hull_base_rate).toBe(1);

    const after = await pool.query(
      'SELECT rate_pm FROM public.fac_hull_base_rate WHERE source = $1', [SRC],
    );
    expect(after.rows).toHaveLength(1);
    expect(Number(after.rows[0].rate_pm)).toBeCloseTo(3.5, 6);
  });

  it('supersedes the revision it replaces, so exactly one is ever in force', async () => {
    const before = await pool.query(
      `SELECT version_label FROM public.fac_rate_table_version
        WHERE effective_to IS NULL AND published_at IS NOT NULL`,
    );
    expect(before.rows).toHaveLength(1);

    const v = await newDraft('GOV-TEST-SUPERSEDE', { effective_from: '2027-01-01' });
    await stage(v.version_id, [hullRow(6.5, 140000)]);
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    );
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/approve`, as(APPROVER),
    );
    const published = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/publish`, as(APPROVER),
    ).then((r) => r.json());

    expect(published.superseded).toContain(before.rows[0].version_label);

    // Still exactly one in force, and the one it replaced is closed off at the
    // day before — so a historic quote resolves to the rates that priced it
    // (finding F12) rather than to a gap.
    const after = await pool.query(
      `SELECT version_label, effective_to FROM public.fac_rate_table_version
        WHERE published_at IS NOT NULL ORDER BY effective_from`,
    );
    expect(after.rows.filter((r) => r.effective_to === null)).toHaveLength(1);
    const displaced = after.rows.find((r) => r.version_label === before.rows[0].version_label);
    expect(displaced.effective_to.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  // ── The control ─────────────────────────────────────────────────────────

  it('refuses an approval by the person who submitted it', async () => {
    // This is the whole control. A rate revision takes a second pair of eyes.
    const v = await newDraft('GOV-TEST-FOUR-EYES');
    await stage(v.version_id, [hullRow(9.9, 90000)]);
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    );

    const res = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/approve`, as(SUBMITTER),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FOUR_EYES_REQUIRED');
    expect(body.error).toMatch(/second pair of eyes/i);

    // And it is still pending, not quietly approved.
    const { version } = await harness.fetchApp(
      'GET', `/api/fac/admin/rate-versions/${v.version_id}`,
    ).then((r) => r.json());
    expect(version.status).toBe('PENDING_APPROVAL');
    expect(version.approved_by).toBeNull();
  });

  it('sends a revision back to draft with a reason, and keeps the rejection on the record', async () => {
    const v = await newDraft('GOV-TEST-REJECT');
    await stage(v.version_id, [hullRow(4.2, 30000)]);
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    );

    const short = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/reject`,
      { body: { reason: 'no' }, ...as(APPROVER) },
    );
    expect(short.status).toBe(400);

    const rejected = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/reject`,
      { body: { reason: 'The hull rate is quoted against gross tonnage, not deadweight' }, ...as(APPROVER) },
    ).then((r) => r.json());
    expect(rejected.status).toBe('DRAFT');
    expect(rejected.rejection_reason).toMatch(/gross tonnage/);

    const { events } = await harness.fetchApp(
      'GET', `/api/fac/admin/rate-versions/${v.version_id}`,
    ).then((r) => r.json());
    // The version row holds the current state; the event log holds how it got
    // there, including the rejection the row would otherwise overwrite.
    expect(events.map((e) => e.event_type)).toEqual(
      ['CREATED', 'STAGED', 'SUBMITTED', 'REJECTED'],
    );
  });

  it('refuses to publish anything that is not approved', async () => {
    const v = await newDraft('GOV-TEST-UNAPPROVED');
    await stage(v.version_id, [hullRow(1.1, 100000)]);
    const res = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/publish`, as(APPROVER),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_STATE');
  });

  it('refuses to stage against a revision that is no longer a draft', async () => {
    const v = await newDraft('GOV-TEST-LOCKED');
    await stage(v.version_id, [hullRow(2.2, 110000)]);
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    );
    const res = await stage(v.version_id, [hullRow(3.3, 120000)]);
    expect(res.status).toBe(409);
  });

  // ── The allow-list ──────────────────────────────────────────────────────

  it('refuses a table that is not on the allow-list', async () => {
    const v = await newDraft('GOV-TEST-BAD-TABLE');
    const res = await stage(v.version_id, [{
      target_table: 'uw_user', operation: 'INSERT',
      payload: { display_name: 'Nope' },
    }]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('TABLE_NOT_STAGEABLE');
  });

  it('refuses a column the target table does not declare', async () => {
    const v = await newDraft('GOV-TEST-BAD-COLUMN');
    const res = await stage(v.version_id, [{
      target_table: 'fac_hull_base_rate', operation: 'INSERT',
      payload: { vessel_type: 'X', rate_pm: 1, source: SRC, drop_table: 'oops' },
    }]);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('COLUMN_NOT_ALLOWED');
  });

  it('does not let a crafted table name reach SQL', async () => {
    const v = await newDraft('GOV-TEST-INJECTION');
    const res = await stage(v.version_id, [{
      target_table: 'fac_hull_base_rate; DROP TABLE public.fac_risk; --',
      operation: 'INSERT', payload: { rate_pm: 1 },
    }]);
    expect(res.status).toBe(400);
    // The name is rejected, not escaped — and fac_risk is still there.
    const still = await pool.query("SELECT to_regclass('public.fac_risk') AS t");
    expect(still.rows[0].t).toBe('fac_risk');
  });

  it('publishes the whole revision or none of it', async () => {
    // The second row updates a rate that does not exist. If publish were
    // row-by-row, the first would land and the book would be priced on a
    // half-applied revision.
    const v = await newDraft('GOV-TEST-ATOMIC');
    await stage(v.version_id, [
      hullRow(5.5, 130000),
      {
        target_table: 'fac_hull_base_rate', operation: 'UPDATE',
        row_key: { vessel_type: 'DOES_NOT_EXIST', tonnage_min: 0 },
        payload: { rate_pm: 99 },
      },
    ]);
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/submit`, as(SUBMITTER),
    );
    await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/approve`, as(APPROVER),
    );
    const res = await harness.fetchApp(
      'POST', `/api/fac/admin/rate-versions/${v.version_id}/publish`, as(APPROVER),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STAGED_ROW_NOT_FOUND');

    const landed = await pool.query(
      'SELECT COUNT(*)::int AS n FROM public.fac_hull_base_rate WHERE tonnage_min = 130000',
    );
    expect(landed.rows[0].n).toBe(0);
  });

  it('serves the allow-list so a screen does not keep a second copy of it', async () => {
    const { tables } = await harness.fetchApp(
      'GET', '/api/fac/admin/rate-versions/stageable',
    ).then((r) => r.json());
    const hull = tables.find((t) => t.table === 'fac_hull_base_rate');
    expect(hull.key).toEqual(['vessel_type', 'tonnage_min']);
    expect(hull.columns).toContain('rate_pm');
    expect(tables.some((t) => t.table === 'uw_user')).toBe(false);
  });
});
