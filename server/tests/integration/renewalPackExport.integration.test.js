// server/tests/integration/renewalPackExport.integration.test.js
//
// Scoping coverage for the portfolio renewal-pack export. The workbook is open
// to every authenticated user, but GET /api/renewal-pack/export:
//   • requires an authenticated identity (the blanket requireAuth in app.js);
//   • scopes rows to the requester's MANDATE (treaty_type_scope + restricted COBs);
//   • audits each export (actor, applied filters, contract count).
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { resolveExportScope } from '../../src/services/renewalPackExport/scope.js';

const SENIOR = { 'x-user-role': 'CU', 'x-user-id': '00000000-0000-0000-0000-000000000001' };
const JUNIOR = { 'x-user-role': 'TUW', 'x-user-id': '00000000-0000-0000-0000-000000000002' };

describe.skipIf(shouldSkipDb)('integration: portfolio export ACL + scoping', () => {
  let harness;
  const seeded = { contracts: [], users: [] };
  let propTypeId; let npTypeId; let normalCob; let restrictedCob;
  let restrictedUserId; let unrestrictedUserId;
  let contractA; let contractB; let contractC; // A=PROP/normal, B=NP/normal, C=PROP/restricted

  async function seedRefs() {
    const sfx = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    const code = sfx.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();
    const [country, currency, broker, cedant, propType, npType, cobN, cobR] = await Promise.all([
      pool.query(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'R') RETURNING country_id`, [`Z${code}`, `PX Country ${sfx}`]),
      pool.query(`INSERT INTO public.currency (currency_code, currency_name) VALUES ($1,$2) RETURNING currency_id`, [`X${code}`, `PX Ccy ${sfx}`]),
      pool.query(`INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`, [`PX Broker ${sfx}`]),
      pool.query(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`PX Cedant ${sfx}`]),
      pool.query(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'PROPORTIONAL') RETURNING treaty_type_id`, [`PX Prop ${sfx}`]),
      pool.query(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'NON_PROPORTIONAL') RETURNING treaty_type_id`, [`PX NP ${sfx}`]),
      pool.query(`INSERT INTO public.class_of_business (class_of_business) VALUES ($1) RETURNING class_of_business_id`, [`PX COB Normal ${sfx}`]),
      pool.query(`INSERT INTO public.class_of_business (class_of_business) VALUES ($1) RETURNING class_of_business_id`, [`PX COB Restricted ${sfx}`]),
    ]);
    propTypeId = propType.rows[0].treaty_type_id;
    npTypeId = npType.rows[0].treaty_type_id;
    normalCob = cobN.rows[0].class_of_business_id;
    restrictedCob = cobR.rows[0].class_of_business_id;
    return {
      cedant_id: cedant.rows[0].company_id, broker_id: broker.rows[0].broker_id,
      currency_id: currency.rows[0].currency_id, country_id: country.rows[0].country_id,
    };
  }

  async function seedContract(refs, treatyTypeId, cobId) {
    const { rows } = await pool.query(
      `INSERT INTO public.contract
         (uw_year, status, uw_status, cedant_id, broker_id, currency_id, country_id,
          treaty_type_id, primary_class_of_business_id, inception_date)
       VALUES (2026,'SIGNED','SIGNED',$1,$2,$3,$4,$5,$6,'2026-01-01') RETURNING contract_id`,
      [refs.cedant_id, refs.broker_id, refs.currency_id, refs.country_id, treatyTypeId, cobId],
    );
    seeded.contracts.push(rows[0].contract_id);
    return rows[0].contract_id;
  }

  // Seed a uw_user with a given role; optionally a mandate (else unrestricted).
  async function seedUser(roleCode, mandate) {
    const sfx = Math.random().toString(36).slice(2, 9);
    const { rows: roleRows } = await pool.query(`SELECT role_id FROM public.uw_role WHERE role_code=$1`, [roleCode]);
    const { rows } = await pool.query(
      `INSERT INTO public.uw_user (email, display_name, role_id, is_active, password_hash)
       VALUES ($1,$2,$3,true,'DEMO_HASH_2026') RETURNING user_id`,
      [`p0x2-${sfx}@example.test`, `P0X2 ${sfx}`, roleRows[0].role_id],
    );
    const userId = rows[0].user_id;
    seeded.users.push(userId);
    if (mandate) {
      await pool.query(
        `INSERT INTO public.user_mandate (user_id, treaty_type_scope, restricted_cob_ids)
         VALUES ($1,$2,$3)`,
        [userId, mandate.treatyTypeScope, mandate.restrictedCobIds || []],
      );
    }
    return userId;
  }

  beforeAll(async () => {
    harness = await bootApp();
    const refs = await seedRefs();
    contractA = await seedContract(refs, propTypeId, normalCob);      // PROP / normal COB
    contractB = await seedContract(refs, npTypeId, normalCob);        // NP   / normal COB
    contractC = await seedContract(refs, propTypeId, restrictedCob);  // PROP / restricted COB
    restrictedUserId = await seedUser('CU', { treatyTypeScope: 'PROP_ONLY', restrictedCobIds: [restrictedCob] });
    unrestrictedUserId = await seedUser('CU', null);
  });

  afterAll(async () => {
    if (harness) await harness.close();
    for (const id of seeded.contracts) { try { await pool.query(`DELETE FROM public.contract WHERE contract_id=$1`, [id]); } catch {} }
    for (const id of seeded.users) { try { await pool.query(`DELETE FROM public.uw_user WHERE user_id=$1`, [id]); } catch {} }
    await closePools();
  });

  it('a senior (CU/CE) may export — 200 with an xlsx attachment', async () => {
    const res = await harness.fetchApp('GET', '/api/renewal-pack/export', { headers: SENIOR });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
  });

  it('a treaty underwriter (TUW) may also export — 200 with an xlsx attachment', async () => {
    const res = await harness.fetchApp('GET', '/api/renewal-pack/export', { headers: JUNIOR });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
  });

  it('an unauthenticated caller is rejected — 401', async () => {
    // Blank out the harness's default role header → anonymous request.
    const res = await harness.fetchApp('GET', '/api/renewal-pack/export', { headers: { 'x-user-role': '', 'x-user-id': '' } });
    expect(res.status).toBe(401);
  });

  it('mandate scope limits the rows: PROP_ONLY + restricted COB includes only the permitted contract', async () => {
    const scope = await resolveExportScope(pool, restrictedUserId);
    expect(scope.treatyTypeScope).toBe('PROP_ONLY');
    expect(scope.contractIds).not.toBeNull();
    expect(scope.contractIds).toContain(contractA);     // PROP + normal COB → visible
    expect(scope.contractIds).not.toContain(contractB); // NP → excluded by treaty-type scope
    expect(scope.contractIds).not.toContain(contractC); // restricted COB → excluded
  });

  it('an unrestricted mandate scopes to the full portfolio (null filter)', async () => {
    const scope = await resolveExportScope(pool, unrestrictedUserId);
    expect(scope.contractIds).toBeNull();
  });

  it('export by a restricted user is audited as scoped with the applied filters + row count', async () => {
    const res = await harness.fetchApp('GET', '/api/renewal-pack/export', {
      headers: { 'x-user-role': 'CU', 'x-user-id': restrictedUserId },
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT actor, payload FROM public.audit_log
        WHERE entity_type='PORTFOLIO' AND event_type='PORTFOLIO_EXPORTED' AND actor=$1
        ORDER BY created_at DESC LIMIT 1`,
      [restrictedUserId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].payload).toMatchObject({
      target: 'renewal-pack', scoped: true, treatyTypeScope: 'PROP_ONLY',
    });
    expect(typeof rows[0].payload.contractCount).toBe('number');
    // The restricted user's count excludes the NP + restricted-COB contracts.
    expect(rows[0].payload.contractCount).toBeGreaterThanOrEqual(1);
  });

  it('export by an unrestricted user is audited as unscoped (full portfolio)', async () => {
    const res = await harness.fetchApp('GET', '/api/renewal-pack/export', {
      headers: { 'x-user-role': 'CU', 'x-user-id': unrestrictedUserId },
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT payload FROM public.audit_log
        WHERE entity_type='PORTFOLIO' AND event_type='PORTFOLIO_EXPORTED' AND actor=$1
        ORDER BY created_at DESC LIMIT 1`,
      [unrestrictedUserId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].payload).toMatchObject({ scoped: false, treatyTypeScope: 'BOTH' });
  });
});
