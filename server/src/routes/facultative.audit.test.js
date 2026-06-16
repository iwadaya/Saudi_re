// server/src/routes/facultative.audit.test.js
//
// Phase 6 — fac persistence round-trip audit.
//
// For every fac persistence surface, this test exercises a full
// save → reload → save → reload cycle and asserts that:
//
//   1. POST payload_in;  GET → payload_out;    deepEqual(in, out)
//   2. POST payload_out; GET → payload_out2;   deepEqual(out, out2)
//
// Step 2 catches the silent-drift case where the first save mangles
// something the next save can no longer reproduce (Postgres re-typing,
// generated-column echoes, default-on-omit triggers, …).
//
// The test runs against a real database — gated on TEST_WITH_DB=1 so
// the default `npm run test:server` stays infra-free. The user-prompt
// requested the path `server/src/routes/facultative.audit.test.js`;
// we honour it while keeping the shouldSkipDb guard so it co-exists
// with the unit tests that already live in src/.
//
// Common drift modes this test is designed to catch:
//   • numeric(12,8) precision loss              — pick non-integer values
//   • date → ISO string vs Date object          — compare YYYY-MM-DD prefix
//   • jsonb key reordering                       — use deepEqual, not strings
//   • DEFAULT now() firing because the client omitted updated_at
//     → the second save flips an updated_at that wasn't in payload_out
//   • generated columns (total_si, fgu_incurred) included in payload
//     → 422 from the route's zod schema
//   • Arabic + diacritic text                   — UTF-8 surrogate handling
//   • numeric returned as string from pg.Pool   — Number-normalise on both sides

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/pool.js';
import { bootApp, shouldSkipDb, closePools } from '../../tests/integration/helpers.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** YYYY-MM-DD from an ISO string / Date / yyyy-mm-dd string. */
const ymd = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

/** Coerce pg numeric strings back to numbers so deepEqual works
 * regardless of whether a value came from the wire or from a fixture. */
function normalise(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value) : value;
  if (typeof value === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return ymd(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalise(value[k]);
    return out;
  }
  return value;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}

