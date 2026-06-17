// server/tests/integration/quotes.integration.test.js
//
// Stateful integration test. Creates a quote, saves terms, reads them
// back, and deletes. Exercises:
//   • POST   /api/quotes
//   • PUT    /api/quotes/:id (Zod-validated body)
//   • GET    /api/quotes/:id
//   • GET    /api/quotes (pagination headers)
//   • DELETE /api/quotes/:id
//
// Gated by TEST_WITH_DB=1 — see helpers.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

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

describe.skipIf(shouldSkipDb)('integration: /api/quotes end-to-end', () => {
  let harness;
  let refs;
  const createdQuoteIds = [];

  // Seed real FK targets once. Migration 104 made cedant/broker/currency/
  // country/treaty_type NOT NULL on quote, so every create body must carry
  // them or the INSERT 500s. Spread `...refs` into each POST body.
  async function seedRefs() {
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const code = suffix.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();
    const [country, currency, broker, cedant, treatyType] = await Promise.all([
      pool.query(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'R') RETURNING country_id`, [`Z${code}`, `Q Country ${suffix}`]),
      pool.query(`INSERT INTO public.currency (currency_code, currency_name) VALUES ($1,$2) RETURNING currency_id`, [`X${code}`, `Q Currency ${suffix}`]),
      pool.query(`INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`, [`Q Broker ${suffix}`]),
      pool.query(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`Q Cedant ${suffix}`]),
      pool.query(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'NON_PROPORTIONAL') RETURNING treaty_type_id`, [`Q TType ${suffix}`]),
    ]);
    return {
      cedant_id: cedant.rows[0].company_id,
      broker_id: broker.rows[0].broker_id,
      currency_id: currency.rows[0].currency_id,
      country_id: country.rows[0].country_id,
      treaty_type_id: treatyType.rows[0].treaty_type_id,
    };
  }

  beforeAll(async () => { harness = await bootApp(); refs = await seedRefs(); });

  afterAll(async () => {
    for (const id of createdQuoteIds) {
      try { await harness.fetchApp('DELETE', `/api/quotes/${id}`); } catch {}
    }
    await harness.close();
    await closePools();
  });

  it('creates, saves partial terms, reads back, and deletes a quote', async () => {
    // CREATE
    const createRes = await harness.fetchApp('POST', '/api/quotes', {
      body: {
        ...refs,
        uw_year: 2026,
        status: 'DRAFT',
        experience_source: 'TRIANGLE',
        renewal_date: '2026-12-31',
        inception_date: '2026-01-01',
        contract_description: 'created quote header',
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.quote_id).toBeTruthy();
    expect(created.quote_ref).toMatch(/^QT-2026-/);
    expect(created.contract_description).toBe('created quote header');
    createdQuoteIds.push(created.quote_id);
    const quoteId = created.quote_id;

    // PATCH header only (partial-save)
    const patchRes = await harness.fetchApp('PUT', `/api/quotes/${quoteId}`, {
      body: {
        terms: {
          header: {
            uw_year: 2027,
            status: 'DRAFT',
            contract_description: 'integration-test',
            inception_date: '2027-01-01',
          },
        },
      },
    });
    expect(patchRes.status).toBe(200);

    // READ BACK
    const getRes = await harness.fetchApp('GET', `/api/quotes/${quoteId}`);
    expect(getRes.status).toBe(200);
    const loaded = await getRes.json();
    expect(loaded.header.uw_year).toBe(2027);
    expect(loaded.header.contract_description).toBe('integration-test');
    expect(ymd(loaded.header.inception_date)).toBe('2027-01-01');
  });

  it('rejects an invalid save payload with 400 + fields[]', async () => {
    // The edit-lock guard runs before body validation, so the invalid payload
    // must target a real, caller-owned quote to reach the validator.
    const q = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, inception_date: '2026-01-01' },
    }).then((r) => r.json());
    createdQuoteIds.push(q.quote_id);
    const bad = await harness.fetchApp('PUT', `/api/quotes/${q.quote_id}`, {
      body: { terms: { header: { uw_year: 2026, status: 'BANANA' } } },
    });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.fields)).toBe(true);
    expect(body.fields.some((f) => f.path.includes('status'))).toBe(true);
  });

  it('list returns X-Total-Count + X-Page-Size headers', async () => {
    const res = await harness.fetchApp('GET', '/api/quotes?limit=5');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-total-count')).toMatch(/^\d+$/);
    expect(res.headers.get('x-page-size')).toBe('5');
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeLessThanOrEqual(5);
  });

  it('honours If-Unmodified-Since with a stale timestamp (409 STALE_WRITE)', async () => {
    const created = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, inception_date: '2026-01-01' },
    }).then((r) => r.json());
    createdQuoteIds.push(created.quote_id);

    const first = await harness.fetchApp('GET', `/api/quotes/${created.quote_id}`).then((r) => r.json());
    const staleTs = first.updated_at;

    // Save once — moves updated_at forward
    await harness.fetchApp('PUT', `/api/quotes/${created.quote_id}`, {
      body: { terms: { header: { contract_description: 'bump 1' } } },
    });

    // Same old timestamp → 409
    const staleSave = await harness.fetchApp('PUT', `/api/quotes/${created.quote_id}`, {
      headers: { 'if-unmodified-since': staleTs },
      body: { terms: { header: { contract_description: 'bump 2' } } },
    });
    expect(staleSave.status).toBe(409);
    const body = await staleSave.json();
    expect(body.code).toBe('STALE_WRITE');
    expect(body.current).toBeTruthy();
    expect(body.expected).toBeTruthy();
  });

  it('round-trips NP quote final structures and records negotiation snapshots', async () => {
    const created = await harness.fetchApp('POST', '/api/quotes', {
      body: {
        ...refs,
        uw_year: 2026,
        status: 'DRAFT',
        experience_source: 'TRIANGLE',
        contract_description: 'np final quote persistence',
        inception_date: '2026-01-01',
      },
    }).then((r) => r.json());
    createdQuoteIds.push(created.quote_id);

    const saveRes = await harness.fetchApp('POST', `/api/quotes/${created.quote_id}/non-prop/save`, {
      body: {
        detail: {
          number_of_layers: 1,
          expiring_number_of_layers: 1,
          est_gnpi: 5000000,
          structures_to_quote: 2,
        },
        terms: {
          np_final_pricing: {
            quotePricing: { selectedCurve: 'country' },
            fqScaffolding: {
              clientStructures: [
                {
                  id: 'structure-a',
                  quoteType: 'INDICATIVE',
                  leadLinePct: '',
                  followLinePct: '12.5',
                  layers: [
                    {
                      id: 'layer-a1',
                      limit: '1000000',
                      attachment: '250000',
                      egnpi: '5000000',
                      risk: true,
                      cat: false,
                      pureBurn: '2.50%',
                      pareto: '0.50%',
                      exposure: '3.00%',
                      wtBurn: '50%',
                      wtPareto: '0%',
                      loading: '15%',
                      uwPrice: '4.00%',
                      pAttach: '20%',
                      pExhaust: '5%',
                    },
                  ],
                },
              ],
              approvedStructures: [true],
              expProbabilities: [{ pAttach: '20%', pExhaust: '5%' }],
            },
          },
        },
      },
    });
    expect(saveRes.status).toBe(200);

    const loaded = await harness.fetchApp('GET', `/api/quotes/${created.quote_id}/non-prop`).then((r) => r.json());
    expect(Number(loaded.detail.structures_to_quote)).toBe(2);
    expect(loaded.terms.np_final_pricing.fqScaffolding.clientStructures[0].id).toBe('structure-a');
    expect(loaded.terms.np_final_pricing.fqScaffolding.approvedStructures).toEqual([true]);
    // Per-structure quote type + single lead/follow line round-trip.
    const loadedStructure = loaded.terms.np_final_pricing.fqScaffolding.clientStructures[0];
    expect(loadedStructure.quoteType).toBe('INDICATIVE');
    expect(loadedStructure.followLinePct).toBe('12.5');
    expect(loadedStructure.leadLinePct).toBe('');

    const { rows: structureRows } = await pool.query(
      `SELECT s.structure_no, s.selected_for_approval, s.quote_type, s.lead_line_pct, s.follow_line_pct,
              l.layer_limit, l.attachment, l.risk, l.cat
         FROM public.quote_np_final_structure s
         JOIN public.quote_np_final_structure_layer l
           ON l.quote_id=s.quote_id AND l.structure_no=s.structure_no
        WHERE s.quote_id=$1`,
      [created.quote_id],
    );
    expect(structureRows).toHaveLength(1);
    expect(structureRows[0].selected_for_approval).toBe(true);
    expect(Number(structureRows[0].layer_limit)).toBe(1000000);
    expect(Number(structureRows[0].attachment)).toBe(250000);
    expect(structureRows[0].risk).toBe(true);
    expect(structureRows[0].cat).toBe(false);
    // Dedicated per-structure columns: INDICATIVE → follow_line_pct set, lead null.
    expect(structureRows[0].quote_type).toBe('INDICATIVE');
    expect(Number(structureRows[0].follow_line_pct)).toBe(12.5);
    expect(structureRows[0].lead_line_pct).toBeNull();

    const history = await harness.fetchApp('GET', `/api/quotes/${created.quote_id}/negotiation-history`).then((r) => r.json());
    expect(history.events.some((event) => event.event_type === 'QUOTE_FINAL_PRICING_SAVED')).toBe(true);
  });

  it('round-trips NP quote historical performance rows', async () => {
    const created = await harness.fetchApp('POST', '/api/quotes', {
      body: {
        ...refs,
        uw_year: 2026,
        status: 'DRAFT',
        contract_description: 'np quote historical performance',
        inception_date: '2026-01-01',
      },
    }).then((r) => r.json());
    createdQuoteIds.push(created.quote_id);

    const saveRes = await harness.fetchApp('PUT', `/api/quotes/${created.quote_id}/np/historical-performance`, {
      body: {
        rows: [
          {
            uw_year: 2024,
            premiums: 1000000,
            claims: 420000,
            egnpi: 1250000,
            result: 580000,
            loss_ratio: 42,
            expense_ratio: 10,
            combined_ratio: 52,
          },
        ],
      },
    });
    expect(saveRes.status).toBe(200);

    const loadRes = await harness.fetchApp('GET', `/api/quotes/${created.quote_id}/np/historical-performance`);
    expect(loadRes.status).toBe(200);
    const rows = await loadRes.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].uw_year).toBe(2024);
    expect(Number(rows[0].premiums)).toBe(1000000);
    expect(Number(rows[0].combined_ratio)).toBe(52);
  });

  it('POST without inception_date → 400 VALIDATION_FAILED (migration 104 hard gate)', async () => {
    const res = await harness.fetchApp('POST', '/api/quotes', {
      body: { uw_year: 2026 },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.error).toMatch(/inception_date/);
  });

  it('saving terms.detail.renewal_date updates quote header — NOT quote_prop_details (migration 104 source-of-truth)', async () => {
    const created = await harness.fetchApp('POST', '/api/quotes', {
      body: { ...refs, uw_year: 2026, inception_date: '2026-01-01', renewal_date: '2026-12-31' },
    }).then((r) => r.json());
    createdQuoteIds.push(created.quote_id);

    await harness.fetchApp('PUT', `/api/quotes/${created.quote_id}`, {
      body: {
        terms: {
          header: { uw_year: 2026 },
          detail: { renewal_date: '2027-06-01', qs_limit: 1_000_000 },
        },
      },
    });

    const { rows: quoteRows } = await pool.query(
      `SELECT renewal_date FROM public.quote WHERE quote_id=$1`,
      [created.quote_id],
    );
    expect(ymd(quoteRows[0].renewal_date)).toBe('2027-06-01');

    const { rows: detailRows } = await pool.query(
      `SELECT renewal_date FROM public.quote_prop_details WHERE quote_id=$1`,
      [created.quote_id],
    );
    // Detail row exists (we wrote qs_limit) but renewal_date isn't
    // touched on the detail table anymore.
    expect(detailRows[0]).toBeTruthy();
    expect(detailRows[0].renewal_date).toBeNull();

    const get = await harness.fetchApp('GET', `/api/quotes/${created.quote_id}`);
    const loaded = await get.json();
    expect(ymd(loaded.detail.renewal_date)).toBe('2027-06-01');
  });

  it('direct INSERT with NULL cedant_id → NOT NULL violation (migration 104 applied)', async () => {
    await expect(
      pool.query(
        `INSERT INTO public.quote (uw_year, status, cedant_id, broker_id, currency_id, country_id, treaty_type_id, inception_date)
         VALUES (2026, 'DRAFT', NULL, NULL, NULL, NULL, NULL, '2026-01-01')`,
      ),
    ).rejects.toThrow(/null value in column/);
  });

  it('POST /quotes/:id/renew rolls inception forward and never produces a null inception (migration 104)', async () => {
    // Seed real FK targets so the parent quote satisfies the NOT NULL
    // identifying columns. The renew INSERT used to omit inception_date
    // entirely and 500 on the NOT NULL constraint.
    const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const code = suffix.replace(/[^a-z0-9]/gi, '').slice(-10).toUpperCase();
    const [country, currency, broker, cedant, treatyType] = await Promise.all([
      pool.query(`INSERT INTO public.country (country_code, country_name, region) VALUES ($1,$2,'R') RETURNING country_id`, [`Z${code}`, `Renew Country ${suffix}`]),
      pool.query(`INSERT INTO public.currency (currency_code, currency_name) VALUES ($1,$2) RETURNING currency_id`, [`X${code}`, `Renew Currency ${suffix}`]),
      pool.query(`INSERT INTO public.brokers (broker_name) VALUES ($1) RETURNING broker_id`, [`Renew Broker ${suffix}`]),
      pool.query(`INSERT INTO public.companies (company_name) VALUES ($1) RETURNING company_id`, [`Renew Cedant ${suffix}`]),
      pool.query(`INSERT INTO public.treaty_type (treaty_type, category) VALUES ($1,'NON_PROPORTIONAL') RETURNING treaty_type_id`, [`Renew TType ${suffix}`]),
    ]);
    const { rows: seeded } = await pool.query(
      `INSERT INTO public.quote (uw_year, status, cedant_id, broker_id, currency_id, country_id, treaty_type_id, inception_date, renewal_date)
       VALUES (2026, 'DRAFT', $1, $2, $3, $4, $5, '2026-01-01', '2027-01-01') RETURNING quote_id`,
      [cedant.rows[0].company_id, broker.rows[0].broker_id, currency.rows[0].currency_id, country.rows[0].country_id, treatyType.rows[0].treaty_type_id],
    );
    const origId = seeded[0].quote_id;
    createdQuoteIds.push(origId);

    const renewRes = await harness.fetchApp('POST', `/api/quotes/${origId}/renew`, { body: {} });
    expect(renewRes.status).toBe(201);
    const renewed = await renewRes.json();
    createdQuoteIds.push(renewed.quote_id);

    // Inception must be non-null and rolled to the original renewal date;
    // the year derives from that new inception (2027).
    expect(renewed.inception_date).toBeTruthy();
    expect(ymd(renewed.inception_date)).toBe('2027-01-01');
    expect(renewed.uw_year).toBe(2027);

    const { rows: dbRows } = await pool.query(`SELECT inception_date FROM public.quote WHERE quote_id=$1`, [renewed.quote_id]);
    expect(dbRows[0].inception_date).not.toBeNull();
  });

  it('POST /quotes/:id/non-prop/save against a missing quote_id → 404 (no stub row fabricated)', async () => {
    const res = await harness.fetchApp('POST', '/api/quotes/00000000-0000-0000-0000-000000000000/non-prop/save', {
      body: { detail: { number_of_layers: 1 } },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});
