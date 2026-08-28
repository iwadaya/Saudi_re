// server/tests/integration/facAccumulationGuards.integration.test.js
//
// Two committed-exposure defects in the fac accumulation stack:
//
//   F27 — vendorExposure used to read fac_cyber_dependency, a table nothing
//   writes, so the systemic cyber vendor check always answered "not carried
//   anywhere else in the bound book". It now aggregates the SAME source the
//   quoted side reads: fac_risk_section.exposure_detail.dependencies on BOUND
//   risks, at our share.
//
//   F35 — the TREATY leg of mv_fac_accumulation had no status predicate, so
//   DRAFT / DECLINED / NTU / CANCELLED contracts counted as committed zone
//   capacity. Migration 149 adds the live-book filter the dashboard and class
//   accumulation already use.
//
// Gated by TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { vendorExposure } from '../../src/services/facAccumulationService.js';

describe.skipIf(shouldSkipDb)('integration: fac accumulation committed-exposure guards', () => {
  const s = `FACC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ids = { risks: [], contracts: [] };

  beforeAll(async () => {
    ids.cedant = (await pool.query(
      `INSERT INTO public.companies (company_name,is_active) VALUES ($1,false) RETURNING company_id`,
      [`FACC Cedant ${s}`])).rows[0].company_id;
    ids.broker = (await pool.query(
      `INSERT INTO public.brokers (broker_name,is_active) VALUES ($1,false) RETURNING broker_id`,
      [`FACC Broker ${s}`])).rows[0].broker_id;
    ids.country = (await pool.query(
      `INSERT INTO public.country (country_code,country_name,region,is_active) VALUES ($1,$2,'R',false) RETURNING country_id`,
      [`V${s}`.slice(0, 3), `FACC Country ${s}`])).rows[0].country_id;
    ids.currency = (await pool.query(`SELECT currency_id FROM public.currency WHERE currency_code='USD' LIMIT 1`)).rows[0]?.currency_id
      ?? (await pool.query(`INSERT INTO public.currency (currency_code,currency_name) VALUES ('USD','US Dollar') RETURNING currency_id`)).rows[0].currency_id;
    ids.tt = (await pool.query(
      `INSERT INTO public.treaty_type (treaty_type,category,is_active) VALUES ($1,'PROPORTIONAL',false) RETURNING treaty_type_id`,
      [`FACC QS ${s}`])).rows[0].treaty_type_id;
    ids.cob = (await pool.query(
      `INSERT INTO public.fac_class_of_business
         (class_name, category, code, segment_code, rating_family, exposure_basis, is_active)
       VALUES ($1,'CYBER',$2,'SPECIALTY','CYBER_LIMIT','LIMIT',false) RETURNING fac_cob_id`,
      [`FACC Cyber ${s}`, `V${s}`.slice(0, 12)])).rows[0].fac_cob_id;
  }, 60_000);

  afterAll(async () => {
    for (const r of ids.risks) {
      await pool.query('DELETE FROM public.fac_risk_section WHERE fac_risk_id=$1', [r]);
      await pool.query('DELETE FROM public.fac_risk WHERE fac_risk_id=$1', [r]);
    }
    for (const c of ids.contracts) {
      await pool.query('DELETE FROM public.contract_cresta_data WHERE contract_id=$1', [c]);
      await pool.query('DELETE FROM public.contract WHERE contract_id=$1', [c]);
    }
    if (ids.cob) await pool.query('DELETE FROM public.fac_class_of_business WHERE fac_cob_id=$1', [ids.cob]);
    if (ids.tt) await pool.query('DELETE FROM public.treaty_type WHERE treaty_type_id=$1', [ids.tt]);
    if (ids.country) await pool.query('DELETE FROM public.country WHERE country_id=$1', [ids.country]);
    if (ids.broker) await pool.query('DELETE FROM public.brokers WHERE broker_id=$1', [ids.broker]);
    if (ids.cedant) await pool.query('DELETE FROM public.companies WHERE company_id=$1', [ids.cedant]);
    // Leave the shared view clean of this file's treaty fixtures.
    await pool.query('REFRESH MATERIALIZED VIEW public.mv_fac_accumulation').catch(() => {});
    await closePools();
  }, 60_000);

  describe('vendorExposure reads bound sections’ dependency tags (F27)', () => {
    const mkRisk = async (name, share, status) => {
      const { rows } = await pool.query(
        `INSERT INTO public.fac_risk (insured_name, cedant_id, country_id, fac_cob_id, our_share_pct, status, uw_year)
         VALUES ($1,$2,$3,$4,$5,$6,2026) RETURNING fac_risk_id`,
        [name, ids.cedant, ids.country, ids.cob, share, status]);
      ids.risks.push(rows[0].fac_risk_id);
      return rows[0].fac_risk_id;
    };
    const mkSection = (risk, no, limit, deps) => pool.query(
      `INSERT INTO public.fac_risk_section (fac_risk_id, section_no, fac_cob_id, rating_family, limit_amount, exposure_detail)
       VALUES ($1,$2,$3,'CYBER_LIMIT',$4,$5)`,
      [risk, no, ids.cob, limit, JSON.stringify({ dependencies: deps })]);

    let r1;

    beforeAll(async () => {
      const V = `AWS-${s}`; // unique per run so a shared DB can't interfere
      ids.vendor = V.toUpperCase();
      // Two BOUND risks share the vendor:
      //   R1: limit 10M at 40% share → 4M committed (bare-string tag, lowercase)
      //   R2: limit  5M at 100%      → 5M committed (object tag)
      r1 = await mkRisk('FACC Bound A', 40, 'BOUND');
      const r2 = await mkRisk('FACC Bound B', 100, 'BOUND');
      const r3 = await mkRisk('FACC Quoted', 100, 'QUOTED');
      await mkSection(r1, 1, 10_000_000, [V.toLowerCase()]);
      await mkSection(r2, 1, 5_000_000, [{ vendor_key: V, criticality: 'CRITICAL' }]);
      // Non-critical tag on a bound risk — excluded, like fac_cyber_dependency's
      // criticality filter was meant to.
      await mkSection(r2, 2, 99_000_000, [{ vendor_key: `OKTA-${s}`, criticality: 'INCIDENTAL' }]);
      // A quoted risk on the vendor — not committed, must not count.
      await mkSection(r3, 1, 77_000_000, [V]);
    }, 60_000);

    it('sums bound risks sharing the vendor, at our share', async () => {
      const rows = await vendorExposure([ids.vendor], null);
      expect(rows).toHaveLength(1);
      expect(rows[0].vendor_key).toBe(ids.vendor);
      expect(rows[0].committed_limit).toBeCloseTo(9_000_000, 2); // 10M×40% + 5M×100%
      expect(rows[0].risk_count).toBe(2);
    });

    it('excludes non-critical tags and unbound risks', async () => {
      const rows = await vendorExposure([`OKTA-${s}`.toUpperCase()], null);
      expect(rows).toEqual([]); // the INCIDENTAL tag contributes nothing
    });

    it('excludes the risk being re-checked', async () => {
      const rows = await vendorExposure([ids.vendor], r1);
      expect(rows).toHaveLength(1);
      expect(rows[0].committed_limit).toBeCloseTo(5_000_000, 2);
      expect(rows[0].risk_count).toBe(1);
    });
  });

  describe('mv_fac_accumulation treaty leg counts only the live book (F35 / migration 149)', () => {
    const zone = `FACC-ZONE-${s}`;

    const mkContract = async (uwStatus, status, eq) => {
      const { rows } = await pool.query(
        `INSERT INTO public.contract (cedant_id,broker_id,country_id,currency_id,treaty_type_id,uw_year,uw_status,status,inception_date)
         VALUES ($1,$2,$3,$4,$5,2026,$6,$7::public.contract_status,'2026-01-01') RETURNING contract_id`,
        [ids.cedant, ids.broker, ids.country, ids.currency, ids.tt, uwStatus, status]);
      ids.contracts.push(rows[0].contract_id);
      await pool.query(
        `INSERT INTO public.contract_cresta_data (contract_id, country_id, zone_id, zone_name, eq_agg)
         VALUES ($1,$2,$3,$3,$4)`, [rows[0].contract_id, ids.country, zone, eq]);
      return rows[0].contract_id;
    };

    it('excludes DRAFT / DECLINED / NTU / CANCELLED and keeps SIGNED / BOUND', async () => {
      await mkContract('DRAFT', 'DRAFT', 1_000_000);            // not yet a position
      await mkContract('DECLINED', 'DECLINED', 2_000_000);      // never went on risk
      await mkContract('NTU', 'NTU', 4_000_000);                // fell through
      await mkContract('SIGNED', 'CANCELLED', 8_000_000);       // cancelled after signing
      await mkContract('SIGNED', 'SIGNED', 16_000_000);         // in force
      await mkContract('AWAITING_SIGNED_LINE', 'BOUND', 32_000_000); // bound

      await pool.query('REFRESH MATERIALIZED VIEW public.mv_fac_accumulation');
      const { rows } = await pool.query(
        `SELECT committed_si, risk_count FROM public.mv_fac_accumulation
          WHERE cresta_zone=$1 AND source_kind='TREATY'`, [zone]);

      expect(rows).toHaveLength(1);
      expect(Number(rows[0].committed_si)).toBe(48_000_000); // 16M + 32M only
      expect(Number(rows[0].risk_count)).toBe(2);
    }, 60_000);
  });
});
