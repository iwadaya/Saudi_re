// server/tests/integration/facPlaces.integration.test.js
//
// The address-lookup proxy over real HTTP, plus the geocode round-trip on
// fac_risk. Google itself is never called: with no GOOGLE_MAPS_API_KEY the
// routes fail closed, which is exactly the posture a deployment without a key
// runs in, and is the behaviour most worth pinning.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootApp, seedRefs, shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';

const d = shouldSkipDb ? describe.skip : describe;

d('fac address lookup + geocode persistence', () => {
  let app, refs;

  beforeAll(async () => {
    app = await bootApp();
    refs = await seedRefs({ category: 'PROPORTIONAL' });
    delete process.env.GOOGLE_MAPS_API_KEY; // the unconfigured posture
  }, 60_000);

  afterAll(async () => { await app?.close(); await closePools(); });

  describe('the proxy', () => {
    it('reports itself unconfigured so the form can fall back to plain text', async () => {
      const res = await app.fetchApp('GET', '/api/fac/places/status');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ configured: false });
    });

    it('fails closed with 503 rather than attempting a keyless call', async () => {
      const res = await app.fetchApp('POST', '/api/fac/places/suggest', {
        body: { input: '12 King Fahd Road' },
      });
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe('PLACES_NOT_CONFIGURED');
    });

    it('validates the body before anything else', async () => {
      const res = await app.fetchApp('POST', '/api/fac/places/suggest', { body: {} });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');

      const res2 = await app.fetchApp('POST', '/api/fac/places/details', { body: {} });
      expect(res2.status).toBe(400);
      expect((await res2.json()).code).toBe('VALIDATION_FAILED');
    });

    it('requires an authenticated user', async () => {
      // No x-user-* headers → anonymous. The blanket requireAuth answers first.
      const res = await app.fetchApp('POST', '/api/fac/places/suggest', {
        headers: { 'x-user-role': '', 'x-user-id': '' },
        body: { input: 'anything' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('geocode round-trip on a risk', () => {
    it('stores and returns coordinates picked from a suggestion', async () => {
      const created = await (await app.fetchApp('POST', '/api/fac/risks', {
        body: {
          insured_name: 'IT Geocoded Risk',
          insured_address: '12 King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
          insured_address_lat: 24.6911,
          insured_address_lng: 46.6853,
          insured_address_place_id: 'PLACE_ABC',
          ...refs,
        },
      })).json();
      const id = created.fac_risk_id;
      expect(id).toBeTruthy();
      expect(Number(created.insured_address_lat)).toBeCloseTo(24.6911, 6);
      expect(Number(created.insured_address_lng)).toBeCloseTo(46.6853, 6);
      expect(created.insured_address_place_id).toBe('PLACE_ABC');

      const fetched = await (await app.fetchApp('GET', `/api/fac/risks/${id}`)).json();
      expect(Number(fetched.insured_address_lat)).toBeCloseTo(24.6911, 6);
      expect(fetched.insured_address_place_id).toBe('PLACE_ABC');
    }, 30_000);

    it('leaves a hand-typed address with no coordinates rather than inventing them', async () => {
      const created = await (await app.fetchApp('POST', '/api/fac/risks', {
        body: { insured_name: 'IT Typed Risk', insured_address: 'Somewhere off-map', ...refs },
      })).json();
      expect(created.insured_address_lat).toBeNull();
      expect(created.insured_address_lng).toBeNull();
      expect(created.insured_address_place_id).toBeNull();
    }, 30_000);

    it('clears the coordinates when the form sends them back as null', async () => {
      // How the real form behaves: FacRiskDetail always includes the three keys
      // (`state.insured_address_lat ?? null`), so editing the address by hand
      // sends explicit nulls and the point is dropped. PUT merges, so an
      // explicit null clears while an omitted key is left alone — see
      // facRiskPartialUpdate.integration.test.js.
      const created = await (await app.fetchApp('POST', '/api/fac/risks', {
        body: {
          insured_name: 'IT Recloc Risk', insured_address: 'A place',
          insured_address_lat: 10, insured_address_lng: 20, insured_address_place_id: 'OLD',
          ...refs,
        },
      })).json();
      const id = created.fac_risk_id;

      const res = await app.fetchApp('PUT', `/api/fac/risks/${id}`, {
        body: {
          insured_name: 'IT Recloc Risk',
          insured_address: 'A different place typed by hand',
          insured_address_lat: null, insured_address_lng: null, insured_address_place_id: null,
          ...refs,
        },
      });
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT insured_address_lat, insured_address_lng, insured_address_place_id
           FROM public.fac_risk WHERE fac_risk_id = $1`, [id]);
      expect(rows[0].insured_address_lat).toBeNull();
      expect(rows[0].insured_address_lng).toBeNull();
      expect(rows[0].insured_address_place_id).toBeNull();
    }, 30_000);

    it('leaves a stored point alone when a slice-saving screen omits the keys', async () => {
      // FacCoverageStructure / FacDeductibles / FacPricing never mention the
      // address. Their saves must not silently drop a captured location.
      const created = await (await app.fetchApp('POST', '/api/fac/risks', {
        body: {
          insured_name: 'IT Keep Coords', insured_address: 'A place',
          insured_address_lat: 24.6911, insured_address_lng: 46.6853, insured_address_place_id: 'KEEP',
          ...refs,
        },
      })).json();

      const res = await app.fetchApp('PUT', `/api/fac/risks/${created.fac_risk_id}`, {
        body: { ri_premium: 123, original_rate: 0.4 },
      });
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT insured_address_lat, insured_address_place_id FROM public.fac_risk WHERE fac_risk_id = $1`,
        [created.fac_risk_id]);
      expect(Number(rows[0].insured_address_lat)).toBeCloseTo(24.6911, 6);
      expect(rows[0].insured_address_place_id).toBe('KEEP');
    }, 30_000);

    it('rejects out-of-range coordinates', async () => {
      const res = await app.fetchApp('POST', '/api/fac/risks', {
        body: {
          insured_name: 'IT Bad Coords', insured_address: 'x',
          insured_address_lat: 999, insured_address_lng: 0, ...refs,
        },
      });
      expect(res.status).toBe(400);
    }, 30_000);
  });
});
