// server/src/routes/peerStructures.js
//
// Peer-structure benchmark data for the per-structure analysis modal
// (FQBenchmarkModal). Given a source contract we surface every comparable
// NP treaty in the same Country / Region / Global scope, optionally
// constrained to a set of classes-of-business, with each peer's headline
// metrics (deductible, total limit, total EGNPI, limit-weighted ROL).
//
// The client side previously rendered against a mock peer pool generated
// from the source structure itself. This endpoint feeds the same UI from
// real portfolio data so percentile ranks, medians, and scatter plots
// reflect the cedant book.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';

const router = Router();

const SCOPES = new Set(['country', 'region', 'global']);

// Hard cap on returned peers per call. Even the global tab on a mature
// portfolio should fit comfortably under this — the modal's charts and
// percentile maths degrade fast past a few hundred points anyway, and
// the cap stops a single request hogging a pool connection.
const PEER_LIMIT = 400;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCobIds(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
}

// Resolve the source contract's country + region so we know which
// scope buckets to filter against. Returns null when the contract id
// doesn't resolve, leaving the caller to 404.
async function loadSourceContext(contractId) {
  const { rows } = await pool.query(
    `SELECT c.contract_id, c.country_id, c.uw_year, co.country_code, co.country_name, co.region
       FROM public.contract c
       LEFT JOIN public.country co ON co.country_id = c.country_id
      WHERE c.contract_id = $1`,
    [contractId],
  );
  return rows[0] || null;
}

// Build a parameterised WHERE that limits peers to the requested
// geographic scope. We carry the params through to the final query so
// pg can plan them as bind variables.
function scopeFilter(scope, source) {
  if (scope === 'country') {
    if (!source.country_id) return null;
    return { sql: 'c.country_id = $1 AND c.country_id IS NOT NULL', params: [source.country_id] };
  }
  if (scope === 'region') {
    if (!source.region) return null;
    return { sql: 'co.region = $1', params: [source.region] };
  }
  // global — no geographic filter, just NP and excluding self.
  return { sql: 'TRUE', params: [] };
}

