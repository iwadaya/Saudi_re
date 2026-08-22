// server/tests/integration/facClassAccumulation.integration.test.js
//
// Class accumulation behind GET /fac/risks/:id/class-accumulation.
//
// The figures here are money an underwriter will act on, so the arithmetic is
// asserted against hand-computed values rather than snapshots: exposure at our
// share, premium NOT re-shared (ri_premium is already our share), the treaty
// signed-share fallback chain, and the fac-class → treaty-class bridge.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const d = shouldSkipDb ? describe.skip : describe;

d('fac class accumulation', () => {
  let app;
  const ids = {};

  beforeAll(async () => {
    app = await bootApp();
    const s = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

    // A treaty class, and two fac classes that both map to it — the mapping is
    // the whole point: pricing one must surface the other.
    ids.cobId = (await pool.query(
      `INSERT INTO public.class_of_business (class_of_business, code) VALUES ($1,$2) RETURNING class_of_business_id`,
      [`ACC Property ${s}`, `ACC${s}`.slice(0, 12)])).rows[0].class_of_business_id;
    // The taxonomy columns are NOT optional decoration: facSectionsAndPricing
    // asserts every fac class carries a segment, rating family and exposure
    // basis, so a fixture that omits them breaks that invariant for the whole
    // shared test database. Mirror a real PROPERTY class.
    const mkFacCob = async (name, code) => (await pool.query(
      `INSERT INTO public.fac_class_of_business
         (class_name, category, code, segment_code, rating_family, exposure_basis)
       VALUES ($1,'PROPERTY',$2,'NON_MARINE_PROPERTY','SCHEDULE_PROPERTY','SI_PER_MILLE')
       RETURNING fac_cob_id`,
      [name, code])).rows[0].fac_cob_id;
    ids.facCobA = await mkFacCob(`ACC IAR ${s}`, `A${s}`.slice(0, 12));
    ids.facCobB = await mkFacCob(`ACC PAR ${s}`, `B${s}`.slice(0, 12));
    // A third fac class deliberately left UNMAPPED, to prove the honest answer.
    ids.facCobUnmapped = await mkFacCob(`ACC Cyber ${s}`, `C${s}`.slice(0, 12));
    for (const fc of [ids.facCobA, ids.facCobB]) {
      await pool.query(
        `INSERT INTO public.fac_to_treaty_cob_map (fac_cob_id, class_of_business_id) VALUES ($1,$2)
         ON CONFLICT (fac_cob_id) DO UPDATE SET class_of_business_id = EXCLUDED.class_of_business_id`,
        [fc, ids.cobId]);
    }

    ids.broker = (await pool.query(
      `INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`, [`ACC Broker ${s}`])).rows[0].broker_id;
    ids.cedant = (await pool.query(
      `INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`ACC Cedant ${s}`])).rows[0].company_id;
    ids.country = (await pool.query(
      `INSERT INTO public.country (country_code,country_name,region) VALUES ($1,$2,'GCC') RETURNING country_id`,
      [`A${s}`.slice(0, 3).toUpperCase(), `ACC Country ${s}`])).rows[0].country_id;
    // USD so the fx leg is 1.0 and the arithmetic below is exact.
    ids.currency = (await pool.query(
      `SELECT currency_id FROM public.currency WHERE currency_code='USD' LIMIT 1`)).rows[0]?.currency_id
      ?? (await pool.query(`INSERT INTO public.currency (currency_code,currency_name) VALUES ('USD','US Dollar') RETURNING currency_id`)).rows[0].currency_id;
    ids.treatyType = (await pool.query(
      `INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'PROPORTIONAL') RETURNING treaty_type_id`,
      [`ACC QS ${s}`])).rows[0].treaty_type_id;

    const mkRisk = async ({ facCob, name, tsi, share, premium, status }) => (await pool.query(
      `INSERT INTO public.fac_risk
         (insured_name, cedant_id, country_id, currency_id, fac_cob_id,
          total_sum_insured, our_share_pct, ri_premium, status, uw_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2026) RETURNING fac_risk_id`,
      [name, ids.cedant, ids.country, ids.currency, facCob, tsi, share, premium, status])).rows[0].fac_risk_id;

    // The risk being priced — its own class (A), still a draft.
    ids.subject = await mkRisk({ facCob: ids.facCobA, name: 'ACC Subject', tsi: 200_000_000, share: 10, premium: 500_000, status: 'DRAFT' });
    // Bound, same fac class:      100m × 15% = 15,000,000 exposure, 300,000 premium
    ids.boundSame = await mkRisk({ facCob: ids.facCobA, name: 'ACC Bound Same', tsi: 100_000_000, share: 15, premium: 300_000, status: 'BOUND' });
    // Bound, SIBLING fac class:   400m × 25% = 100,000,000 exposure, 700,000 premium
    ids.boundSibling = await mkRisk({ facCob: ids.facCobB, name: 'ACC Bound Sibling', tsi: 400_000_000, share: 25, premium: 700_000, status: 'BOUND' });
    // Quoted — must NOT count (BOUND only).
    ids.quoted = await mkRisk({ facCob: ids.facCobA, name: 'ACC Quoted', tsi: 900_000_000, share: 50, premium: 9_000_000, status: 'QUOTED' });

    // An inforce proportional treaty on the class, signed line 40%:
    //   exposure 1bn × 0.40 = 400,000,000 ; premium (8m + 2m) × 0.40 = 4,000,000
    ids.contract = (await pool.query(
      `INSERT INTO public.contract
         (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year, uw_status,
          signed_line_pct, inception_date)
       VALUES ($1,$2,$3,$4,$5,2026,'SIGNED',40,'2026-01-01') RETURNING contract_id`,
      [ids.cedant, ids.broker, ids.country, ids.currency, ids.treatyType])).rows[0].contract_id;
    await pool.query(
      `INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id) VALUES ($1,$2)`,
      [ids.contract, ids.cobId]);
    await pool.query(
      `INSERT INTO public.contract_prop_details (contract_id, total_capacity, quota_share_epi, surplus_epi)
       VALUES ($1, 1000000000, 8000000, 2000000)`, [ids.contract]);

    // A DRAFT treaty on the same class — not a position, must be excluded.
    ids.draftContract = (await pool.query(
      `INSERT INTO public.contract (cedant_id, broker_id, country_id, currency_id, treaty_type_id, uw_year,
          uw_status, signed_line_pct, inception_date)
       VALUES ($1,$2,$3,$4,$5,2026,'DRAFT',100,'2026-01-01') RETURNING contract_id`,
      [ids.cedant, ids.broker, ids.country, ids.currency, ids.treatyType])).rows[0].contract_id;
    await pool.query(
      `INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id) VALUES ($1,$2)`,
      [ids.draftContract, ids.cobId]);
    await pool.query(
      `INSERT INTO public.contract_prop_details (contract_id, total_capacity, quota_share_epi)
       VALUES ($1, 5000000000, 99000000)`, [ids.draftContract]);
  }, 90_000);

  afterAll(async () => { await app?.close(); await closePools(); });

  const get = async (id) => {
    const res = await app.fetchApp('GET', `/api/fac/risks/${id}/class-accumulation`);
    expect(res.status).toBe(200);
    return res.json();
  };

  it('gathers bound fac risks across every fac class mapping to the same treaty class', async () => {
    const body = await get(ids.subject);
    const names = body.facRisks.map((r) => r.insuredName).sort();
    expect(names).toEqual(['ACC Bound Same', 'ACC Bound Sibling']);
    // The sibling proves the bridge: a different fac class, same treaty class.
    expect(body.facRisks.find((r) => r.insuredName === 'ACC Bound Sibling').facClassName).toMatch(/ACC PAR/);
  }, 30_000);

  it('takes fac exposure at our share and fac premium as already-shared', async () => {
    const body = await get(ids.subject);
    const same = body.facRisks.find((r) => r.insuredName === 'ACC Bound Same');
    expect(same.exposureUsd).toBeCloseTo(15_000_000, 2);   // 100m × 15%
    expect(same.premiumUsd).toBeCloseTo(300_000, 2);       // ri_premium verbatim
    const sib = body.facRisks.find((r) => r.insuredName === 'ACC Bound Sibling');
    expect(sib.exposureUsd).toBeCloseTo(100_000_000, 2);   // 400m × 25%
    expect(body.facSubtotal.exposureUsd).toBeCloseTo(115_000_000, 2);
    expect(body.facSubtotal.premiumUsd).toBeCloseTo(1_000_000, 2);
    expect(body.facSubtotal.count).toBe(2);
  }, 30_000);

  it('excludes anything not bound, and the risk being priced', async () => {
    const body = await get(ids.subject);
    const names = body.facRisks.map((r) => r.insuredName);
    expect(names).not.toContain('ACC Quoted');   // QUOTED is not committed
    expect(names).not.toContain('ACC Subject');  // never double-count the subject
  }, 30_000);

  it('takes treaty exposure and premium at the signed share, excluding drafts', async () => {
    const body = await get(ids.subject);
    expect(body.treaties).toHaveLength(1);
    const t = body.treaties[0];
    expect(t.exposureUsd).toBeCloseTo(400_000_000, 2);  // 1bn × 40%
    expect(t.premiumUsd).toBeCloseTo(4_000_000, 2);     // (8m + 2m) × 40%
    expect(body.treatySubtotal.count).toBe(1);
  }, 30_000);

  it('totals the two halves', async () => {
    const body = await get(ids.subject);
    expect(body.total.exposureUsd).toBeCloseTo(515_000_000, 2); // 115m + 400m
    expect(body.total.premiumUsd).toBeCloseTo(5_000_000, 2);    // 1m + 4m
    expect(body.total.count).toBe(3);
  }, 30_000);

  it('reports the risk being priced separately, so its contribution is visible', async () => {
    const body = await get(ids.subject);
    expect(body.currentRisk.insuredName).toBe('ACC Subject');
    expect(body.currentRisk.exposureUsd).toBeCloseTo(20_000_000, 2); // 200m × 10%
    expect(body.currentRisk.premiumUsd).toBeCloseTo(500_000, 2);
    // …and is excluded from the committed subtotal above.
    expect(body.facSubtotal.exposureUsd).toBeCloseTo(115_000_000, 2);
  }, 30_000);

  it('says why rather than showing zero when the fac class has no treaty mapping', async () => {
    const { rows } = await pool.query(
      `INSERT INTO public.fac_risk (insured_name, cedant_id, country_id, currency_id, fac_cob_id, status)
       VALUES ('ACC Unmapped', $1,$2,$3,$4,'DRAFT') RETURNING fac_risk_id`,
      [ids.cedant, ids.country, ids.currency, ids.facCobUnmapped]);
    const body = await get(rows[0].fac_risk_id);
    expect(body.unavailableReason).toMatch(/not mapped to a treaty class/i);
    expect(body.facRisks).toEqual([]);
    expect(body.treaties).toEqual([]);
    expect(body.total.exposureUsd).toBe(0);
    // The subject line still resolves, so the modal can show what it would add.
    expect(body.currentRisk.insuredName).toBe('ACC Unmapped');
  }, 30_000);

  it('404s for a risk that does not exist', async () => {
    const res = await app.fetchApp('GET', '/api/fac/risks/00000000-0000-0000-0000-0000000000ff/class-accumulation');
    expect(res.status).toBe(404);
  }, 30_000);
});
