// server/tests/integration/readPolicy.integration.test.js
//
// P1-authz — the ONE formal read-visibility policy (assigned/team/office/all),
// exercised PER SURFACE and PER LEVEL against a real DB. Each surface routes its
// reads through services/readPolicy.js (reusing the P0-1 read choke point in
// services/permissions.js), so a single READ_POLICY value tightens them all at
// once. Surfaces covered:
//   • contracts list   GET /api/treaties
//   • quotes list      GET /api/quotes
//   • documents        GET /api/treaties/:id/documents
//   • dashboard        GET /api/dashboard/page/portfolio-overview
//   • renewal export   GET /api/renewal-pack/export   (read scope ∩ mandate scope)
//   • AI ops           GET /api/cedants/:id/staging/portfolio-impact (fetchPortfolio)
//
// The world: requester `Me` sits in office Alpha at hierarchy level 4 (TM). The
// four contracts/quotes are each owned by a different user so the visible set is
// a clean function of the policy level:
//   assigned → {Me}                team → {Me, Junior}
//   office   → {Me, Junior, Senior}   all  → {Me, Junior, Senior, Other}
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { readableContractIds } from '../../src/services/readPolicy.js';

const UW_YEAR = 2087; // distinctive year so the dashboard KPI counts only our rows

describe.skipIf(shouldSkipDb)('integration: read-policy across surfaces', () => {
  let harness;
  const seeded = { contracts: [], quotes: [], users: [], docs: [] };
  let officeAlpha; let officeBeta;
  let userMe; let userJunior; let userSenior; let userOther;
  let cedantC; let cedantQ; let refs;
  // contract / quote ids, per owner
  const C = {}; const Q = {};

  async function roleId(code) {
    const { rows } = await pool.query(`SELECT role_id FROM public.uw_role WHERE role_code=$1`, [code]);
    return rows[0].role_id;
  }

  async function seedUser(roleCode, office) {
    const sfx = Math.random().toString(36).slice(2, 9);
    const { rows } = await pool.query(
      `INSERT INTO public.uw_user (email, display_name, role_id, office, is_active, password_hash)
       VALUES ($1,$2,$3,$4,true,'DEMO_HASH_2026') RETURNING user_id`,
      [`rp-${sfx}@example.test`, `RP ${sfx}`, await roleId(roleCode), office],
    );
    seeded.users.push(rows[0].user_id);
    return rows[0].user_id;
  }

  async function seedRefs() {
    const sfx = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    const code = sfx.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();
    const [country, currency, broker, cedantCo, cedantQo, treatyType] = await Promise.all([
      pool.query(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'R') RETURNING country_id`, [`Z${code}`, `RP Country ${sfx}`]),
      pool.query(`INSERT INTO public.currency (currency_code, currency_name) VALUES ($1,$2) RETURNING currency_id`, [`X${code}`, `RP Ccy ${sfx}`]),
      pool.query(`INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`, [`RP Broker ${sfx}`]),
      pool.query(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`RP Cedant C ${sfx}`]),
      pool.query(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`RP Cedant Q ${sfx}`]),
      pool.query(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'PROPORTIONAL') RETURNING treaty_type_id`, [`RP Prop ${sfx}`]),
    ]);
    cedantC = cedantCo.rows[0].company_id;
    cedantQ = cedantQo.rows[0].company_id;
    return {
      broker_id: broker.rows[0].broker_id, currency_id: currency.rows[0].currency_id,
      country_id: country.rows[0].country_id, treaty_type_id: treatyType.rows[0].treaty_type_id,
    };
  }

  // PROP contract owned by `owner`, with a prop-details row carrying a distinct
  // premium so the AI portfolio-impact total uniquely identifies the visible set.
  async function seedContract(owner, qsEpi) {
    const { rows } = await pool.query(
      `INSERT INTO public.contract
         (uw_year, status, uw_status, cedant_id, broker_id, currency_id, country_id,
          treaty_type_id, signed_line_pct, inception_date, assigned_to_user_id, created_by_user_id)
       VALUES ($1,'SIGNED','SIGNED',$2,$3,$4,$5,$6,100,'2087-01-01',$7,$7) RETURNING contract_id`,
      [UW_YEAR, cedantC, refs.broker_id, refs.currency_id, refs.country_id, refs.treaty_type_id, owner],
    );
    const id = rows[0].contract_id;
    seeded.contracts.push(id);
    await pool.query(
      `INSERT INTO public.contract_prop_details (contract_id, quota_share_epi, surplus_epi) VALUES ($1,$2,0)`,
      [id, qsEpi],
    );
    return id;
  }

  async function seedQuote(owner) {
    const { rows } = await pool.query(
      `INSERT INTO public.quote
         (uw_year, status, cedant_id, broker_id, currency_id, country_id, treaty_type_id,
          inception_date, quote_version, assigned_to_user_id, created_by_user_id)
       VALUES ($1,'DRAFT',$2,$3,$4,$5,$6,'2087-01-01',1,$7,$7) RETURNING quote_id`,
      [UW_YEAR, cedantQ, refs.broker_id, refs.currency_id, refs.country_id, refs.treaty_type_id, owner],
    );
    seeded.quotes.push(rows[0].quote_id);
    return rows[0].quote_id;
  }

  async function seedDoc(contractId) {
    const { rows } = await pool.query(
      `INSERT INTO public.contract_document (contract_id, file_name, mime_type, size_bytes, storage_path)
       VALUES ($1,'rp.pdf','application/pdf',10,'local/rp.pdf') RETURNING document_id`,
      [contractId],
    );
    seeded.docs.push(rows[0].document_id);
    return rows[0].document_id;
  }

  // Authenticate as a given user via the demo headers. The policy re-reads the
  // user's office + level from the DB, so the role header only needs to satisfy
  // route-level gates (e.g. the renewal export's level-≤2 requirement).
  const as = (userId, roleCode = 'TM') => ({ 'x-user-id': userId, 'x-user-role': roleCode });

  beforeAll(async () => {
    harness = await bootApp();
    const sfx = Math.random().toString(36).slice(2, 7);
    officeAlpha = `RP-Alpha-${sfx}`;
    officeBeta = `RP-Beta-${sfx}`;
    userMe     = await seedUser('TM', officeAlpha); // level 4
    userJunior = await seedUser('AN', officeAlpha); // level 5 (in Me's team)
    userSenior = await seedUser('CU', officeAlpha); // level 2 (Me's office, NOT team)
    userOther  = await seedUser('TM',  officeBeta);  // level 4, different office

    refs = await seedRefs();
    C.me     = await seedContract(userMe, 1);
    C.junior = await seedContract(userJunior, 10);
    C.senior = await seedContract(userSenior, 100);
    C.other  = await seedContract(userOther, 1000);

    Q.me     = await seedQuote(userMe);
    Q.junior = await seedQuote(userJunior);
    Q.senior = await seedQuote(userSenior);
    Q.other  = await seedQuote(userOther);

    await seedDoc(C.me);
    await seedDoc(C.senior);
  });

  afterAll(async () => {
    if (harness) await harness.close();
    for (const id of seeded.docs)      { try { await pool.query(`DELETE FROM public.contract_document WHERE document_id=$1`, [id]); } catch {} }
    for (const id of seeded.contracts) { try { await pool.query(`DELETE FROM public.contract_prop_details WHERE contract_id=$1`, [id]); } catch {} try { await pool.query(`DELETE FROM public.contract WHERE contract_id=$1`, [id]); } catch {} }
    for (const id of seeded.quotes)    { try { await pool.query(`DELETE FROM public.quote WHERE quote_id=$1`, [id]); } catch {} }
    for (const id of seeded.users)     { try { await pool.query(`DELETE FROM public.uw_user WHERE user_id=$1`, [id]); } catch {} }
    await closePools();
  });

  // Expected VISIBLE owner-key set for requester `Me`, per policy level.
  const VISIBLE = {
    assigned: ['me'],
    team:     ['me', 'junior'],
    office:   ['me', 'junior', 'senior'],
    all:      ['me', 'junior', 'senior', 'other'],
  };
  const LEVELS = ['assigned', 'team', 'office', 'all'];

  it('contracts list — each level shows exactly the permitted owners', async () => {
    for (const level of LEVELS) {
      process.env.READ_POLICY = level;
      const res = await harness.fetchApp('GET', `/api/treaties?cedant_id=${cedantC}&limit=50`, { headers: as(userMe) });
      expect(res.status).toBe(200);
      const ids = new Set((await res.json()).map(r => r.contract_id));
      const expected = VISIBLE[level].map(k => C[k]);
      expect([...ids].sort()).toEqual([...new Set(expected)].sort());
      // Total-count header agrees with the visible set (count + page consistent).
      expect(Number(res.headers.get('x-total-count'))).toBe(expected.length);
    }
  });

  it('quotes list — each level shows exactly the permitted owners', async () => {
    for (const level of LEVELS) {
      process.env.READ_POLICY = level;
      const res = await harness.fetchApp('GET', `/api/quotes?cedant_id=${cedantQ}&limit=50`, { headers: as(userMe) });
      expect(res.status).toBe(200);
      const ids = new Set((await res.json()).map(r => r.quote_id));
      const expected = VISIBLE[level].map(k => Q[k]);
      expect([...ids].sort()).toEqual([...new Set(expected)].sort());
      expect(Number(res.headers.get('x-total-count'))).toBe(expected.length);
    }
  });

  it('documents — a foreign contract\'s docs are hidden until the policy admits its owner', async () => {
    // Me's own contract: always visible.
    // The Senior-owned contract: hidden under assigned/team (404), shown under office/all.
    const expectSenior = { assigned: 404, team: 404, office: 200, all: 200 };
    for (const level of LEVELS) {
      process.env.READ_POLICY = level;
      const mine = await harness.fetchApp('GET', `/api/treaties/${C.me}/documents`, { headers: as(userMe) });
      expect(mine.status).toBe(200);
      expect((await mine.json()).length).toBe(1);

      const senior = await harness.fetchApp('GET', `/api/treaties/${C.senior}/documents`, { headers: as(userMe) });
      expect(senior.status).toBe(expectSenior[level]);
      if (senior.status === 200) expect((await senior.json()).length).toBe(1);
    }
  });

  it('dashboard — portfolio KPI counts only the contracts the requester may read', async () => {
    for (const level of LEVELS) {
      process.env.READ_POLICY = level;
      const res = await harness.fetchApp('GET', `/api/dashboard/page/portfolio-overview?uwYear=${UW_YEAR}`, { headers: as(userMe) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kpis.contracts).toBe(VISIBLE[level].length);
    }
  });

  it('AI ops — fetchPortfolio totals only premium from readable contracts', async () => {
    // Premiums are 1/10/100/1000 so the summed total is a bitmask of the visible set.
    const expectedTotal = { assigned: 1, team: 11, office: 111, all: 1111 };
    for (const level of LEVELS) {
      process.env.READ_POLICY = level;
      const res = await harness.fetchApp('GET', `/api/cedants/${cedantC}/staging/portfolio-impact`, { headers: as(userMe) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.current.total_premium).toBe(expectedTotal[level]);
    }
  });

  it('renewal export — read scope ∩ mandate scope (senior requester, level ≤ 2)', async () => {
    // The export is gated to level ≤ 2, so the requester here is the Senior (CU)
    // in office Alpha — their office is {Me, Junior, Senior}. readableContractIds
    // is the read-scope half of the intersection the route applies.
    const seniorReq = { user: { userId: userSenior } };

    process.env.READ_POLICY = 'assigned';
    const assignedIds = await readableContractIds(seniorReq);
    expect(assignedIds).toContain(C.senior);
    expect(assignedIds).not.toContain(C.me);
    expect(assignedIds).not.toContain(C.other);

    process.env.READ_POLICY = 'office';
    const officeIds = await readableContractIds(seniorReq);
    expect(officeIds).toContain(C.me);
    expect(officeIds).toContain(C.junior);
    expect(officeIds).toContain(C.senior);
    expect(officeIds).not.toContain(C.other);

    process.env.READ_POLICY = 'all';
    expect(await readableContractIds(seniorReq)).toBeNull();

    // End-to-end: the endpoint streams an xlsx and audits the export as scoped
    // under a restricting policy, unscoped under 'all'.
    process.env.READ_POLICY = 'office';
    const scopedRes = await harness.fetchApp('GET', '/api/renewal-pack/export', { headers: as(userSenior, 'CU') });
    expect(scopedRes.status).toBe(200);
    expect(scopedRes.headers.get('content-type')).toContain('spreadsheetml');
    const scopedAudit = await pool.query(
      `SELECT payload FROM public.audit_log WHERE entity_type='PORTFOLIO' AND actor=$1 ORDER BY created_at DESC LIMIT 1`,
      [userSenior],
    );
    expect(scopedAudit.rows[0].payload).toMatchObject({ scoped: true });

    process.env.READ_POLICY = 'all';
    const openRes = await harness.fetchApp('GET', '/api/renewal-pack/export', { headers: as(userSenior, 'CU') });
    expect(openRes.status).toBe(200);
    const openAudit = await pool.query(
      `SELECT payload FROM public.audit_log WHERE entity_type='PORTFOLIO' AND actor=$1 ORDER BY created_at DESC LIMIT 1`,
      [userSenior],
    );
    // 'all' read scope + unrestricted CU mandate → full portfolio (unscoped).
    expect(openAudit.rows[0].payload).toMatchObject({ scoped: false });
  });
});
