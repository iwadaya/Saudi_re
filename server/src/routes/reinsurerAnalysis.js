// server/src/routes/reinsurerAnalysis.js
//
// Portfolio-wide reinsurer pricing analysis. Surfaces every NP layer across the
// bound book, attributed to the treaty's lead reinsurer, as a flat list of
// pricing points — the natural unit for fitting a power-law (ROL vs. limit)
// curve per reinsurer. Each point carries enough structural context (cedant,
// country/region, treaty type, peril scope, classes of business) for the client
// to slice the cloud any which way.
//
// Only bound contracts are in scope (an NP layer with a row in
// public.contract_np_details, attributed via public.pricing_leads.lead_reinsurer).
// Layers are filtered to a usable shape — a named lead reinsurer plus positive
// limit, attachment, and EGNPI — so the returned points are all curve-fittable.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Hard cap on returned points. A power-law fit saturates well before this, and
// the cap stops a single request streaming the entire layer table through a
// pool connection. Truncation is surfaced in the response so the client can warn.
const POINT_LIMIT = 8000;

// GET /api/reinsurer-analysis
//
// Returns { points, reinsurers, cobs, treatyTypes, pointCount, treatyCount,
//           truncated, generatedAt }. One point per NP layer.
router.get(
  '/reinsurer-analysis',
  asyncHandler(async (_req, res) => {
    // One row per NP layer, attributed to its lead reinsurer, with the treaty's
    // structural context joined on. Classes of business are rolled up per
    // contract into an array via a LATERAL array_agg so a layer keeps every COB
    // its treaty carries (with the first as a convenience primary).
    const sql = `
      SELECT
        c.contract_id,
        l.layer_id,
        l.layer_number,
        pl.lead_reinsurer,
        comp.company_name AS cedant_name,
        co.country_name,
        co.region,
        c.uw_year,
        tt.treaty_type,
        l.peril_scope,
        l.attachment,
        l.layer_limit,
        l.egnpi,
        l.rol,
        cobs.cob_names
      FROM public.contract c
      INNER JOIN public.contract_np_details nd ON nd.contract_id = c.contract_id
      INNER JOIN public.pricing_leads pl ON pl.contract_id = c.contract_id
      INNER JOIN public.contract_np_layers l ON l.contract_id = c.contract_id
      LEFT JOIN public.companies comp ON comp.company_id = c.cedant_id
      LEFT JOIN public.country co ON co.country_id = c.country_id
      LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN LATERAL (
        SELECT array_agg(cob.class_of_business ORDER BY cob.class_of_business) AS cob_names
          FROM public.contract_class_of_business ccb
          JOIN public.class_of_business cob ON cob.class_of_business_id = ccb.class_of_business_id
         WHERE ccb.contract_id = c.contract_id
      ) cobs ON TRUE
      WHERE pl.lead_reinsurer IS NOT NULL
        AND btrim(pl.lead_reinsurer) <> ''
        AND l.layer_limit > 0
        AND l.attachment > 0
        AND l.egnpi > 0
      ORDER BY c.uw_year DESC, pl.lead_reinsurer, c.contract_id, l.layer_number
      LIMIT $1
    `;

    let rows;
    try {
      const result = await pool.query(sql, [POINT_LIMIT]);
      rows = result.rows;
    } catch (err) {
      logger.error('[reinsurer-analysis] query failed', { error: err.message });
      throw err;
    }

    const points = rows.map((r) => {
      const cobs = Array.isArray(r.cob_names) ? r.cob_names.filter(Boolean) : [];
      return {
        id: `${r.contract_id}:${r.layer_id}`,
        contractId: r.contract_id,
        layerId: r.layer_id,
        layerNumber: r.layer_number,
        reinsurer: r.lead_reinsurer.trim(),
        cedant: r.cedant_name || 'Unknown',
        country: r.country_name || '—',
        region: r.region || null,
        uwYear: r.uw_year,
        treatyType: r.treaty_type || null,
        perilScope: r.peril_scope || null,
        cob: cobs[0] || null,
        cobs,
        attachment: Number(r.attachment) || 0,
        limit: Number(r.layer_limit) || 0,
        egnpi: Number(r.egnpi) || 0,
        // Stored ROL is a fraction (0..1); callers want percent.
        rolPct: r.rol != null ? Number(r.rol) * 100 : 0,
      };
    });

    // Single pass over the points to derive the per-reinsurer summary plus the
    // distinct COB and treaty-type facet lists. Treaty counts are de-duplicated
    // per reinsurer via a set of contract ids.
    const reinsurerMap = new Map();
    const cobSet = new Set();
    const treatyTypeSet = new Set();

    for (const p of points) {
      let agg = reinsurerMap.get(p.reinsurer);
      if (!agg) {
        agg = { name: p.reinsurer, contractIds: new Set(), layerCount: 0 };
        reinsurerMap.set(p.reinsurer, agg);
      }
      agg.contractIds.add(p.contractId);
      agg.layerCount += 1;

      for (const cob of p.cobs) cobSet.add(cob);
      if (p.treatyType) treatyTypeSet.add(p.treatyType);
    }

    const reinsurers = Array.from(reinsurerMap.values())
      .map((r) => ({ name: r.name, treatyCount: r.contractIds.size, layerCount: r.layerCount }))
      .sort((a, b) => b.treatyCount - a.treatyCount || a.name.localeCompare(b.name));

    const cobs = Array.from(cobSet).sort((a, b) => a.localeCompare(b));
    const treatyTypes = Array.from(treatyTypeSet).sort((a, b) => a.localeCompare(b));

    const treatyCount = reinsurers.reduce((sum, r) => sum + r.treatyCount, 0);

    res.json({
      points,
      reinsurers,
      cobs,
      treatyTypes,
      pointCount: points.length,
      treatyCount,
      truncated: points.length >= POINT_LIMIT,
      generatedAt: new Date().toISOString(),
    });
  }),
);

export default router;