async function jsonOk(harness, method, path, body) {
  const r = await harness.fetchApp(method, path, body == null ? undefined : { body });
  if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function jsonNoBody(harness, method, path) {
  const r = await harness.fetchApp(method, path);
  if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

describe.skipIf(shouldSkipDb)('Phase 6: fac persistence round-trip audit', () => {
  let harness;
  let cedantId, brokerId, currencyId, countryId, facCobId;

  beforeAll(async () => {
    harness = await bootApp();
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    // Reference rows we'll attach the risk to. Reuse one fac_cob_id
    // throughout so the eligibility query has something to look at.
    const { rows: [country] } = await pool.query(
      `INSERT INTO public.country (country_code, country_name, region)
       VALUES ($1, $2, 'Audit') RETURNING country_id`,
      [`AUD-${suffix.slice(-6)}`, `Audit Country ${suffix}`],
    );
    countryId = country.country_id;
    const { rows: [currency] } = await pool.query(
      `INSERT INTO public.currency (currency_code, currency_name)
       VALUES ($1, $2) RETURNING currency_id`,
      [`AU${suffix.slice(-4).toUpperCase()}`, `Audit Currency ${suffix}`],
    );
    currencyId = currency.currency_id;
    const { rows: [broker] } = await pool.query(
      `INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`,
      [`Audit Broker ${suffix}`],
    );
    brokerId = broker.broker_id;
    const { rows: [cedant] } = await pool.query(
      `INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`,
      [`Audit Cedant ${suffix}`],
    );
    cedantId = cedant.company_id;
    const { rows: [fcob] } = await pool.query(
      `SELECT fac_cob_id FROM public.fac_class_of_business WHERE class_name = 'Property All Risks' LIMIT 1`,
    );
    facCobId = fcob.fac_cob_id;
  });

  afterAll(async () => {
    // Tear down what we created. Wipe any fac_risks belonging to our
    // test cedant first — if an earlier test failed mid-flight we'd
    // otherwise hit a FK violation on companies. fac_risk cascades to
    // its children so a single DELETE clears the dependency tree.
    if (cedantId) {
      await pool.query(`DELETE FROM public.fac_risk WHERE cedant_id = $1`, [cedantId]);
      await pool.query(`DELETE FROM public.companies WHERE company_id = $1`, [cedantId]);
    }
    if (brokerId) await pool.query(`DELETE FROM public.brokers WHERE broker_id = $1`, [brokerId]);
    if (currencyId) await pool.query(`DELETE FROM public.currency WHERE currency_id = $1`, [currencyId]);
    if (countryId) await pool.query(`DELETE FROM public.country WHERE country_id = $1`, [countryId]);
    if (harness) await harness.close();
    await closePools();
  });

  /**
   * Helper: make a fresh fac_risk and return its id. Uses the route
   * not direct SQL so the test exercises the same write path the UI
   * does — including any default-on-omit triggers.
   */
  async function createRisk(extra = {}) {
    const payload = {
      cedant_id: cedantId,
      broker_id: brokerId,
      country_id: countryId,
      currency_id: currencyId,
      fac_cob_id: facCobId,
      insured_name: 'Acme — مصنع البتروكيماويات',  // Arabic + en-dash
      insured_address: '17 Olaya St, Riyadh — مبنى ١٧',
      nature_of_business: 'Petrochemical manufacturing — refinería',
      inception_date: '2026-04-01',
      expiry_date: '2027-03-31',
      policy_period_months: 12,
      uw_year: 2026,
      ...extra,
    };
    const r = await harness.fetchApp('POST', '/api/fac/risks', { body: payload });
    if (!r.ok) throw new Error(`risk create failed ${r.status} ${await r.text()}`);
    const out = await r.json();
    return out.fac_risk_id;
  }

  // ── 1. fac_risk (POST + GET) ────────────────────────────────────
  it('1. fac_risk: round-trip every nullable column', async () => {
    const riskId = await createRisk();

    // Pull the freshly-created row, then PUT it back, then GET again.
    const KEYS = [
      'cedant_id', 'broker_id', 'country_id', 'currency_id',
      'insured_name', 'insured_address', 'nature_of_business', 'fac_cob_id',
      'inception_date', 'expiry_date', 'policy_period_months', 'uw_year',
      'total_sum_insured', 'pd_sum_insured', 'bi_sum_insured',
      'placement_type', 'cedant_retention_pct', 'ri_share_pct', 'our_share_pct',
      'commission_pct', 'brokerage_pct', 'taxes_pct',
      'pml_amount', 'pml_pct', 'mfl_amount', 'mfl_pct',
      'underwriter_notes',
      // Migration 079 additions
      'cedant_region', 'renewal_or_new', 'expiring_reference',
      'risk_country_zone', 'multi_location_flag', 'multi_occupancy_flag',
      'risk_location_top_address',
      'occupancy_code', 'occupancy_name', 'hazard_grade_override',
      'hazard_category', 'risk_category', 'frequency_category',
    ];

    const payloadIn = {
      cedant_id: cedantId, broker_id: brokerId, country_id: countryId, currency_id: currencyId,
      fac_cob_id: facCobId,
      insured_name: 'Acme — مصنع البتروكيماويات',
      insured_address: '17 Olaya St, Riyadh — مبنى ١٧',
      nature_of_business: 'Petrochemical manufacturing — refinería',
      inception_date: '2026-04-01', expiry_date: '2027-03-31',
      policy_period_months: 12, uw_year: 2026,
      total_sum_insured: 12345678.90, pd_sum_insured: 10000000.00, bi_sum_insured: 2345678.90,
      placement_type: 'PROPORTIONAL',
      cedant_retention_pct: 20.5, ri_share_pct: 79.5, our_share_pct: 12.345678,
      commission_pct: 17.5, brokerage_pct: 2.25, taxes_pct: 0.875,
      pml_amount: 5000000, pml_pct: 40.5, mfl_amount: 7000000, mfl_pct: 56.75,
      underwriter_notes: 'إكسس فاك — note with diacritics — café résumé',
      cedant_region: 'KSA', renewal_or_new: 'Renewal',
      expiring_reference: 'PRIOR-2025-9912',
      risk_country_zone: 'KSA - Whole Country',
      multi_location_flag: true, multi_occupancy_flag: false,
      risk_location_top_address: 'Jubail Industrial City — الجبيل الصناعية',
      occupancy_code: 102,
      occupancy_name: 'Hospitals including X-ray and other Diagnostic clinics',
      hazard_grade_override: 3, hazard_category: 'Light',
      risk_category: 1, frequency_category: 1,
    };

    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}`);
    const in1  = normalise(pick(payloadIn, KEYS));
    const back1 = normalise(pick(out1, KEYS));
    expect(back1).toEqual(in1);

    // Idempotency: re-save what we read back.
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}`, out1);
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}`);
    expect(normalise(pick(out2, KEYS))).toEqual(back1);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 2. fac_location list ────────────────────────────────────────
  it('2. fac_location: round-trip every column (MD + BI + carrier shares)', async () => {
    const riskId = await createRisk();
    const KEYS = [
      'location_name', 'address', 'cresta_zone', 'occupancy_code',
      'original_ccy', 'fx_to_sar', 'original_pd_si', 'original_bi_si',
      'pd_pml_pct', 'bi_pml_pct',
      'carrier_pd_share_pct', 'carrier_bi_share_pct',
      'pd_si', 'bi_si',
    ];
    const payloadIn = {
      locations: [
        // pd_si / bi_si are numeric(18,2) — pre-round so the fixture
        // matches what Postgres will round-trip. The original_ × fx
        // computation is the engineering convention; we just snap to
        // 2 dp before sending.
        (() => {
          const pdOrg = 1000000.50, biOrg = 250000.75, fx = 3.75123456;
          return {
            location_name: 'Jubail Plant — الجبيل',
            address: 'Industrial City, Jubail',
            cresta_zone: 'SA-EAST',
            occupancy_code: 102,
            original_ccy: 'USD', fx_to_sar: fx,
            original_pd_si: pdOrg, original_bi_si: biOrg,
            pd_pml_pct: 0.85, bi_pml_pct: 0.45,
            carrier_pd_share_pct: 0.1525, carrier_bi_share_pct: 0.1525,
            pd_si: Math.round(pdOrg * fx * 100) / 100,
            bi_si: Math.round(biOrg * fx * 100) / 100,
          };
        })(),
        {
          location_name: 'Riyadh HQ',
          address: 'Olaya St, Riyadh',
          cresta_zone: 'SA-CENTRAL',
          occupancy_code: 5,
          original_ccy: 'SAR', fx_to_sar: 1.00,
          original_pd_si: 500000, original_bi_si: 100000,
          pd_pml_pct: 0.30, bi_pml_pct: 0.20,
          carrier_pd_share_pct: 0.20, carrier_bi_share_pct: 0.20,
          pd_si: 500000, bi_si: 100000,
        },
      ],
    };

    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/locations`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/locations`);
    const in1  = payloadIn.locations.map((l) => normalise(pick(l, KEYS)));
    const back1 = out1.map((l) => normalise(pick(l, KEYS)));
    expect(back1).toEqual(in1);

    // Idempotency — re-save what we got back. The route's PUT deletes
    // and re-inserts, so the second pass exercises a fresh insert too.
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/locations`, { locations: out1 });
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/locations`);
    expect(out2.map((l) => normalise(pick(l, KEYS)))).toEqual(back1);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 3. fac_cope ─────────────────────────────────────────────────
  it('3. fac_cope: round-trip every COPE column', async () => {
    const riskId = await createRisk();
    const KEYS = [
      'construction_type', 'construction_year', 'fire_walls', 'fire_doors',
      'spatial_separation_m', 'roof_material', 'wall_material', 'floors', 'total_area_sqm',
      'occupation_description', 'process_description', 'hazard_grade', 'operating_hours',
      'sprinkler_system', 'sprinkler_type', 'fire_alarm', 'fire_brigade_distance_km',
      'extinguishers', 'hydrants', 'cctv', 'security_guards',
      'natcat_earthquake', 'natcat_flood', 'natcat_windstorm', 'natcat_other', 'exposure_notes',
      'survey_date', 'survey_provider', 'survey_rating',
    ];
    const payloadIn = {
      construction_type: 'Fire Resistive — مقاوم للحريق', construction_year: 2018,
      fire_walls: true, fire_doors: true,
      spatial_separation_m: 15.50, roof_material: 'RCC',
      wall_material: 'Concrete', floors: 4, total_area_sqm: 12345.75,
      occupation_description: 'Hospital — مستشفى',
      process_description: 'Diagnostic / surgery',
      hazard_grade: 'Light', operating_hours: '24/7',
      sprinkler_system: true, sprinkler_type: 'Wet pipe NFPA-13',
      fire_alarm: true, fire_brigade_distance_km: 2.75,
      extinguishers: true, hydrants: true, cctv: true, security_guards: true,
      natcat_earthquake: true, natcat_flood: false, natcat_windstorm: false,
      natcat_other: 'Sandstorm exposure', exposure_notes: 'Moderate; semi-arid',
      survey_date: '2026-02-15', survey_provider: 'Surveys Co — شركة المسوحات',
      survey_rating: 'Above Average',
    };
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/cope`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/cope`);
    const in1  = normalise(pick(payloadIn, KEYS));
    const back1 = normalise(pick(out1, KEYS));
    expect(back1).toEqual(in1);

    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/cope`, out1);
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/cope`);
    expect(normalise(pick(out2, KEYS))).toEqual(back1);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 4. fac_underwriting_factors ─────────────────────────────────
  it('4. fac_underwriting_factors: round-trip selections + notes', async () => {
    const riskId = await createRisk();
    const payloadIn = {
      selections: {
        CONSTRUCTION: 'Class A - RCC roof and Structure',
        AGE_OF_RISK:  'Less than 10 Years',
        SURVEY_RATING:'Average',
      },
      notes: 'Initial draft — مسودة',
    };
    await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/uw-factors`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/uw-factors`);
    expect(normalise(out1.selections)).toEqual(normalise(payloadIn.selections));
    expect(out1.notes).toEqual(payloadIn.notes);

    await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/uw-factors`, {
      selections: out1.selections, notes: out1.notes,
    });
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/uw-factors`);
    expect(normalise(out2.selections)).toEqual(normalise(out1.selections));
    expect(out2.notes).toEqual(out1.notes);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 5. fac_loss_history ─────────────────────────────────────────
  it('5. fac_loss_history: round-trip event rows (excludes generated columns)', async () => {
    const riskId = await createRisk();
    const KEYS = [
      'loss_year', 'loss_date', 'loss_description', 'cause_of_loss',
      'fgu_paid', 'fgu_outstanding', 'mitigation_measures', 'is_open',
    ];
    const payloadIn = {
      losses: [
        {
          loss_year: 2024, loss_date: '2024-06-15',
          loss_description: 'Boiler fire — حريق غلاية',
          cause_of_loss: 'Fire',
          fgu_paid: 125000.75, fgu_outstanding: 25000.25,
          mitigation_measures: 'Replaced safety valves', is_open: false,
        },
        {
          loss_year: 2023, loss_date: '2023-01-08',
          loss_description: 'Roof leak — تسرب',
          cause_of_loss: 'Storm',
          fgu_paid: 0.50, fgu_outstanding: 49999.50,
          mitigation_measures: 'Resealed', is_open: true,
        },
      ],
    };
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/losses`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/losses`);
    const in1  = payloadIn.losses.map((l) => normalise(pick(l, KEYS)));
    // The route returns DESC by year — sort both sides to stabilise order.
    const back1 = out1.map((l) => normalise(pick(l, KEYS)));
    expect(back1.sort((a, b) => a.loss_year - b.loss_year))
      .toEqual(in1.sort((a, b) => a.loss_year - b.loss_year));

    // Idempotency — make sure the generated columns (fgu_incurred,
    // ri_incurred) don't sneak into the next payload and 422.
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/losses`, {
      losses: out1.map((l) => pick(l, KEYS)),
    });
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/losses`);
    expect(out2.map((l) => normalise(pick(l, KEYS))).sort((a, b) => a.loss_year - b.loss_year))
      .toEqual(back1);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 6. fac_clauses_checklist ────────────────────────────────────
  it('6. fac_clauses_checklist: round-trip per-clause ticks + comments', async () => {
    const riskId = await createRisk();
    const payloadIn = {
      items: [
        { clause_code: 'LM7',          is_checked: true,  comments: 'Attached as Annex A' },
        { clause_code: 'LMA_3100',     is_checked: true,  comments: null },
        { clause_code: 'NMA_2919',     is_checked: false, comments: 'To be agreed — يُتفق عليه لاحقاً' },
        { clause_code: 'NMA_2915',     is_checked: true,  comments: 'Standard wording' },
      ],
    };
    await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/clauses-checklist`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/clauses-checklist`);
    // Map back to (code → {checked, comments}) for stable comparison.
    const toMap = (items) => Object.fromEntries(
      items.map((x) => [x.clause_code, { is_checked: x.is_checked, comments: x.comments ?? null }]),
    );
    const inMap = toMap(payloadIn.items);
    const outMap = toMap(out1.items.filter((x) => inMap[x.clause_code]));
    expect(outMap).toEqual(inMap);

    // Idempotency: re-POST what we got back. The route bulk-upserts so
    // missing items survive — assert nothing dropped.
    await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/clauses-checklist`, {
      items: out1.items.map((x) => pick(x, ['clause_code', 'is_checked', 'comments'])),
    });
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/clauses-checklist`);
    expect(toMap(out2.items)).toEqual(toMap(out1.items));

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 7. fac_pricing ──────────────────────────────────────────────
  it('7. fac_pricing: round-trip engine inputs + outputs + Summary edits', async () => {
    const riskId = await createRisk();
    const KEYS = [
      // Legacy dual-engine
      'market_rate_per_mille', 'market_premium', 'market_source',
      'actuarial_method', 'actuarial_rate_per_mille', 'actuarial_premium',
      'expected_loss_ratio', 'loading_pct',
      'market_weight_pct', 'actuarial_weight_pct',
      'blended_rate_per_mille', 'blended_premium',
      'final_rate_per_mille', 'final_premium',
      'uw_adjustment_pct', 'uw_adjustment_reason',
      'burning_cost_ratio', 'avg_loss_years',
      // Migration 082 — engine inputs
      'indemnity_months', 'commission_pct', 'margin_pct', 'other_expenses_pct',
      'extra_cover_loadings', 'market_rate_pm',
      // Migration 082 — engine outputs
      'technical_rate_pm', 'total_rate_pm', 'bi_rate_pm', 'net_rate_pm',
      'final_net_rate_pm', 'final_gross_rate_pm',
      'technical_premium', 'expected_premium',
      'underwriting_score', 'capacity_grade', 'uw_action',
      'max_capacity_pct', 'max_capacity_sar',
      'market_vs_tech_pct', 'market_vs_tech_band',
      'engine_version', 'engine_warnings',
      // Migration 084 — Summary edits
      'capacity_proposed_pct', 'accepted_rate_pm', 'uw_note',
    ];
    const payloadIn = {
      market_rate_per_mille: 0.150,
      market_premium: 250000.50, market_source: 'Broker indication',
      actuarial_method: 'BURNING_COST',
      actuarial_rate_per_mille: 0.18750000, actuarial_premium: 312500.25,
      expected_loss_ratio: 0.625, loading_pct: 0.225,
      market_weight_pct: 60, actuarial_weight_pct: 40,
      blended_rate_per_mille: 0.16500000, blended_premium: 275000.00,
      final_rate_per_mille:   0.18150000, final_premium:   302500.00,
      uw_adjustment_pct: 5.5, uw_adjustment_reason: 'NatCat exposure — تعرض',
      burning_cost_ratio: 0.42, avg_loss_years: 5,
      indemnity_months: 12, commission_pct: 0.20, margin_pct: 0.05, other_expenses_pct: 0.005,
      extra_cover_loadings: [
        { label: 'Terrorism', pct: 0.05 },
        { label: 'Strikes & Riots', pct: 0.03 },
      ],
      market_rate_pm: 0.15000000,
      technical_rate_pm: 0.15000000, total_rate_pm: 0.18150000,
      bi_rate_pm: 0.29493750, net_rate_pm: 0.18150000,
      final_net_rate_pm: 0.18150000, final_gross_rate_pm: 0.24362416,
      technical_premium: 250000.00, expected_premium: 300000.50,
      underwriting_score: 71.06, capacity_grade: 'E', uw_action: 'ACCEPT',
      max_capacity_pct: 0.7000, max_capacity_sar: 35000000.00,
      market_vs_tech_pct: 0.4200, market_vs_tech_band: 'Between 40% to 50%',
      engine_version: '1.0.0', engine_warnings: ['sample warning'],
      capacity_proposed_pct: 0.1500, accepted_rate_pm: 0.22000000,
      uw_note: 'Bind at 22‰ — حدد عند ٢٢‰',
    };
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/pricing`, payloadIn);
    const out1 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/pricing`);
    expect(normalise(pick(out1, KEYS))).toEqual(normalise(pick(payloadIn, KEYS)));

    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/pricing`, out1);
    const out2 = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/pricing`);
    expect(normalise(pick(out2, KEYS))).toEqual(normalise(pick(out1, KEYS)));

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 8. fac_document (metadata only) ─────────────────────────────
  it('8. fac_document: round-trip metadata via the JSON POST', async () => {
    const riskId = await createRisk();
    const KEYS = ['doc_type', 'file_name', 'file_path', 'file_size', 'mime_type', 'notes'];
    const payloadIn = {
      doc_type: 'SURVEY_REPORT', file_name: 'survey-aug-12 — تقرير.pdf',
      file_path: 'fac/audit/survey.pdf', file_size: 192345,
      mime_type: 'application/pdf', notes: 'Annual survey — مسح سنوي',
    };
    const created = await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/documents`, payloadIn);
    const back1 = normalise(pick(created, KEYS));
    const in1   = normalise(pick(payloadIn, KEYS));
    expect(back1).toEqual(in1);

    const list = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/documents`);
    expect(list).toHaveLength(1);
    expect(normalise(pick(list[0], KEYS))).toEqual(in1);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 9. fac_document_analysis + fac_ai_recommendation ────────────
  it('9. fac_document_analysis + fac_ai_recommendation: list + detail', async () => {
    const riskId = await createRisk();
    // The AI route requires OpenAI; instead we exercise the same write
    // path the runner uses via lib/facDocAi.js by inserting directly.
    const { rows: [doc] } = await pool.query(
      `INSERT INTO public.fac_document (fac_risk_id, doc_type, file_name, document_kind)
       VALUES ($1, 'SURVEY_REPORT', $2, 'SURVEY_REPORT') RETURNING document_id`,
      [riskId, 'audit-survey.pdf'],
    );
    const { rows: [an] } = await pool.query(
      `INSERT INTO public.fac_document_analysis
         (document_id, fac_risk_id, analysis_kind, status, summary,
          extracted, started_at, completed_at)
       VALUES ($1, $2, 'SURVEY_REPORT', 'SUCCEEDED',
               'Good survey — تقرير جيد',
               $3::jsonb, now(), now())
       RETURNING analysis_id`,
      [doc.document_id, riskId, JSON.stringify({ cedant_name: 'ACME', amount: 1234.56 })],
    );
    await pool.query(
      `INSERT INTO public.fac_ai_recommendation
         (analysis_id, fac_risk_id, target_screen, target_field,
          suggested_value, rationale, confidence, status)
       VALUES ($1, $2, 'FAC_PRICING', 'factor.CONSTRUCTION',
               $3::jsonb, 'Class A roof', 0.875, 'PENDING')`,
      [an.analysis_id, riskId, JSON.stringify('Class A - RCC roof and Structure')],
    );

    const list = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/analyses`);
    expect(list.analyses).toHaveLength(1);
    expect(list.analyses[0].status).toBe('SUCCEEDED');
    expect(list.analyses[0].recommendation_count).toBe(1);
    expect(list.analyses[0].pending_count).toBe(1);

    const detail = await jsonNoBody(harness, 'GET', `/api/fac/analysis/${an.analysis_id}`);
    expect(detail.analysis.summary).toBe('Good survey — تقرير جيد');
    expect(normalise(detail.analysis.extracted)).toEqual(
      normalise({ cedant_name: 'ACME', amount: 1234.56 }),
    );
    expect(detail.recommendations).toHaveLength(1);
    expect(detail.recommendations[0].suggested_value).toBe('Class A - RCC roof and Structure');

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 10. fac_treaty_link ─────────────────────────────────────────
  it('10. fac_treaty_link: eligible → create → list → delete', async () => {
    const riskId = await createRisk();
    // Eligibility query needs a BOUND treaty with matching cedant +
    // overlapping cob. Create one inline.
    const { rows: [tt] } = await pool.query(
      `INSERT INTO public.treaty_type (treaty_type, category)
       VALUES ($1, 'NON_PROPORTIONAL') RETURNING treaty_type_id`,
      [`Audit XL ${Date.now()}`],
    );
    const { rows: [cob] } = await pool.query(
      `SELECT class_of_business_id FROM public.class_of_business WHERE class_of_business = 'Property' LIMIT 1`,
    );
    const { rows: [contract] } = await pool.query(
      `INSERT INTO public.contract
         (cedant_id, broker_id, currency_id, country_id, treaty_type_id, uw_year, status, inception_date, renewal_date)
       VALUES ($1, $2, $3, $4, $5, 2026, 'BOUND'::contract_status, '2026-01-01', '2026-12-31')
       RETURNING contract_id`,
      [cedantId, brokerId, currencyId, countryId, tt.treaty_type_id],
    );
    await pool.query(
      `INSERT INTO public.contract_class_of_business (contract_id, class_of_business_id)
       VALUES ($1, $2)`,
      [contract.contract_id, cob.class_of_business_id],
    );

    const eligible = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/eligible-treaties`);
    expect(eligible.treaties.length).toBeGreaterThanOrEqual(1);
    expect(eligible.treaties.some((t) => t.contract_id === contract.contract_id)).toBe(true);

    const link = await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/treaty-links`, {
      contract_id: contract.contract_id,
      link_type: 'VOLUNTARY_OVER_TREATY',
      capacity_used: 2500000.50,
      notes: 'Top-up — تعزيز',
    });
    expect(link.link_type).toBe('VOLUNTARY_OVER_TREATY');

    const list = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}/treaty-links`);
    expect(list.links).toHaveLength(1);
    expect(normalise(list.links[0].capacity_used)).toBe(2500000.50);
    expect(list.links[0].notes).toBe('Top-up — تعزيز');

    // Duplicate → 409
    const dup = await harness.fetchApp('POST', `/api/fac/risks/${riskId}/treaty-links`,
      { body: { contract_id: contract.contract_id, link_type: 'INFORMATIONAL' } });
    expect(dup.status).toBe(409);

    // Delete
    const del = await harness.fetchApp('DELETE',
      `/api/fac/risks/${riskId}/treaty-links/${link.link_id}`);
    expect(del.status).toBe(200);

    // Cleanup contracts
    await pool.query(`DELETE FROM public.contract WHERE contract_id = $1`, [contract.contract_id]);
    await pool.query(`DELETE FROM public.treaty_type WHERE treaty_type_id = $1`, [tt.treaty_type_id]);
    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  // ── 11. fac_risk status transitions ─────────────────────────────
  it('11a. status: submit-for-approval (Grade A) → QUOTED → bind → BOUND', async () => {
    const riskId = await createRisk();
    // Seed minimal pricing so the submit endpoint passes its precondition.
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/pricing`, {
      underwriting_score: 96, capacity_grade: 'A', final_gross_rate_pm: 0.2,
    });

    const submit = await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/submit-for-approval`, {});
    expect(submit.status).toBe('QUOTED');
    expect(submit.routed_to_senior).toBe(false);

    const bind = await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/bind`,
      { effective_date: '2026-06-01' });
    expect(bind.status).toBe('BOUND');
    expect(bind.bound_reference).toMatch(/^FAC-\d{4}-\d{5}$/);

    const reload = await jsonNoBody(harness, 'GET', `/api/fac/risks/${riskId}`);
    expect(reload.status).toBe('BOUND');
    expect(reload.bound_reference).toBe(bind.bound_reference);

    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  it('11b. status: submit-for-approval (Grade I) → REFERRED', async () => {
    const riskId = await createRisk();
    await jsonOk(harness, 'PUT', `/api/fac/risks/${riskId}/pricing`, {
      underwriting_score: 52, capacity_grade: 'I',
    });
    const submit = await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/submit-for-approval`, {});
    expect(submit.status).toBe('REFERRED');
    expect(submit.routed_to_senior).toBe(true);
    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });

  it('11c. status: decline requires reason ≥ 5 chars', async () => {
    const riskId = await createRisk();
    const bad = await harness.fetchApp('POST', `/api/fac/risks/${riskId}/decline`, { body: {} });
    expect(bad.status).toBe(422);

    const ok = await jsonOk(harness, 'POST', `/api/fac/risks/${riskId}/decline`,
      { reason: 'Not within mandate — خارج الصلاحية' });
    expect(ok.status).toBe('DECLINED');
    await harness.fetchApp('DELETE', `/api/fac/risks/${riskId}`);
  });
});
