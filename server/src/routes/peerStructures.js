// server/src/routes/peerStructures.js
//
// Peer-structure benchmark data for the per-structure analysis modal
// (FQBenchmarkModal). Given a source contract/quote we surface every comparable
// NP treaty — across BOTH bound contracts and open quotes — that shares the
// source's geographic scope (Country / Region / Global), its treaty type, and
// at least one class of business, with each peer's headline metrics
// (deductible, total limit, total EGNPI, limit-weighted ROL).
//
// The pool unions public.contract and public.quote (NP-only), with no status
// filter so NTU / Declined / Quoted / Signed / Bound treaties are all eligible.
// A quote that has been bound into a contract already present in the pool is
// dropped (de-dup via parent_contract_id) so it is not double-counted.

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

// Resolve the source's country, region, and treaty type so we know which scope
// + treaty-type buckets to match against. The source id can be either a
// contract_id (a bound treaty) or a quote_id (FQBenchmarkModal opened from
// quote-mode NP final pricing); we try public.contract first, then fall back to
// public.quote. Returns null when neither table resolves the id.
async function loadSourceContext(sourceId) {
  const contractRow = await pool.query(
    `SELECT c.contract_id AS source_id, 'contract'::text AS source_kind,
            c.country_id, c.uw_year, c.treaty_type_id, co.country_code, co.country_name, co.region
       FROM public.contract c
       LEFT JOIN public.country co ON co.country_id = c.country_id
      WHERE c.contract_id = $1`,
    [sourceId],
  );
  if (contractRow.rows[0]) return contractRow.rows[0];

  const quoteRow = await pool.query(
    `SELECT q.quote_id AS source_id, 'quote'::text AS source_kind,
            q.country_id, q.uw_year, q.treaty_type_id, co.country_code, co.country_name, co.region
       FROM public.quote q
       LEFT JOIN public.country co ON co.country_id = q.country_id
      WHERE q.quote_id = $1`,
    [sourceId],
  );
  return quoteRow.rows[0] || null;
}

// The classes the source itself carries — used when the request does not pass an
// explicit cobIds set (e.g. a bound treaty being benchmarked). Reads the source's
// own class table (contract or quote).
async function loadSourceCobs(source) {
  const isQuote = source.source_kind === 'quote';
  const sql = isQuote
    ? 'SELECT class_of_business_id FROM public.quote_class_of_business WHERE quote_id = $1'
    : 'SELECT class_of_business_id FROM public.contract_class_of_business WHERE contract_id = $1';
  const result = await pool.query(sql, [source.source_id]);
  return result.rows.map((r) => r.class_of_business_id).filter(Boolean);
}