// GET /api/treaties/:contractId/peer-structures
//   ?scope=country|region|global
//   &cobIds=uuid1,uuid2,...
//
// Returns { sourceContract, scope, peers: [...], peerCount }.
router.get(
  '/treaties/:contractId/peer-structures',
  asyncHandler(async (req, res) => {
    const { contractId } = req.params;
    if (!UUID_RE.test(contractId)) {
      return res.status(400).json({ error: 'Invalid contract id', code: 'VALIDATION_FAILED' });
    }

    const scope = String(req.query.scope || 'country').toLowerCase();
    if (!SCOPES.has(scope)) {
      return res.status(400).json({ error: 'scope must be country, region, or global', code: 'VALIDATION_FAILED' });
    }

    const cobIds = parseCobIds(req.query.cobIds);

    const source = await loadSourceContext(contractId);
    if (!source) return res.status(404).json({ error: 'Contract not found' });

    const filter = scopeFilter(scope, source);
    if (!filter) {
      // Source has no country (country) or no resolvable region (region).
      // Return an empty peer set with the source context so the UI can
      // render a "no comparable scope" hint cleanly.
      return res.json({
        scope,
        sourceContract: {
          contractId: source.contract_id,
          countryId: source.country_id,
          countryCode: source.country_code,
          countryName: source.country_name,
          region: source.region,
          uwYear: source.uw_year,
        },
        peers: [],
        peerCount: 0,
        note: scope === 'country' ? 'source contract has no country_id' : 'source contract has no region',
      });
    }

    // Layer roll-up: per peer-contract we want sum(limit), sum(egnpi),
    // min(attachment) as the primary deductible, and limit-weighted
    // average ROL. Layers without limit or rol skip silently.
    //
    // The COB overlap filter uses an EXISTS subquery rather than joining
    // contract_class_of_business directly, so peers with multiple COBs
    // don't multiply in the result before we aggregate.
    const params = [...filter.params, contractId];
    const exclusionIdx = params.length; // $N for the source contract
    let cobClause = '';
    if (cobIds.length) {
      params.push(cobIds);
      cobClause = `AND EXISTS (
        SELECT 1 FROM public.contract_class_of_business ccb
         WHERE ccb.contract_id = c.contract_id
           AND ccb.class_of_business_id = ANY($${params.length}::uuid[])
      )`;
    }
    params.push(PEER_LIMIT);
    const limitIdx = params.length;

    const sql = `
      WITH peer_contracts AS (
        SELECT c.contract_id, c.cedant_id, c.country_id, c.uw_year, co.country_code, co.country_name, co.region
          FROM public.contract c
          INNER JOIN public.contract_np_details nd ON nd.contract_id = c.contract_id
          LEFT JOIN public.country co ON co.country_id = c.country_id
         WHERE ${filter.sql}
           AND c.contract_id <> $${exclusionIdx}
           ${cobClause}
         ORDER BY c.uw_year DESC, c.contract_id
         LIMIT $${limitIdx}
      ),
      peer_layer_rollup AS (
        SELECT
          pc.contract_id,
          SUM(COALESCE(l.layer_limit, 0))   AS total_limit,
          SUM(COALESCE(l.egnpi, 0))         AS total_egnpi,
          MIN(NULLIF(l.attachment, 0))      AS primary_attachment,
          CASE WHEN SUM(COALESCE(l.layer_limit, 0)) > 0
               THEN SUM(COALESCE(l.layer_limit, 0) * COALESCE(l.rol, 0))
                    / NULLIF(SUM(COALESCE(l.layer_limit, 0)), 0)
               ELSE NULL END AS weighted_rol,
          COUNT(l.layer_id)::int             AS layer_count
        FROM peer_contracts pc
        LEFT JOIN public.contract_np_layers l ON l.contract_id = pc.contract_id
        GROUP BY pc.contract_id
      ),
      peer_first_cob AS (
        SELECT DISTINCT ON (pc.contract_id)
          pc.contract_id,
          cob.class_of_business AS cob_name
        FROM peer_contracts pc
        JOIN public.contract_class_of_business ccb ON ccb.contract_id = pc.contract_id
        JOIN public.class_of_business cob ON cob.class_of_business_id = ccb.class_of_business_id
        ORDER BY pc.contract_id, cob.class_of_business
      )
      SELECT
        pc.contract_id,
        pc.uw_year,
        pc.country_code,
        pc.country_name,
        pc.region,
        comp.company_name                 AS cedant_name,
        plr.total_limit,
        plr.total_egnpi,
        plr.primary_attachment,
        plr.weighted_rol,
        plr.layer_count,
        pfc.cob_name
      FROM peer_contracts pc
      LEFT JOIN public.companies comp ON comp.company_id = pc.cedant_id
      LEFT JOIN peer_layer_rollup plr  ON plr.contract_id = pc.contract_id
      LEFT JOIN peer_first_cob   pfc   ON pfc.contract_id = pc.contract_id
      WHERE plr.layer_count IS NOT NULL AND plr.layer_count > 0
      ORDER BY pc.uw_year DESC, comp.company_name NULLS LAST
    `;

    let rows;
    try {
      const result = await pool.query(sql, params);
      rows = result.rows;
    } catch (err) {
      logger.error('[peer-structures] query failed', { contractId, scope, cobCount: cobIds.length, error: err.message });
      throw err;
    }

    const peers = rows.map((r) => ({
      id: r.contract_id,
      cedant: r.cedant_name || 'Unknown',
      country: r.country_code || r.country_name || '—',
      cob: r.cob_name || 'Unclassified',
      uwYear: r.uw_year,
      limit:  Number(r.total_limit) || 0,
      ded:    Number(r.primary_attachment) || 0,
      egnpi:  Number(r.total_egnpi) || 0,
      // Stored ROL is a fraction (0..1); the modal expects percent.
      rolPct: r.weighted_rol != null ? Number(r.weighted_rol) * 100 : 0,
      layerCount: r.layer_count,
    }));

    res.json({
      scope,
      sourceContract: {
        contractId: source.contract_id,
        countryId: source.country_id,
        countryCode: source.country_code,
        countryName: source.country_name,
        region: source.region,
        uwYear: source.uw_year,
      },
      peers,
      peerCount: peers.length,
      truncated: peers.length >= PEER_LIMIT,
    });
  }),
);

export default router;
