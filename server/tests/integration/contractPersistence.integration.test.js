// server/tests/integration/contractPersistence.integration.test.js
//
// Contract persistence audit: save every route-backed contract surface,
// rehydrate through the API where a reader exists, and assert table rows
// directly for write-only surfaces. Skipped by default; run with TEST_WITH_DB=1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';

const n = (value) => Number(value);
function ymd(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}
const hasDate = (value, expected) => expect(ymd(value)).toBe(expected);

async function expectOk(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function jsonOk(response, label) {
  return await (await expectOk(response, label)).json();
}

async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  expect(rows.length).toBe(1);
  return rows[0];
}

async function many(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

describe.skipIf(shouldSkipDb)('integration: contract save and rehydrate every route-backed table', () => {
  let harness;
  let refs;
  const createdContracts = [];
  const createdDocs = [];
  const createdSnapshots = [];

  beforeAll(async () => {
    harness = await bootApp();
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const codeSuffix = suffix.replace(/[^a-z0-9]/gi, '').slice(-12).toUpperCase();
    const [country, currency, broker, cedant, treatyType, cob1, cob2] = await Promise.all([
      one(
        `INSERT INTO public.country (country_code, country_name, region)
         VALUES ($1, $2, $3) RETURNING country_id`,
        [`Z${codeSuffix}`, `Persist Country ${suffix}`, 'Audit Region'],
      ),
      one(
        `INSERT INTO public.currency (currency_code, currency_name)
         VALUES ($1, $2) RETURNING currency_id`,
        [`X${codeSuffix}`, `Persist Currency ${suffix}`],
      ),
      one(
        `INSERT INTO public.brokers (broker_name)
         VALUES ($1) RETURNING broker_id`,
        [`Persist Broker ${suffix}`],
      ),
      one(
        `INSERT INTO public.companies (company_name)
         VALUES ($1) RETURNING company_id`,
        [`Persist Cedant ${suffix}`],
      ),
      one(
        `INSERT INTO public.treaty_type (treaty_type, category)
         VALUES ($1, 'NON_PROPORTIONAL') RETURNING treaty_type_id`,
        [`Persist Treaty Type ${suffix}`],
      ),
      one(
        `INSERT INTO public.class_of_business (class_of_business, code)
         VALUES ($1, $2) RETURNING class_of_business_id`,
        [`Persist Property ${suffix}`, `P${codeSuffix}`],
      ),
      one(
        `INSERT INTO public.class_of_business (class_of_business, code)
         VALUES ($1, $2) RETURNING class_of_business_id`,
        [`Persist Marine ${suffix}`, `M${codeSuffix}`],
      ),
    ]);

    refs = {
      countryId: country.country_id,
      currencyId: currency.currency_id,
      brokerId: broker.broker_id,
      cedantId: cedant.company_id,
      treatyTypeId: treatyType.treaty_type_id,
      cob1: cob1.class_of_business_id,
      cob2: cob2.class_of_business_id,
    };
  });

  afterAll(async () => {
    for (const snapshotId of createdSnapshots) {
      try { await harness.fetchApp('DELETE', `/api/pricing/component-snapshot/${snapshotId}`); } catch {}
    }
    for (const docId of createdDocs) {
      try { await harness.fetchApp('DELETE', `/api/documents/${docId}`); } catch {}
    }
    for (const id of createdContracts) {
      try { await harness.fetchApp('DELETE', `/api/treaties/${id}`); } catch {}
    }
    await harness.close();
    await closePools();
  });

  it('round-trips all contract, prop, loss, pricing, document, and NP surfaces', async () => {
    const created = await jsonOk(
      await harness.fetchApp('POST', '/api/treaties', {
        body: {
          uw_year: 2026,
          cedant_id: refs.cedantId,
          broker_id: refs.brokerId,
          country_id: refs.countryId,
          currency_id: refs.currencyId,
          treaty_type_id: refs.treatyTypeId,
          status: 'DRAFT',
          uw_status: 'DRAFT',
          experience_source: 'TRIANGLE',
          primary_class_of_business_id: refs.cob1,
          inception_date: '2026-01-01',
        },
      }),
      'create treaty',
    );
    const contractId = created.contract_id;
    createdContracts.push(contractId);

    const contractPayload = {
      terms: {
        header: {
          cedant_id: refs.cedantId,
          broker_id: refs.brokerId,
          currency_id: refs.currencyId,
          country_id: refs.countryId,
          treaty_type_id: refs.treatyTypeId,
          uw_year: 2026,
          status: 'OFFERED',
          // uw_status is omitted on purpose: a header save routes any uw_status
          // through the changeUwStatus chokepoint, which also syncs the legacy
          // `status` column — so setting it here would clobber status='OFFERED'.
          // The contract keeps its default DRAFT workflow state; privileged
          // states are reached via the approval engine, not a raw header save.
          experience_source: 'TRIANGLE',
          inception_date: '2026-01-01',
          renewal_date: '2027-01-01',
          signed_line_pct: 37.5,
          contract_description: 'full persistence audit treaty',
          primary_class_of_business_id: refs.cob1,
          alt_contract_id: 'EXT-AUDIT-001',
        },
        detail: {
          triangulations_available: false,
          inception_date: '2026-01-01',
          renewal_date: '2027-01-01',
          experience_start_year: 2022,
          qs_limit: 1000000,
          retention_pct: 12.5,
          retention_amt: 125000,
          cession_pct: 35,
          cession_amt: 350000,
          surplus_max_retention: 450000,
          num_lines: 4,
          total_capacity: 1800000,
          event_limit: 650000,
          aal: 12345,
          quota_share_epi: 222222,
          surplus_epi: 333333,
          brokerage_pct: 7.5,
          taxes_pct: 2.5,
          loss_cap_pct: 150,
        },
        commissions: {
          mode: 'SLIDING',
          fixed_commission_pct: 20,
          fixed_commission_qs_pct: 21,
          fixed_commission_surplus_pct: 22,
          provisional_commission_pct: 23,
          sliding_min_loss_ratio: 40,
          sliding_max_loss_ratio: 70,
          sliding_min_commission: 18,
          sliding_max_commission: 32,
          mgmt_expenses_pct: 4,
          profit_commission_pct: 5,
          lcf_years: 3,
          lcf_extinction: true,
          sliding_table: [
            { loss_ratio_pct: 45, commission_pct: 30 },
            { loss_ratio_pct: 60, commission_pct: 24 },
          ],
        },
        lossParticipation: {
          enabled: true,
          min_loss_ratio_pct: 65,
          max_loss_ratio_pct: 95,
          reinsurer_share_pct: 50,
          slides: [{ from: 65, to: 95, share: 50 }],
        },
        classIds: [refs.cob1, refs.cob2],
        epi_split: [
          { class_id: refs.cob1, premium: 123456 },
          { class_id: refs.cob2, premium: 654321 },
        ],
        underwriting_limits: [
          { class_of_business_id: refs.cob1, limit_amount: 500000, basis: 'RISK' },
          { class_of_business_id: refs.cob2, limit_amount: 900000, basis: 'CAT' },
        ],
        event_loss_tables: {
          source: 'audit',
          tables: [{ peril: 'wind', return_period: 250, loss: 1234000 }],
        },
      },
      save_mode: 'MANUAL',
    };

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}`, { body: contractPayload }),
      'save treaty composite',
    );

    const loaded = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}`), 'load treaty');
    expect(loaded.header.status).toBe('OFFERED');
    expect(loaded.header.uw_status).toBe('DRAFT');
    expect(loaded.header.contract_description).toBe('full persistence audit treaty');
    expect(loaded.header.alt_contract_id).toBe('EXT-AUDIT-001');
    expect(n(loaded.header.signed_line_pct)).toBeCloseTo(37.5);
    hasDate(loaded.header.inception_date, '2026-01-01');
    hasDate(loaded.header.renewal_date, '2027-01-01');
    expect(loaded.detail.triangulations_available).toBe(false);
    expect(n(loaded.detail.qs_limit)).toBeCloseTo(1000000);
    expect(n(loaded.detail.loss_cap_pct)).toBeCloseTo(150);
    expect(loaded.commissions.mode).toBe('SLIDING');
    expect(n(loaded.commissions.lcf_years)).toBe(3);
    expect(loaded.commissions.lcf_extinction).toBe(true);
    expect(loaded.commissions.sliding_table).toHaveLength(2);
    expect(loaded.lossParticipation.enabled).toBe(true);
    expect(loaded.lossParticipation.slides).toEqual([{ from: 65, to: 95, share: 50 }]);
    expect(new Set(loaded.class_ids)).toEqual(new Set([refs.cob1, refs.cob2]));
    expect(loaded.epi_split).toHaveLength(2);
    expect(loaded.underwriting_limits).toHaveLength(2);

    const elt = await one(
      `SELECT elt_data, data FROM public.contract_event_loss_tables WHERE contract_id=$1`,
      [contractId],
    );
    expect(elt.elt_data).toEqual(contractPayload.terms.event_loss_tables);
    expect(elt.data).toEqual(contractPayload.terms.event_loss_tables);

    await expectOk(
      await harness.fetchApp('POST', `/api/treaties/${contractId}/triangles/claims_paid`, {
        body: { cells: [
          { origin_year: 2022, dev_months: 12, cum_value: 1111 },
          { origin_year: 2022, dev_months: 24, cum_value: 2222 },
        ] },
      }),
      'save triangle',
    );
    const triangle = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/triangles/CLAIMS_PAID`),
      'load triangle',
    );
    expect(triangle.cells).toHaveLength(2);
    expect(n(triangle.cells[1].cum_value)).toBeCloseTo(2222);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/dev-factors/CLAIMS_PAID`, {
        body: { factors: [
          {
            dev_month: 12,
            selected_ldf: 1.25,
            selected_cdf: 1.8,
            actual_ldf: 1.2,
            actual_cdf: 1.7,
            param_ldf: 1.22,
            param_cdf: 1.72,
            chosen_source: 'OVERRIDE',
            chosen_ldf: 1.23,
            chosen_cdf: 1.73,
            overridden: true,
            parametrized_ldf: 1.24,
            parametrized_cdf: 1.74,
          },
        ] },
      }),
      'save dev factors',
    );
    const devFactors = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/dev-factors/CLAIMS_PAID`),
      'load dev factors',
    );
    expect(devFactors).toHaveLength(1);
    expect(devFactors[0].chosen_source).toBe('OVERRIDE');
    expect(devFactors[0].overridden).toBe(true);

    const lossRows = [
      {
        uw_year: 2024,
        insured_name: 'Audit Insured',
        loss_name: 'Audit Loss',
        date_of_loss: '2024-05-20',
        class_of_business: 'Property',
        paid: 100,
        os: 20,
        incurred: 120,
        is_selected: true,
        inflation_factor: 1.1,
        reported_date: '2024-06-01',
      },
    ];
    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/large-losses`, {
        body: { report_date: '2026-03-31', losses: lossRows },
      }),
      'save large losses',
    );
    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/cat-losses`, {
        body: { report_date: '2026-04-30', losses: [{ ...lossRows[0], loss_name: 'Audit Cat' }] },
      }),
      'save cat losses',
    );
    const large = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/large-losses`), 'load large losses');
    const cat = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/cat-losses`), 'load cat losses');
    hasDate(large.report.report_date, '2026-03-31');
    expect(large.losses[0].loss_name).toBe('Audit Loss');
    hasDate(cat.report.report_date, '2026-04-30');
    expect(cat.losses[0].loss_name).toBe('Audit Cat');

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/loss-selection/large/snapshot`, {
        body: {
          inflation_mode: 'GLOBAL',
          inflation_index: 'CPI',
          inflation_rate_pct: 3.5,
          inflation_base_year: 2024,
          inflation_to_year: 2026,
          threshold: 100000,
          global_factor: 1.12,
          loadings: { cat: 2 },
          total_loading_pct: 4.5,
          distribution_fits: { pareto: true },
          active_distribution: 'pareto',
          pareto_xm: 100000,
          pareto_alpha: 1.35,
          pareto_limit: 2000000,
          observation_years: 5,
          return_period_curve: [{ rp: 100, loss: 123 }],
          return_period_key_points: [{ key: 'pml', value: 456 }],
          assumptions_hash: 'hash-audit',
          selected_losses: lossRows,
        },
      }),
      'save loss selection',
    );
    const selection = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/loss-selection/LARGE/latest`),
      'load loss selection',
    );
    expect(selection.snapshot.assumptions_hash).toBe('hash-audit');
    expect(selection.snapshot.return_period_curve).toEqual([{ rp: 100, loss: 123 }]);
    expect(selection.items).toHaveLength(1);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/risk-profiles/${refs.cob1}`, {
        body: {
          c_value: 0.55,
          pml_percentage: 85,
          selected_curve: 'Custom',
          custom_b: 1.5,
          custom_g: 2.5,
          gross_loss_ratio: 48.25,
          bands: [{ from_amt: 0, to_amt: 100000, no_of_risks: 3, total_sum_insured: 1000000, gross_premium: 50000 }],
        },
      }),
      'save risk profile',
    );
    const risk = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/risk-profiles/${refs.cob1}`),
      'load risk profile',
    );
    expect(risk.profile.selected_curve).toBe('Custom');
    expect(n(risk.profile.gross_loss_ratio)).toBeCloseTo(48.25);
    expect(risk.bands).toHaveLength(1);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/claims-profiles/${refs.cob1}`, {
        body: {
          bands: [{ from_amt: 0, to_amt: 100000, no_of_claims: 4, aggregate_incurred: 12345, no_of_risks: 7, total_sum_insured: 2000000, gross_premium: 70000 }],
        },
      }),
      'save claims profile',
    );
    const claims = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/claims-profiles/${refs.cob1}`),
      'load claims profile',
    );
    expect(claims.bands).toHaveLength(1);
    expect(n(claims.bands[0].aggregate_incurred)).toBeCloseTo(12345);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/cresta`, {
        body: {
          treaty_type: 'QS',
          cob_id: refs.cob1,
          cob_name: 'Property',
          country_id: refs.countryId,
          rows: [
            {
              country_id: refs.countryId,
              zone_id: 'Z1',
              zone_name: 'Audit Zone',
              eq_agg: 1000,
              ws_agg: 2000,
              flood_agg: 3000,
              srcc_agg: 4000,
              others_agg: 5000,
              residential_bldg_pct: 10,
              commercial_bldg_pct: 20,
              commercial_cont_pct: 30,
              industrial_bldg_pct: 25,
              industrial_cont_pct: 15,
            },
          ],
        },
      }),
      'save cresta',
    );
    const cresta = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/cresta`), 'load cresta');
    expect(cresta).toHaveLength(1);
    expect(cresta[0].zone_id).toBe('Z1');
    expect(n(cresta[0].others_agg)).toBeCloseTo(5000);

    const form = new FormData();
    form.set('file', new Blob(['contract document body'], { type: 'text/plain' }), 'contract-audit.txt');
    form.set('description', 'contract audit document');
    form.set('doc_type', 'Final Slip');
    form.set('title', 'Audit Slip');
    const doc = await jsonOk(
      await harness.fetchApp('POST', `/api/treaties/${contractId}/documents`, { body: form }),
      'upload document',
    );
    createdDocs.push(doc.document_id);
    const docs = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/documents`), 'load documents');
    expect(docs.some((row) => row.document_id === doc.document_id && row.title === 'Audit Slip')).toBe(true);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/pricing-pattern/claims_paid`, {
        body: {
          selection_method: 'WEIGHTED',
          selected_factors: { 12: 1.2, 24: 1.1 },
          tail_factor: 1.05,
          bf_ielr: 0.62,
        },
      }),
      'save pricing pattern',
    );
    const pattern = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/pricing-pattern/claims_paid`),
      'load pricing pattern',
    );
    expect(pattern.selection_method).toBe('WEIGHTED');
    expect(pattern.selected_factors).toEqual({ 12: 1.2, 24: 1.1 });

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/pricing-outputs`, {
        body: {
          epi: 777777,
          attritional_ratio: 0.45,
          large_loss_load: 0.1,
          cat_loss_load: 0.2,
          commission_ratio: 0.25,
          brokerage_ratio: 0.075,
          tax_ratio: 0.02,
          technical_result: 12345,
          max_commission: 0.32,
          target_margin: 0.12,
        },
      }),
      'save pricing outputs',
    );
    const pricingOutputs = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/pricing-outputs`),
      'load pricing outputs',
    );
    expect(n(pricingOutputs.epi)).toBeCloseTo(777777);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/pricing-yearly`, {
        body: { rows: [
          { uw_year: 2024, ultimate_premium: 1000, ultimate_loss: 600, loss_ratio: 0.6, commission_amt: 100, brokerage_amt: 50, technical_result: 250, record_type: 'ACTUAL' },
          { uw_year: 2025, ultimate_premium: 2000, ultimate_loss: 1100, loss_ratio: 0.55, commission_amt: 200, brokerage_amt: 100, technical_result: 600, record_type: 'PROJECTED' },
        ] },
      }),
      'save pricing yearly',
    );
    const pricingYearly = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/pricing-yearly`),
      'load pricing yearly',
    );
    expect(pricingYearly).toHaveLength(2);
    expect(pricingYearly[0].record_type).toBe('ACTUAL');

    await expectOk(
      await harness.fetchApp('POST', '/api/pricing/save', {
        body: {
          contractId,
          comment: 'pricing audit comment',
          outputs: {
            epi: 888888,
            attritional_ratio: 0.44,
            large_loss_load: 0.11,
            cat_loss_load: 0.21,
            commission_ratio: 0.24,
            brokerage_ratio: 0.074,
            tax_ratio: 0.021,
            technical_result: 54321,
            max_commission: 0.31,
            target_margin: 0.13,
            status: 'DRAFT',
            offer_line: '37.5%',
            offer_comment: 'offer audit',
            offer_approver: 'CU',
            signed_line_pct: 37.5,
            actuarial_margin: 0.14,
            actual_margin: 0.15,
            uw_margin: 0.16,
          },
          yearly: [{ uw_year: 2026, ultimate_premium: 3000, ultimate_loss: 1500, loss_ratio: 0.5, commission_amt: 300, brokerage_amt: 150, technical_result: 1050, record_type: 'PROJECTED' }],
          components: [
            {
              component_name: 'Attritional',
              selected: true,
              actuarial_value: '10',
              uw_value: '11',
              market_value: '13',
              actual_stats_value: '14',
              comment: 'component audit',
              display_order: 1,
              exposure_value: '12',
            },
          ],
          leads: { lead_reinsurer: 'Lead Re', expiring_reinsurer: 'Expiring Re', lead_share_pct: 42.5 },
          share_scenarios: [
            { share_label: 'Base', limit_amt: 100, premium_amt: 20, cedant_limit: 80, agg_contrib: 3, country_agg: 4, event_limit: 5, downside_amt: 6, shortfall_amt: 7 },
          ],
        },
      }),
      'save composite pricing',
    );
    const pricing = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/pricing`), 'load pricing composite');
    expect(n(pricing.outputs.epi)).toBeCloseTo(888888);
    expect(pricing.outputs.offer_comment).toBe('offer audit');
    expect(pricing.yearly).toHaveLength(1);
    expect(pricing.components).toHaveLength(1);
    expect(pricing.components[0].component_name).toBe('Attritional');
    expect(pricing.components[0].underwriter_value).toBe('11');
    expect(pricing.components[0].uw_value).toBe('11');
    expect(pricing.components[0].market_value).toBe('13');
    expect(pricing.components[0].actual_stats_value).toBe('14');
    expect(pricing.leads.lead_reinsurer).toBe('Lead Re');
    expect(pricing.share_scenarios).toHaveLength(1);

    const snapshot = await jsonOk(
      await harness.fetchApp('POST', `/api/pricing/${contractId}/component-snapshot`, {
        body: { label: 'audit snapshot', components: [{ component_name: 'Attritional', value: 1 }], created_by: 'audit' },
      }),
      'create pricing component snapshot',
    );
    createdSnapshots.push(snapshot.id);
    const snapshots = await jsonOk(
      await harness.fetchApp('GET', `/api/pricing/${contractId}/component-snapshots`),
      'list pricing component snapshots',
    );
    expect(snapshots.some((row) => row.id === snapshot.id && row.snapshot_label === 'audit snapshot')).toBe(true);

    await expectOk(
      await harness.fetchApp('POST', `/api/treaties/${contractId}/offer`, {
        body: {
          offer: {
            written_line_pct: 37.5,
            premium_driver: 'premium driver',
            profit_driver: 'profit driver',
            strategic_rationale: 'strategic',
            tactical_rationale: 'tactical',
            next_approver: 'CU',
          },
        },
      }),
      'save offer',
    );
    const offer = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/offer`), 'load offer');
    expect(n(offer.written_line_pct)).toBeCloseTo(37.5);
    expect(offer.premium_driver).toBe('premium driver');

    await expectOk(
      await harness.fetchApp('POST', `/api/treaties/${contractId}/non-prop/save`, {
        body: {
          detail: {
            number_of_layers: 2,
            expiring_number_of_layers: 1,
            deductible: 10000,
            max_retention: 20000,
            accounting_method: 'LOD',
            xl_type: 'RISK',
            accounts: 'AUDIT',
            brokerage_pct: 7,
            taxes_pct: 2,
            no_claims_bonus_pct: 1,
            profit_commission_pct: 3,
            est_gnpi: 1500000,
            adjustment_rate: 0.05,
            deposit_premium: 75000,
            experience_start_year: 2021,
          },
          layers: [
            {
              layer_number: 1,
              attachment: 100000,
              layer_limit: 500000,
              aggregate_limit: 750000,
              egnpi: 1000000,
              earned_premium: 900000,
              rate: 5,
              rol: 10,
              num_reinstatements: 2,
              reinstatement_pct: 100,
              annual_agg_deductible: 5000,
              peril_scope: 'BOTH',
              mdp: 10000,
              mdp_pct: 1,
              hist_margin: 0.2,
              modelled_margin: 0.25,
              tech_ratio: 0.65,
              uw_price: 0.7,
              expiring_price: 0.6,
              lead_price: 0.68,
              class_of_business_ids: [refs.cob1, refs.cob2],
            },
          ],
          terms: { auditTerm: true, treaty_detail: { estGnpi: 1500000 } },
          cob_underwriting_limits: [{ cob_id: refs.cob1, limit_amount: 123000 }],
        },
      }),
      'save non-prop structure',
    );
    const np = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/non-prop`), 'load non-prop structure');
    expect(n(np.detail.est_gnpi)).toBeCloseTo(1500000);
    expect(np.layers).toHaveLength(1);
    expect(new Set(np.layers[0].class_of_business_ids)).toEqual(new Set([refs.cob1, refs.cob2]));
    expect(np.terms.auditTerm).toBe(true);
    expect(np.cob_underwriting_limits).toHaveLength(1);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/np/egnpi-year`, {
        body: { rows: [
          { uw_year: 2024, egnpi: 1000000, inflation_pct: 2.5 },
          { uw_year: 2025, egnpi: 1100000, inflation_pct: 3.5 },
        ] },
      }),
      'save EGNPI years',
    );
    const egnpi = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/np/egnpi-year`), 'load EGNPI years');
    expect(egnpi).toHaveLength(2);
    expect(n(egnpi[1].egnpi)).toBeCloseTo(1100000);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/np-pricing`, {
        body: {
          inputs: { burn_weight_pct: 40, exposure_weight_pct: 50, pareto_weight_pct: 10, pricing_loading_pct: 7, swiss_re_curve_name: 'Audit Curve' },
          layer_inputs: [{ layer_number: 1, expiring_pricing_pct: 12.5 }],
          outputs: [{ layer_number: 1, section: 'RISK', pure_burning_cost: 1, pareto_pricing: 2, burn_plus_pareto: 3, exposure_rating: 4, burn_weight_pct: 40, exposure_weight_pct: 50, pareto_weight_pct: 10, pricing_loading_pct: 7, total_price: 8, prob_attach: 0.1, prob_exhaust: 0.01 }],
          layer_margins: [{ layer_number: 1, hist_margin: 0.21, modelled_margin: 0.22, tech_ratio: 0.23, uw_price: 0.24, expiring_price: 0.25, lead_price: 0.26 }],
        },
      }),
      'save NP pricing',
    );
    const npPricing = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/np-pricing`), 'load NP pricing');
    expect(npPricing.inputs.swiss_re_curve_name).toBe('Audit Curve');
    expect(npPricing.layer_inputs).toHaveLength(1);
    expect(npPricing.outputs).toHaveLength(1);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/np/expiring`, {
        body: {
          layers: [{ layer_number: 1, attachment: 90000, layer_limit: 400000, aggregate_limit: 500000, egnpi: 800000, earned_premium: 700000, rate: 4, rol: 9, num_reinstatements: 1, reinstatement_pct: 100, annual_agg_deductible: 3000, peril_scope: 'RISK', mdp: 5000, mdp_pct: 0.5 }],
          terms: { egnpi: 800000, deductible: 9000, risk_limit: 400000, cat_limit: 0, brokerage_pct: 6, no_claims_bonus_pct: 1, profit_commission_pct: 2, notes: 'expiring audit' },
          coveredProps: [{ id: 'prop-1', label: 'covered prop' }],
        },
      }),
      'save NP expiring',
    );
    const npExpiring = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/np/expiring`), 'load NP expiring');
    expect(npExpiring.layers).toHaveLength(1);
    expect(npExpiring.terms.notes).toBe('expiring audit');
    expect(npExpiring.coveredProps).toEqual([{ id: 'prop-1', label: 'covered prop' }]);

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/np/excess-ldfs`, {
        body: { tail_factor: 1.08, factors: [{ dev_month: 12, chosen_source: 'audit', chosen_ldf: 1.2, chosen_cdf: 1.5, actual_ldf: 1.1, actual_cdf: 1.4, param_ldf: 1.15, param_cdf: 1.45 }] },
      }),
      'save NP excess LDFs',
    );
    const excessLdfs = await jsonOk(await harness.fetchApp('GET', `/api/treaties/${contractId}/np/excess-ldfs`), 'load NP excess LDFs');
    expect(excessLdfs).toHaveLength(1);
    expect(excessLdfs[0].chosen_source).toBe('audit');

    for (const lossPath of ['large-loss', 'cat-loss']) {
      await expectOk(
        await harness.fetchApp('PUT', `/api/treaties/${contractId}/np/${lossPath}-ldfs`, {
          body: {
            tail_factor: 1.09,
            ldfs: [{ dev_month: 12, chosen_ldf: 1.2, chosen_cdf: 1.5 }],
            ultimates: [{ acc_year: 2024, loss_count: 2, reported: 100, applied_cdf: 1.5, ibnr: 50, ultimate: 150 }],
          },
        }),
        `save NP ${lossPath} LDFs`,
      );
      const lossLdfs = await jsonOk(
        await harness.fetchApp('GET', `/api/treaties/${contractId}/np/${lossPath}-ldfs`),
        `load NP ${lossPath} LDFs`,
      );
      expect(lossLdfs.ldfs).toHaveLength(1);
      expect(lossLdfs.ultimates).toHaveLength(1);
    }

    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/np/historical-performance`, {
        body: { rows: [
          { uw_year: 2024, premiums: 1000, claims: 500, egnpi: 1200, result: 500, loss_ratio: 50, expense_ratio: 20, combined_ratio: 70 },
        ] },
      }),
      'save NP historical performance',
    );
    const historical = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/np/historical-performance`),
      'load NP historical performance',
    );
    expect(historical).toHaveLength(1);
    expect(n(historical[0].combined_ratio)).toBeCloseTo(70);

    // straight-stats requires a PROPORTIONAL treaty, but this contract is
    // NON_PROPORTIONAL (it hosts the NP surfaces above). Round-trip the straight
    // experience on a sibling proportional contract so both category-guarded
    // surfaces stay covered by this persistence test.
    const propTreatyType = await one(
      `INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'PROPORTIONAL') RETURNING treaty_type_id`,
      [`Persist Prop TType ${Date.now()}`],
    );
    const straightContract = await jsonOk(
      await harness.fetchApp('POST', '/api/treaties', {
        body: {
          uw_year: 2026, cedant_id: refs.cedantId, broker_id: refs.brokerId,
          country_id: refs.countryId, currency_id: refs.currencyId,
          treaty_type_id: propTreatyType.treaty_type_id, status: 'DRAFT',
          inception_date: '2026-01-01',
        },
      }),
      'create proportional sibling for straight stats',
    );
    const straightContractId = straightContract.contract_id;
    createdContracts.push(straightContractId);

    await expectOk(
      await harness.fetchApp('POST', '/api/straight-stats/save', {
        body: {
          contractId: straightContractId,
          tailType: 'LONG_TAIL',
          stats: [{ underwriting_year: 2022, premium: 1000, paid_claims: 300, os_claims: 200 }],
        },
      }),
      'save straight stats',
    );
    const straight = await jsonOk(await harness.fetchApp('GET', `/api/straight-stats/load/${straightContractId}`), 'load straight stats');
    expect(straight.tail_type).toBe('LONG_TAIL');
    expect(straight.stats).toHaveLength(1);

    const directContractTables = [
      'contract',
      'contract_prop_details',
      'contract_commissions',
      'contract_commission_slides',
      'contract_loss_participation',
      'contract_class_of_business',
      'contract_epi_split',
      'contract_underwriting_limit',
      'contract_event_loss_tables',
      'contract_triangle_cells',
      'contract_dev_factor',
      'contract_large_loss_report',
      'contract_cat_loss_report',
      'contract_loss_selection_snapshot',
      'contract_risk_profile',
      'contract_claims_profile',
      'contract_cresta_data',
      'contract_document',
      'contract_pricing_patterns',
      'contract_pricing_outputs',
      'contract_pricing_yearly',
      'pricing_components',
      'pricing_leads',
      'pricing_share_scenarios',
      'pricing_component_snapshots',
      'contract_offer',
      'contract_np_details',
      'contract_np_layers',
      'contract_np_terms',
      'contract_np_egnpi_year',
      'contract_np_pricing_inputs',
      'contract_np_pricing_layer_inputs',
      'contract_np_pricing_outputs',
      'contract_np_expiring_layers',
      'contract_np_expiring_terms',
      'contract_np_excess_ldf',
      'contract_np_large_loss_ldf',
      'contract_np_large_loss_ultimate',
      'contract_np_cat_loss_ldf',
      'contract_np_cat_loss_ultimate',
      'contract_np_historical_performance',
      'contract_straight_experience',
      'contract_straight_uw_stats',
    ];

    for (const table of directContractTables) {
      // straight-experience tables live on the proportional sibling; everything
      // else (including the NP tables) lives on the main NON_PROPORTIONAL contract.
      const id = table.startsWith('contract_straight_') ? straightContractId : contractId;
      const rows = await many(`SELECT 1 FROM public.${table} WHERE contract_id=$1 LIMIT 1`, [id]);
      expect(rows.length, `${table} should have saved rows for ${id}`).toBe(1);
    }

    const secondLevelChecks = [
      {
        label: 'contract_large_losses',
        sql: `SELECT 1 FROM public.contract_large_losses l
              JOIN public.contract_large_loss_report r ON r.report_id=l.report_id
              WHERE r.contract_id=$1 LIMIT 1`,
      },
      {
        label: 'contract_cat_losses',
        sql: `SELECT 1 FROM public.contract_cat_losses l
              JOIN public.contract_cat_loss_report r ON r.report_id=l.report_id
              WHERE r.contract_id=$1 LIMIT 1`,
      },
      {
        label: 'contract_loss_selection_snapshot_item',
        sql: `SELECT 1 FROM public.contract_loss_selection_snapshot_item i
              JOIN public.contract_loss_selection_snapshot s ON s.snapshot_id=i.snapshot_id
              WHERE s.contract_id=$1 LIMIT 1`,
      },
      {
        label: 'contract_risk_profile_band',
        sql: `SELECT 1 FROM public.contract_risk_profile_band b
              JOIN public.contract_risk_profile p ON p.profile_id=b.profile_id
              WHERE p.contract_id=$1 LIMIT 1`,
      },
      {
        label: 'contract_claims_profile_band',
        sql: `SELECT 1 FROM public.contract_claims_profile_band b
              JOIN public.contract_claims_profile p ON p.profile_id=b.profile_id
              WHERE p.contract_id=$1 LIMIT 1`,
      },
      {
        label: 'contract_np_layer_class_of_business',
        sql: `SELECT 1 FROM public.contract_np_layer_class_of_business lc
              JOIN public.contract_np_layers l ON l.layer_id=lc.layer_id
              WHERE l.contract_id=$1 LIMIT 1`,
      },
    ];

    for (const check of secondLevelChecks) {
      const rows = await many(check.sql, [contractId]);
      expect(rows.length, `${check.label} should have saved rows for ${contractId}`).toBe(1);
    }

    // ── Finding 1 (HIGH): a re-save that OMITS is_selected/inflation_factor —
    // as the loss-list grid does — must preserve the previously-saved values,
    // not reset them to true/1. (Appended last; uses full-replace saves.) ──
    const llBefore = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/large-losses`),
      'load large losses (preserve setup)',
    );
    const preserveId = llBefore.losses[0].loss_id;
    // Selection-screen save: deselect + set inflation 1.5 on the existing loss.
    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/large-losses`, {
        body: { report_date: '2026-03-31', losses: [{
          loss_id: preserveId, uw_year: 2024, insured_name: 'Audit Insured', loss_name: 'Audit Loss',
          date_of_loss: '2024-05-20', class_of_business: 'Property', paid: 100, os: 20, incurred: 120,
          is_selected: false, inflation_factor: 1.5,
        }] },
      }),
      'save large losses (deselect + inflate)',
    );
    // Loss-list grid save: omits is_selected and inflation_factor entirely.
    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/large-losses`, {
        body: { report_date: '2026-03-31', losses: [{
          loss_id: preserveId, uw_year: 2024, insured_name: 'Audit Insured', loss_name: 'Audit Loss',
          date_of_loss: '2024-05-20', class_of_business: 'Property', paid: 100, os: 20, incurred: 120,
        }] },
      }),
      'resave large losses omitting selection/inflation',
    );
    const llAfter = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/large-losses`),
      'reload large losses (preserve check)',
    );
    expect(llAfter.losses[0].is_selected).toBe(false);            // preserved, not reset to true
    expect(n(llAfter.losses[0].inflation_factor)).toBeCloseTo(1.5); // preserved, not reset to 1

    // ── Finding 4 (MEDIUM): a loss with no uw_year and an invalid
    // policy_inception_date must not 500 (NaN into the integer column). ──
    const badYear = await harness.fetchApp('PUT', `/api/treaties/${contractId}/large-losses`, {
      body: { report_date: '2026-03-31', losses: [{
        insured_name: 'Bad Year', loss_name: 'Bad Year', date_of_loss: '2024-05-20',
        class_of_business: 'Property', incurred: 50, policy_inception_date: 'not-a-date',
      }] },
    });
    expect(badYear.status).toBeLessThan(500);

    // ── Finding 2 (MEDIUM): writes to a non-existent / malformed id return
    // 404 / 400, not 500. ──
    const missing = await harness.fetchApp('PUT', '/api/treaties/00000000-0000-0000-0000-0000000000ff/large-losses', {
      body: { report_date: '2026-03-31', losses: [] },
    });
    expect(missing.status).toBe(404);
    const badId = await harness.fetchApp('PUT', '/api/treaties/not-a-uuid/large-losses', {
      body: { report_date: '2026-03-31', losses: [] },
    });
    expect(badId.status).toBe(400);

    // ── Loss-selection staleness (migration 114) ──
    // Large losses were re-saved (above) after the loss-selection snapshot was
    // saved, so the selection is now stale.
    const lossStale = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/losses/staleness`),
      'loss staleness (stale)',
    );
    expect(lossStale.selectionSavedAt).not.toBeNull();
    expect(lossStale.stale).toBe(true);
    // Re-saving the selection snapshot clears the staleness.
    await expectOk(
      await harness.fetchApp('PUT', `/api/treaties/${contractId}/loss-selection/large/snapshot`, {
        body: { selected_losses: [] },
      }),
      're-save loss selection',
    );
    const lossFresh = await jsonOk(
      await harness.fetchApp('GET', `/api/treaties/${contractId}/losses/staleness`),
      'loss staleness (fresh)',
    );
    expect(lossFresh.stale).toBe(false);
  });
});