// GET /api/treaties/:contractId/peer-structures
//   ?scope=country|region|global
//   &cobIds=uuid1,uuid2,...
//
// Returns { sourceContract, scope, peers: [...], peerCount, note? }.
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

    const sourceContext = {
      contractId: source.source_id,
      sourceKind: source.source_kind,
      countryId: source.country_id,
      countryCode: source.country_code,
      countryName: source.country_name,
      region: source.region,
      treatyTypeId: source.treaty_type_id,
      uwYear: source.uw_year,
    };

    // Scope feasibility: country needs a country_id, region needs a region.
    if (scope === 'country' && !source.country_id) {
      return res.json({ scope, sourceContract: sourceContext, peers: [], peerCount: 0, note: 'source contract has no country_id' });
    }
    if (scope === 'region' && !source.region) {
      return res.json({ scope, sourceContract: sourceContext, peers: [], peerCount: 0, note: 'source contract has no region' });
    }

    // COB set to match on: the classes being quoted (request) else the source's
    // own classes. Empty → skip the COB filter rather than excluding everything.
    let cobIdSet = cobIds;
    if (!cobIdSet.length) cobIdSet = await loadSourceCobs(source);

    // Build the parameterised filters shared by both union branches. The scope
    // value, source id, treaty type, and COB array are each bound once and
    // referenced from both branches.
    const params = [];
    const push = (v) => { params.push(v); return params.length; };
    const notes = [];

    let scopeC = 'TRUE';
    let scopeQ = 'TRUE';
    if (scope === 'country') {
      const i = push(source.country_id);
      scopeC = `c.country_id = $${i}`;
      scopeQ = `q.country_id = $${i}`;
    } else if (scope === 'region') {
      const i = push(source.region);
      scopeC = `co.region = $${i}`;
      scopeQ = `co.region = $${i}`;
    }

    const srcIdx = push(contractId);

    let ttC = '';
    let ttQ = '';
    if (source.treaty_type_id) {
      const i = push(source.treaty_type_id);
      ttC = `AND c.treaty_type_id = $${i}`;
      ttQ = `AND q.treaty_type_id = $${i}`;
    } else {
      notes.push('source has no treaty type — matching on scope + COB only');
    }

    let cobC = '';
    let cobQ = '';
    if (cobIdSet.length) {
      const i = push(cobIdSet);
      cobC = `AND EXISTS (
            SELECT 1 FROM public.contract_class_of_business ccb
             WHERE ccb.contract_id = c.contract_id
               AND ccb.class_of_business_id = ANY($${i}::uuid[]))`;
      cobQ = `AND EXISTS (
            SELECT 1 FROM public.quote_class_of_business qcb
             WHERE qcb.quote_id = q.quote_id
               AND qcb.class_of_business_id = ANY($${i}::uuid[]))`;
    } else {
      notes.push('source has no classes — matching on scope + treaty type only');
    }

    const limitIdx = push(PEER_LIMIT);

    // Union of contract peers + quote peers, NP-only, with per-branch layer
    // roll-up + first-COB label. No status filter. Quote rows whose bound
    // contract is already in the pool are dropped (parent_contract_id NOT EXISTS).
    const sql = `
      WITH peer_contracts AS (
        SELECT
          c.contract_id AS contract_id,
          c.uw_year,
          co.country_code, co.country_name, co.region,
          comp.company_name AS cedant_name,
          SUM(COALESCE(l.layer_limit, 0))   AS total_limit,
          SUM(COALESCE(l.egnpi, 0))         AS total_egnpi,
          MIN(NULLIF(l.attachment, 0))      AS primary_attachment,
          CASE WHEN SUM(COALESCE(l.layer_limit, 0)) > 0
               THEN SUM(COALESCE(l.layer_limit, 0) * COALESCE(l.rol, 0))
                    / NULLIF(SUM(COALESCE(l.layer_limit, 0)), 0)
               ELSE NULL END                AS weighted_rol,
          COUNT(l.layer_id)::int            AS layer_count,
          pfc.cob_name
        FROM public.contract c
        INNER JOIN public.contract_np_details nd ON nd.contract_id = c.contract_id
        LEFT JOIN public.country co   ON co.country_id = c.country_id
        LEFT JOIN public.companies comp ON comp.company_id = c.cedant_id
        LEFT JOIN public.contract_np_layers l ON l.contract_id = c.contract_id
        LEFT JOIN LATERAL (
          SELECT cob.class_of_business AS cob_name
            FROM public.contract_class_of_business ccb
            JOIN public.class_of_business cob ON cob.class_of_business_id = ccb.class_of_business_id
           WHERE ccb.contract_id = c.contract_id
           ORDER BY cob.class_of_business
           LIMIT 1
        ) pfc ON TRUE
        WHERE ${scopeC}
          AND c.contract_id <> $${srcIdx}
          ${ttC}
          ${cobC}
        GROUP BY c.contract_id, c.uw_year, co.country_code, co.country_name, co.region, comp.company_name, pfc.cob_name
        UNION ALL
        SELECT
          q.quote_id AS contract_id,
          q.uw_year,
          co.country_code, co.country_name, co.region,
          comp.company_name AS cedant_name,
          SUM(COALESCE(ql.layer_limit, 0))  AS total_limit,
          SUM(COALESCE(ql.egnpi, 0))        AS total_egnpi,
          MIN(NULLIF(ql.attachment, 0))     AS primary_attachment,
          CASE WHEN SUM(COALESCE(ql.layer_limit, 0)) > 0
               THEN SUM(COALESCE(ql.layer_limit, 0) * COALESCE(ql.rol, 0))
                    / NULLIF(SUM(COALESCE(ql.layer_limit, 0)), 0)
               ELSE NULL END                AS weighted_rol,
          COUNT(ql.layer_number)::int       AS layer_count,
          qfc.cob_name
        FROM public.quote q
        INNER JOIN public.quote_np_details qnd ON qnd.quote_id = q.quote_id
        LEFT JOIN public.country co   ON co.country_id = q.country_id
        LEFT JOIN public.companies comp ON comp.company_id = q.cedant_id
        LEFT JOIN public.quote_np_layers ql ON ql.quote_id = q.quote_id
        LEFT JOIN LATERAL (
          SELECT cob.class_of_business AS cob_name
            FROM public.quote_class_of_business qcb
            JOIN public.class_of_business cob ON cob.class_of_business_id = qcb.class_of_business_id
           WHERE qcb.quote_id = q.quote_id
           ORDER BY cob.class_of_business
           LIMIT 1
        ) qfc ON TRUE
        WHERE ${scopeQ}
          AND q.quote_id <> $${srcIdx}
          AND NOT EXISTS (SELECT 1 FROM public.contract c2 WHERE c2.contract_id = q.parent_contract_id)
          ${ttQ}
          ${cobQ}
        GROUP BY q.quote_id, q.uw_year, co.country_code, co.country_name, co.region, comp.company_name, qfc.cob_name
      )
      SELECT
        contract_id, uw_year, country_code, country_name, region, cedant_name,
        total_limit, total_egnpi, primary_attachment, weighted_rol, layer_count, cob_name
      FROM peer_contracts
      WHERE layer_count IS NOT NULL AND layer_count > 0
      ORDER BY uw_year DESC, cedant_name NULLS LAST
      LIMIT $${limitIdx}
    `;

    let rows;
    try {
      const result = await pool.query(sql, params);
      rows = result.rows;
    } catch (err) {
      logger.error('[peer-structures] query failed', { contractId, scope, cobCount: cobIdSet.length, error: err.message });
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
      sourceContract: sourceContext,
      peers,
      peerCount: peers.length,
      truncated: peers.length >= PEER_LIMIT,
      note: notes.join('; ') || undefined,
    });
  }),
);

export default router;
