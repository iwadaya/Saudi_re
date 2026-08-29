// DB-backed coverage for pricingAggregateRepository (F20 + F21). The unit
// tests next door mock pool.query, so the SQL itself was never executed by the
// suite — exactly how both defects survived. These run the real queries against
// the migration-built test DB. Gated by TEST_WITH_DB=1 like tests/integration.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, closePools } from '../../../db/pool.js';
import {
  getMarketAverage, getAggDrilldown, getAggCobBreakdown, getCountryAggregates,
} from './pricingAggregateRepository.js';

const shouldSkipDb = process.env.TEST_WITH_DB !== '1';

describe.skipIf(shouldSkipDb)('pricingAggregateRepository (DB)', () => {
  const s = `AGGDB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ids = { contracts: [] };

  async function mkContract(countryId) {
    const { rows } = await pool.query(
      `INSERT INTO public.contract (cedant_id,broker_id,country_id,currency_id,treaty_type_id,uw_year,uw_status,inception_date)
       VALUES ($1,$2,$3,$4,$5,2026,'SIGNED','2026-01-01') RETURNING contract_id`,
      [ids.cedant, ids.broker, countryId || ids.testland, ids.currency, ids.tt]);
    ids.contracts.push(rows[0].contract_id);
    return rows[0].contract_id;
  }

  beforeAll(async () => {
    ids.testland = (await pool.query(
      `INSERT INTO public.country (country_code,country_name,region,is_active) VALUES ($1,$2,'R',false) RETURNING country_id`,
      [`T${s}`.slice(0, 3), `Agg Testland ${s}`])).rows[0].country_id;
    ids.kenya = (await pool.query(
      `INSERT INTO public.country (country_code,country_name,region,is_active) VALUES ($1,$2,'R',false) RETURNING country_id`,
      [`K${s}`.slice(0, 3), `Agg Kenya ${s}`])).rows[0].country_id;
    ids.currency = (await pool.query(`SELECT currency_id FROM public.currency WHERE currency_code='USD' LIMIT 1`)).rows[0]?.currency_id
      ?? (await pool.query(`INSERT INTO public.currency (currency_code,currency_name) VALUES ('USD','US Dollar') RETURNING currency_id`)).rows[0].currency_id;
    ids.broker = (await pool.query(
      `INSERT INTO public.brokers (broker_name,is_active) VALUES ($1,false) RETURNING broker_id`, [`Agg B ${s}`])).rows[0].broker_id;
    ids.cedant = (await pool.query(
      `INSERT INTO public.companies (company_name,is_active) VALUES ($1,false) RETURNING company_id`, [`Agg C ${s}`])).rows[0].company_id;
    ids.tt = (await pool.query(
      `INSERT INTO public.treaty_type (treaty_type,category,is_active) VALUES ($1,'PROPORTIONAL',false) RETURNING treaty_type_id`,
      [`Agg QS ${s}`])).rows[0].treaty_type_id;

    // ── F20 fixtures: 3 contracts, Commissions 20/30/50%, EPI 1M/3M/0 ──
    // Premium-weighted commissions = (0.20×1M + 0.30×3M) / 4M = 0.275.
    ids.m1 = await mkContract();
    ids.m2 = await mkContract();
    ids.m3 = await mkContract();
    const fixtures = [[ids.m1, 1_000_000, '20%'], [ids.m2, 3_000_000, '30%'], [ids.m3, 0, '50%']];
    for (const [c, epi, comm] of fixtures) {
      await pool.query(`INSERT INTO public.contract_prop_details (contract_id, quota_share_epi) VALUES ($1,$2)`, [c, epi]);
      await pool.query(`INSERT INTO public.pricing_components (contract_id, component_name, actuarial_value) VALUES ($1,'Commissions',$2)`, [c, comm]);
    }

    // ── F21 fixtures: a two-country contract in the same test country ──
    //   C1: 1.5M in Testland Z1 (the drilldown subject)
    //   C2: 2M Testland Z1 + a 7M slice whose country_id is KENYA (zone KE-1)
    //   C4: 3M Testland Z2
    // In-country truth: 6.5M total; 5M excluding C1.
    ids.c1 = await mkContract();
    ids.c2 = await mkContract();
    ids.c4 = await mkContract();
    const slice = (contract, country, zone, eq) => pool.query(
      `INSERT INTO public.contract_cresta_data (contract_id, country_id, zone_id, zone_name, eq_agg)
       VALUES ($1,$2,$3,$3,$4)`, [contract, country, zone, eq]);
    await slice(ids.c1, ids.testland, 'Z1', 1_500_000);
    await slice(ids.c2, ids.testland, 'Z1', 2_000_000);
    await slice(ids.c2, ids.kenya, 'KE-1', 7_000_000);
    await slice(ids.c4, ids.testland, 'Z2', 3_000_000);
  }, 60_000);

  afterAll(async () => {
    for (const c of ids.contracts) {
      await pool.query('DELETE FROM public.pricing_components WHERE contract_id=$1', [c]);
      await pool.query('DELETE FROM public.contract_prop_details WHERE contract_id=$1', [c]);
      await pool.query('DELETE FROM public.contract_cresta_data WHERE contract_id=$1', [c]);
      await pool.query('DELETE FROM public.contract WHERE contract_id=$1', [c]);
    }
    if (ids.tt) await pool.query('DELETE FROM public.treaty_type WHERE treaty_type_id=$1', [ids.tt]);
    if (ids.cedant) await pool.query('DELETE FROM public.companies WHERE company_id=$1', [ids.cedant]);
    if (ids.broker) await pool.query('DELETE FROM public.brokers WHERE broker_id=$1', [ids.broker]);
    await pool.query('DELETE FROM public.country WHERE country_id IN ($1,$2)', [ids.testland, ids.kenya]);
    await closePools();
  }, 60_000);

  describe('getMarketAverage — one junk component value must not kill the tiers (F20)', () => {
    it('computes the premium-weighted average on a clean book', async () => {
      const r = await getMarketAverage(ids.testland, null, { treatyTypeId: ids.tt });
      expect(r.tier).toBe(2);
      expect(r.contractCount).toBe(3);
      expect(r.components.Commissions).toBeCloseTo(0.275, 10);
    });

    it("drops ONE row — not every tier — when a cell holds 'TBD'", async () => {
      await pool.query(
        `INSERT INTO public.pricing_components (contract_id, component_name, actuarial_value) VALUES ($1,'Brokerage','TBD')`,
        [ids.m1]);
      try {
        const r = await getMarketAverage(ids.testland, null, { treatyTypeId: ids.tt });
        // The clean component is unaffected…
        expect(r.tier).toBe(2);
        expect(r.contractCount).toBe(3);
        expect(r.components.Commissions).toBeCloseTo(0.275, 10);
        // …and the junk-only component simply contributes nothing.
        expect(r.components.Brokerage).toBeUndefined();
      } finally {
        await pool.query(
          `DELETE FROM public.pricing_components WHERE contract_id=$1 AND component_name='Brokerage'`, [ids.m1]);
      }
    });

    it('still parses %, comma and whitespace decorated numerics', async () => {
      await pool.query(
        `INSERT INTO public.pricing_components (contract_id, component_name, actuarial_value) VALUES ($1,'Loss Ratio',' 1,250.5 % ')`,
        [ids.m2]);
      try {
        const r = await getMarketAverage(ids.testland, null, { treatyTypeId: ids.tt });
        // Only M2 carries it → single-contract weighted average = 1250.5/100.
        expect(r.components['Loss Ratio']).toBeCloseTo(12.505, 10);
      } finally {
        await pool.query(
          `DELETE FROM public.pricing_components WHERE contract_id=$1 AND component_name='Loss Ratio'`, [ids.m2]);
      }
    });
  });

  describe('country portfolio filters CRESTA slices by country (F21)', () => {
    it('getCountryAggregates states the in-country truth (control)', async () => {
      const agg = await getCountryAggregates(ids.testland);
      expect(Number(agg.total_country_agg)).toBe(6_500_000);
    });

    it('getAggDrilldown portfolio zones exclude other countries’ slices and agree with getCountryAggregates', async () => {
      const dd = await getAggDrilldown(ids.c1);
      const zoneIds = dd.portfolio.zones.map((z) => z.zone_id);
      expect(zoneIds).not.toContain('KE-1'); // the Kenyan slice of C2
      const total = dd.portfolio.zones.reduce((t, z) => t + Number(z.total_agg), 0);
      expect(total).toBe(6_500_000);
      const cobTotal = dd.portfolio.cob.reduce((t, z) => t + Number(z.total_agg), 0);
      expect(cobTotal).toBe(6_500_000);
    });

    it('getAggCobBreakdown country_others counts only in-country slices of other contracts', async () => {
      const cb = await getAggCobBreakdown(ids.c1);
      const total = cb.country_others.reduce((t, r) => t + Number(r.total_agg), 0);
      expect(total).toBe(5_000_000); // 2M (C2 Testland) + 3M (C4) — NOT the 7M Kenyan slice
    });
  });
});
