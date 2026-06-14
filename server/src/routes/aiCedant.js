// server/src/routes/aiCedant.js
//
// AI portfolio-recommendation + line-size staging endpoints (prompts
// 7.5.a and 7.5.b).
//
// 7.5.a — POST /api/ai/cedant/:cedantId/portfolio-recommendations
//         GET  /api/ai/cedant/:cedantId/portfolio-recommendations/latest
//         POST /api/ai/cedant/recommendation/:rec_id/reject
//
// 7.5.b — POST /api/cedants/:cedantId/staging
//         POST /api/cedants/:cedantId/staging/:staging_id/discard
//         POST /api/cedants/:cedantId/staging/commit-all
//         GET  /api/cedants/:cedantId/staging
//         GET  /api/cedants/:cedantId/staging/portfolio-impact
//
// The Claude call uses raw fetch to match the existing pattern in
// routes/ai.js. Model and headers stay aligned with that file.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { validateBody } from '../lib/validate.js';
import {
  portfolioRecommendationsRequestSchema,
  portfolioRecommendationsResponseSchema,
  rejectRecommendationSchema,
  stageLineChangeSchema,
  discardStagingSchema,
  commitStagingSchema,
} from '../validation/ai.js';
import { checkPortfolioCompliance } from '../lib/portfolioCompliance.js';
import { logAudit } from '../services/audit.js';

const router = Router();

const ANTHROPIC_API     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL   = 'claude-sonnet-4-20250514';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 2000;

const SYSTEM_PROMPT = `You are a reinsurance portfolio analyst. Given a cedant's portfolio of proportional and non-proportional reinsurance treaties, recommend line-size adjustments that maximise expected return subject to the underwriter's constraints. Respond ONLY with a JSON object. No markdown. No backticks. Shape:
{
  summary: string (<= 100 words),
  portfolio_metrics: {
    current_expected_return: number,
    recommended_expected_return: number,
    return_uplift_pct: number,
    diversification_score: number   // 0..1
  },
  recommendations: [
    {
      contract_id: string,
      current_line_pct: number,
      recommended_line_pct: number,
      rationale: string (<= 200 chars),
      confidence: number (0..1),
      impact_on_return: number
    }
  ]
}
Constraints:
- Every recommended_line_pct in [0, max_line_size_pct].
- Reduce or skip structures with negative margin.
- Increase well-priced structures (margin > 15%) up to the cap.
- Maintain COB diversification — no single COB exceeds max_cob_concentration_pct of total recommended premium.`;

// ── helpers ────────────────────────────────────────────────────────

function requireUser(req, res) {
  const uid = req.user?.userId;
  if (!uid) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }
  return uid;
}

function roundN(v, decimals) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// Strip nullish fields and round numerics to keep prompt tokens low.
function compact(obj, numericKeys = []) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    out[k] = numericKeys.includes(k) ? roundN(v, 4) : v;
  }
  return out;
}

// Resolve contract_class_of_business name column the same way
// lookups.js does. The live DB has used both `class_of_business` and
// `class_name` historically; we introspect rather than hard-code.
async function resolveCobCols() {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='class_of_business'
       ORDER BY ordinal_position`,
  );
  const cols = rows.map(r => r.column_name);
  const idCol   = cols.find(c => c === 'class_of_business_id') || cols.find(c => c === 'class_id') || cols[0];
  const nameCol = cols.find(c => c === 'class_of_business')    || cols.find(c => c === 'class_name') || cols[1] || cols[0];
  return { idCol, nameCol };
}

// Fetch the cedant's full portfolio in the same shape cedant-summary
// uses. Returns rows with contract_id, entity_type, treaty_type, cob,
// premium, limit, margin, current_line_pct (fraction 0..1).
async function fetchPortfolio(cedantId) {
  const { idCol, nameCol } = await resolveCobCols();
  const cobSub = (alias) => `(
    SELECT string_agg(cob.${nameCol}, ', ')
    FROM public.contract_class_of_business ccb
    JOIN public.class_of_business cob ON cob.${idCol} = ccb.class_of_business_id
    WHERE ccb.contract_id = ${alias}.contract_id
  )`;

  const { rows: propRows } = await pool.query(`
    SELECT
      c.contract_id, c.uw_year, c.status, c.signed_line_pct,
      tt.treaty_type AS treaty_type,
      ${cobSub('c')} AS cob,
      'PROP'::text AS entity_type,
      COALESCE(d.quota_share_epi,0) + COALESCE(d.surplus_epi,0)   AS premium,
      COALESCE(d.qs_limit, d.total_capacity, 0)                   AS "limit",
      po.actuarial_margin                                         AS margin,
      COALESCE(c.signed_line_pct, co.written_line_pct)            AS effective_line_pct
    FROM public.contract c
    LEFT JOIN public.treaty_type             tt ON c.treaty_type_id = tt.treaty_type_id
    LEFT JOIN public.contract_prop_details    d  ON c.contract_id   = d.contract_id
    LEFT JOIN public.contract_pricing_outputs po ON c.contract_id   = po.contract_id
    LEFT JOIN (SELECT DISTINCT ON (contract_id) contract_id, written_line_pct
               FROM public.contract_offer ORDER BY contract_id, offer_id DESC) co
           ON co.contract_id = c.contract_id
    WHERE c.cedant_id = $1
      AND EXISTS (SELECT 1 FROM public.contract_prop_details pd WHERE pd.contract_id = c.contract_id)
  `, [cedantId]);

  const { rows: npRows } = await pool.query(`
    SELECT
      c.contract_id, c.uw_year, c.status, c.signed_line_pct,
      tt.treaty_type AS treaty_type,
      ${cobSub('c')} AS cob,
      'NP'::text AS entity_type,
      COALESCE(nl.total_earned_premium, 0) AS premium,
      COALESCE(nl.total_limit, 0)          AS "limit",
      CASE
        WHEN nl.total_earned_premium > 0 AND nl.weighted_modelled IS NOT NULL
          THEN nl.weighted_modelled / nl.total_earned_premium
        ELSE NULL
      END                                   AS margin,
      COALESCE(c.signed_line_pct, co.written_line_pct) AS effective_line_pct
    FROM public.contract c
    LEFT JOIN public.treaty_type tt ON c.treaty_type_id = tt.treaty_type_id
    LEFT JOIN (
      SELECT contract_id,
             SUM(COALESCE(earned_premium,0))                              AS total_earned_premium,
             SUM(COALESCE(layer_limit,0))                                 AS total_limit,
             SUM(CASE WHEN modelled_margin IS NOT NULL AND earned_premium > 0
                      THEN earned_premium * modelled_margin ELSE NULL END) AS weighted_modelled
        FROM public.contract_np_layers GROUP BY contract_id
    ) nl ON nl.contract_id = c.contract_id
    LEFT JOIN (SELECT DISTINCT ON (contract_id) contract_id, written_line_pct
               FROM public.contract_offer ORDER BY contract_id, offer_id DESC) co
           ON co.contract_id = c.contract_id
    WHERE c.cedant_id = $1
      AND EXISTS (SELECT 1 FROM public.contract_np_details nd WHERE nd.contract_id = c.contract_id)
  `, [cedantId]);

  return [...propRows, ...npRows].map(r => ({
    ...r,
    // effective_line_pct is stored as percent (e.g. 10 = 10%) — return as fraction
    current_line_pct: r.effective_line_pct != null ? Number(r.effective_line_pct) / 100 : null,
  }));
}

async function fetchNpLayers(cedantId) {
  const { rows } = await pool.query(`
    SELECT
      c.contract_id, l.layer_number,
      l.layer_limit AS "limit", l.rol,
      l.earned_premium AS premium,
      l.modelled_margin AS margin
    FROM public.contract c
    JOIN public.contract_np_layers l ON l.contract_id = c.contract_id
    WHERE c.cedant_id = $1
    ORDER BY c.uw_year DESC, l.layer_number ASC
  `, [cedantId]);
  return rows;
}

function buildPromptContext({ cedantId, body, portfolio, npLayers }) {
  const contracts = portfolio.map(r => compact({
    contract_id:      r.contract_id,
    uw_year:          r.uw_year,
    treaty_type:      r.treaty_type,
    cob:              r.cob,
    premium:          r.premium,
    limit:            r.limit,
    margin:           r.margin,
    current_line_pct: r.current_line_pct,
  }, ['premium', 'limit', 'margin', 'current_line_pct']));

  const layers = npLayers.map(l => compact({
    contract_id: l.contract_id,
    layer_name:  l.layer_number != null ? `Layer ${l.layer_number}` : null,
    limit:       l.limit,
    rol:         l.rol,
    premium:     l.premium,
    margin:      l.margin,
  }, ['limit', 'rol', 'premium', 'margin']));

  return {
    cedant_id:                 cedantId,
    target_year:               body.target_year,
    risk_appetite:             body.risk_appetite,
    max_line_size_pct:         body.max_line_size_pct,
    max_cob_concentration_pct: body.max_cob_concentration_pct,
    contracts,
    np_layers: layers,
  };
}

async function callClaude(userJson) {
  if (!env.anthropicApiKey) {
    const err = new Error('ANTHROPIC_API_KEY not configured on server');
    err.statusCode = 503;
    throw err;
  }
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userJson) }],
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Anthropic API error ${resp.status}`;
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }
  const data = await resp.json();
  const text = (data?.content || []).map(b => b?.text || '').join('').trim();
  return { rawText: text, rawBody: data };
}

// Status-aware line-size write — mirrors the rules described in the
// 7.5.b prompt: write to contract.signed_line_pct when the contract
// is SIGNED; otherwise write to the latest contract_offer row's
// written_line_pct (creating one if no offer exists yet).
//
// Stored values are percents (e.g. 10 means 10%); the staging row's
// proposed_line_pct is a fraction (0..1) so we multiply by 100 here.
async function applyLineSizeWrite(client, contractId, proposedFraction) {
  const valuePct = Number(proposedFraction) * 100;
  const { rows: cRows } = await client.query(
    `SELECT status, signed_line_pct FROM public.contract WHERE contract_id=$1 FOR UPDATE`,
    [contractId],
  );
  if (!cRows.length) {
    const err = new Error(`Contract ${contractId} not found`);
    err.code = 'CONTRACT_MISSING';
    throw err;
  }
  const status = String(cRows[0].status || '').toUpperCase();
  const beforeValue = cRows[0].signed_line_pct;
  if (status === 'SIGNED') {
    await client.query(
      `UPDATE public.contract SET signed_line_pct=$1, updated_at=now() WHERE contract_id=$2`,
      [valuePct, contractId],
    );
    return { target: 'contract.signed_line_pct', before_pct: beforeValue, after_pct: valuePct };
  }

  const { rows: oRows } = await client.query(
    `SELECT offer_id, written_line_pct FROM public.contract_offer
        WHERE contract_id=$1 ORDER BY offer_id DESC LIMIT 1 FOR UPDATE`,
    [contractId],
  );
  if (oRows.length) {
    await client.query(
      `UPDATE public.contract_offer SET written_line_pct=$1 WHERE offer_id=$2`,
      [valuePct, oRows[0].offer_id],
    );
    return {
      target: 'contract_offer.written_line_pct',
      offer_id: oRows[0].offer_id,
      before_pct: oRows[0].written_line_pct,
      after_pct: valuePct,
    };
  }
  const ins = await client.query(
    `INSERT INTO public.contract_offer (contract_id, written_line_pct, status)
        VALUES ($1, $2, 'PENDING') RETURNING offer_id`,
    [contractId, valuePct],
  );
  return {
    target: 'contract_offer.written_line_pct',
    offer_id: ins.rows[0].offer_id,
    before_pct: null,
    after_pct: valuePct,
    inserted: true,
  };
}

// ── 7.5.a: portfolio recommendations ───────────────────────────────

router.post(
  '/ai/cedant/:cedantId/portfolio-recommendations',
  validateBody(portfolioRecommendationsRequestSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { cedantId } = req.params;
    const body = req.body;

    const portfolio = await fetchPortfolio(cedantId);
    if (!portfolio.length) {
      return res.status(404).json({ error: 'Cedant has no portfolio contracts.' });
    }
    const npLayers = await fetchNpLayers(cedantId);

    // Call Claude
    const promptCtx = buildPromptContext({ cedantId, body, portfolio, npLayers });
    let claudeOut;
    try {
      claudeOut = await callClaude(promptCtx);
    } catch (e) {
      logger.error('[ai/cedant] Claude call failed', { error: e?.message, statusCode: e?.statusCode });
      return res.status(e.statusCode || 502).json({ error: e?.message || 'AI call failed' });
    }

    // Parse + Zod-validate the response
    let parsed;
    try {
      parsed = JSON.parse(claudeOut.rawText);
    } catch {
      return res.status(502).json({
        error: 'Model returned non-JSON',
        raw_response: claudeOut.rawText,
      });
    }
    const result = portfolioRecommendationsResponseSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn('[ai/cedant] model output failed validation', {
        issues: result.error.issues,
      });
      return res.status(502).json({
        error: 'Model output failed validation',
        issues: result.error.issues,
        raw_response: parsed,
      });
    }

    // Filter to contracts that belong to the cedant + are within the
    // user's stated cap. Drops are logged but otherwise silent — they
    // just don't end up persisted.
    const inPortfolio = new Set(portfolio.map(p => String(p.contract_id)));
    const kept = [];
    const dropped = [];
    for (const r of result.data.recommendations) {
      if (!inPortfolio.has(String(r.contract_id))) {
        dropped.push({ contract_id: r.contract_id, reason: 'not_in_portfolio' });
        continue;
      }
      if (r.recommended_line_pct < 0 || r.recommended_line_pct > body.max_line_size_pct) {
        dropped.push({ contract_id: r.contract_id, reason: 'out_of_range' });
        continue;
      }
      kept.push(r);
    }
    if (dropped.length) {
      logger.warn('[ai/cedant] dropped recommendations after server-side filter', { dropped });
    }

    // Compliance checks
    const contractsMap = new Map(portfolio.map(p => [String(p.contract_id), {
      premium: Number(p.premium ?? 0),
      margin:  Number(p.margin ?? 0),
      cob:     p.cob || null,
    }]));
    const complianceCtx = {
      contracts: contractsMap,
      allRecommendations: kept,
      maxLineSizePct: body.max_line_size_pct,
      maxCobConcentrationPct: body.max_cob_concentration_pct,
    };
    const enriched = kept.map(r => ({
      ...r,
      compliance_warnings: checkPortfolioCompliance(cedantId, r, complianceCtx),
    }));

    // Persist set + recommendations
    const client = await pool.connect();
    let recSet;
    try {
      await client.query('BEGIN');
      const setRes = await client.query(
        `INSERT INTO public.cedant_ai_recommendation_set
           (cedant_id, target_year, risk_appetite, max_line_size_pct,
            max_cob_concentration_pct, summary, portfolio_metrics,
            raw_response, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          cedantId, body.target_year, body.risk_appetite,
          body.max_line_size_pct, body.max_cob_concentration_pct,
          result.data.summary, result.data.portfolio_metrics,
          parsed, userId,
        ],
      );
      recSet = setRes.rows[0];

      const insertedRecs = [];
      for (const r of enriched) {
        const recRes = await client.query(
          `INSERT INTO public.cedant_ai_recommendation
             (rec_set_id, cedant_id, contract_id, current_line_pct,
              recommended_line_pct, rationale, confidence, impact_on_return,
              compliance_warnings)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            recSet.rec_set_id, cedantId, r.contract_id,
            r.current_line_pct, r.recommended_line_pct, r.rationale,
            r.confidence, r.impact_on_return,
            JSON.stringify(r.compliance_warnings),
          ],
        );
        insertedRecs.push(recRes.rows[0]);
      }
      await client.query('COMMIT');

      return res.status(201).json({
        rec_set: recSet,
        recommendations: insertedRecs,
        dropped,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[ai/cedant] persistence failed', { error: e?.message });
      return res.status(500).json({ error: 'Failed to persist recommendations' });
    } finally {
      client.release();
    }
  }),
);

router.get(
  '/ai/cedant/:cedantId/portfolio-recommendations/latest',
  asyncHandler(async (req, res) => {
    const { cedantId } = req.params;
    const { rows: setRows } = await pool.query(
      `SELECT * FROM public.cedant_ai_recommendation_set
        WHERE cedant_id=$1
        ORDER BY created_at DESC LIMIT 1`,
      [cedantId],
    );
    if (!setRows.length) return res.status(404).json({ error: 'No recommendations yet for this cedant.' });
    const recSet = setRows[0];
    const { rows: recs } = await pool.query(
      `SELECT * FROM public.cedant_ai_recommendation
        WHERE rec_set_id=$1
        ORDER BY recommended_line_pct DESC`,
      [recSet.rec_set_id],
    );
    res.json({ rec_set: recSet, recommendations: recs });
  }),
);

router.post(
  '/ai/cedant/recommendation/:rec_id/reject',
  validateBody(rejectRecommendationSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { rec_id: recId } = req.params;
    const { reason } = req.body;

    const { rows } = await pool.query(
      `UPDATE public.cedant_ai_recommendation
          SET status='REJECTED', acted_at=now(), acted_by_user_id=$2
        WHERE rec_id=$1 AND status='PENDING'
        RETURNING *`,
      [recId, userId],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Recommendation not found or not in PENDING state.' });
    }
    if (reason) {
      await logAudit(null, {
        entityType: 'CEDANT_AI_RECOMMENDATION',
        entityId: recId,
        eventType: 'REJECTED',
        actor: userId,
        payload: { reason },
      });
    }
    res.json({ recommendation: rows[0] });
  }),
);

// ── 7.5.b: portfolio staging ───────────────────────────────────────

router.post(
  '/cedants/:cedantId/staging',
  validateBody(stageLineChangeSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { cedantId } = req.params;
    const { contract_id: contractId, proposed_line_pct: proposed,
            source, source_rec_id: srcRecId, warning_acknowledged } = req.body;

    // Validate contract belongs to cedant
    const { rows: cRows } = await pool.query(
      `SELECT contract_id FROM public.contract WHERE contract_id=$1 AND cedant_id=$2`,
      [contractId, cedantId],
    );
    if (!cRows.length) return res.status(404).json({ error: 'Contract not found for this cedant.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let warnings = [];
      if (source === 'AI_RECOMMENDATION') {
        const { rows: recRows } = await client.query(
          `SELECT * FROM public.cedant_ai_recommendation WHERE rec_id=$1 FOR UPDATE`,
          [srcRecId],
        );
        if (!recRows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'source_rec_id not found.' });
        }
        const rec = recRows[0];
        if (String(rec.cedant_id) !== String(cedantId) || String(rec.contract_id) !== String(contractId)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Recommendation does not match cedant_id / contract_id.' });
        }
        warnings = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];
        if (warnings.length > 0 && warning_acknowledged !== true) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: 'Recommendation carries compliance warnings — acknowledge to stage.',
            compliance_warnings: warnings,
          });
        }
        await client.query(
          `UPDATE public.cedant_ai_recommendation SET status='STAGED', acted_at=now(), acted_by_user_id=$2
             WHERE rec_id=$1`,
          [srcRecId, userId],
        );
      }

      // Supersede any existing STAGED row for (cedant, contract).
      // If the prior was sourced from another AI rec, set that rec
      // back to PENDING so it can be re-considered.
      const { rows: priorRows } = await client.query(
        `SELECT staging_id, source_rec_id FROM public.cedant_portfolio_staging
          WHERE cedant_id=$1 AND contract_id=$2 AND status='STAGED'
          FOR UPDATE`,
        [cedantId, contractId],
      );
      for (const prior of priorRows) {
        await client.query(
          `UPDATE public.cedant_portfolio_staging
              SET status='DISCARDED', discarded_at=now()
            WHERE staging_id=$1`,
          [prior.staging_id],
        );
        if (prior.source_rec_id && String(prior.source_rec_id) !== String(srcRecId || '')) {
          await client.query(
            `UPDATE public.cedant_ai_recommendation SET status='PENDING', acted_at=NULL, acted_by_user_id=NULL
              WHERE rec_id=$1 AND status='STAGED'`,
            [prior.source_rec_id],
          );
        }
      }

      const ackedAt   = (warnings.length > 0 && warning_acknowledged === true) ? new Date() : null;
      const ackedById = ackedAt ? userId : null;
      const ins = await client.query(
        `INSERT INTO public.cedant_portfolio_staging
           (cedant_id, contract_id, proposed_line_pct, source, source_rec_id,
            rationale, compliance_warnings, warning_acknowledged_by_user_id,
            warning_acknowledged_at, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          cedantId, contractId, proposed, source, srcRecId || null,
          source === 'AI_RECOMMENDATION'
            ? (await pool.query(`SELECT rationale FROM public.cedant_ai_recommendation WHERE rec_id=$1`, [srcRecId])).rows[0]?.rationale || null
            : null,
          JSON.stringify(warnings), ackedById, ackedAt, userId,
        ],
      );

      await client.query('COMMIT');
      res.status(201).json({ staging: ins.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[cedant/staging] insert failed', { error: e?.message });
      return res.status(500).json({ error: 'Failed to stage change' });
    } finally {
      client.release();
    }
  }),
);

router.post(
  '/cedants/:cedantId/staging/:staging_id/discard',
  validateBody(discardStagingSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { cedantId, staging_id: stagingId } = req.params;
    const { reason } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE public.cedant_portfolio_staging
            SET status='DISCARDED', discarded_at=now()
          WHERE staging_id=$1 AND cedant_id=$2 AND status='STAGED'
          RETURNING *`,
        [stagingId, cedantId],
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Staging row not found or not in STAGED state.' });
      }
      const staged = rows[0];
      if (staged.source === 'AI_RECOMMENDATION' && staged.source_rec_id) {
        await client.query(
          `UPDATE public.cedant_ai_recommendation
              SET status='PENDING', acted_at=NULL, acted_by_user_id=NULL
            WHERE rec_id=$1 AND status='STAGED'`,
          [staged.source_rec_id],
        );
      }
      await client.query('COMMIT');
      if (reason) {
        await logAudit(null, {
          entityType: 'CEDANT_PORTFOLIO_STAGING',
          entityId: stagingId,
          eventType: 'DISCARDED',
          actor: userId,
          payload: { reason },
        });
      }
      res.json({ staging: staged });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[cedant/staging] discard failed', { error: e?.message });
      return res.status(500).json({ error: 'Failed to discard' });
    } finally {
      client.release();
    }
  }),
);

router.post(
  '/cedants/:cedantId/staging/commit-all',
  validateBody(commitStagingSchema),
  asyncHandler(async (req, res) => {
    const userId = requireUser(req, res); if (!userId) return;
    const { cedantId } = req.params;
    const { staging_ids: subset } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Select target rows under FOR UPDATE so we serialize against
      // any concurrent discard / commit for this cedant.
      let sql = `SELECT * FROM public.cedant_portfolio_staging
                  WHERE cedant_id=$1 AND status='STAGED'`;
      const params = [cedantId];
      if (Array.isArray(subset) && subset.length) {
        params.push(subset);
        sql += ` AND staging_id = ANY($2::uuid[])`;
      }
      sql += ' FOR UPDATE';
      const { rows: targets } = await client.query(sql, params);
      if (!targets.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No STAGED rows to commit.' });
      }

      const results = [];
      for (const row of targets) {
        try {
          const writeRes = await applyLineSizeWrite(client, row.contract_id, row.proposed_line_pct);
          await client.query(
            `UPDATE public.cedant_portfolio_staging
                SET status='COMMITTED', committed_at=now()
              WHERE staging_id=$1`,
            [row.staging_id],
          );
          if (row.source === 'AI_RECOMMENDATION' && row.source_rec_id) {
            await client.query(
              `UPDATE public.cedant_ai_recommendation
                  SET status='COMMITTED', acted_at=now(), acted_by_user_id=$2
                WHERE rec_id=$1`,
              [row.source_rec_id, userId],
            );
          }
          await logAudit(client, {
            entityType: 'CONTRACT',
            entityId:   row.contract_id,
            eventType:  'LINE_SIZE_COMMITTED',
            actor:      userId,
            payload: {
              staging_id: row.staging_id,
              source:     row.source,
              source_rec_id: row.source_rec_id,
              ...writeRes,
            },
          });
          results.push({ staging_id: row.staging_id, ...writeRes });
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          logger.error('[cedant/staging] commit failed mid-loop', {
            error: e?.message, staging_id: row.staging_id,
          });
          return res.status(500).json({
            error: e?.message || 'Commit failed',
            failed_staging_id: row.staging_id,
          });
        }
      }

      await client.query('COMMIT');
      res.json({ committed: results });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[cedant/staging] commit-all failed', { error: e?.message });
      return res.status(500).json({ error: 'Commit failed' });
    } finally {
      client.release();
    }
  }),
);

router.get(
  '/cedants/:cedantId/staging',
  asyncHandler(async (req, res) => {
    const { cedantId } = req.params;
    const includeRaw = String(req.query.include || '').toLowerCase();
    const include = new Set(includeRaw.split(',').map(s => s.trim()).filter(Boolean));
    const statuses = ['STAGED'];
    if (include.has('committed')) statuses.push('COMMITTED');
    if (include.has('discarded')) statuses.push('DISCARDED');

    const portfolio = await fetchPortfolio(cedantId);
    const livePctById = new Map(portfolio.map(p => [String(p.contract_id), p.current_line_pct]));

    const { rows } = await pool.query(
      `SELECT s.*, c.contract_description, tt.treaty_type
         FROM public.cedant_portfolio_staging s
         JOIN public.contract c ON c.contract_id = s.contract_id
         LEFT JOIN public.treaty_type tt ON c.treaty_type_id = tt.treaty_type_id
        WHERE s.cedant_id=$1 AND s.status = ANY($2::text[])
        ORDER BY s.created_at DESC`,
      [cedantId, statuses],
    );

    const items = rows.map(r => {
      const currentPct = livePctById.get(String(r.contract_id)) ?? null;
      const proposedPct = Number(r.proposed_line_pct);
      return {
        staging_id:         r.staging_id,
        contract_id:        r.contract_id,
        contract_label:     r.contract_description || `Contract ${String(r.contract_id).slice(0,6)}`,
        treaty_type:        r.treaty_type,
        current_line_pct:   currentPct,
        proposed_line_pct:  proposedPct,
        delta_pct:          currentPct != null ? proposedPct - currentPct : null,
        source:             r.source,
        source_rec_id:      r.source_rec_id,
        rationale:          r.rationale,
        compliance_warnings: r.compliance_warnings,
        warning_acknowledged_at: r.warning_acknowledged_at,
        status:             r.status,
        created_at:         r.created_at,
      };
    });

    res.json({ items });
  }),
);

router.get(
  '/cedants/:cedantId/staging/portfolio-impact',
  asyncHandler(async (req, res) => {
    const { cedantId } = req.params;
    const portfolio = await fetchPortfolio(cedantId);

    const { rows: stagedRows } = await pool.query(
      `SELECT contract_id, proposed_line_pct
         FROM public.cedant_portfolio_staging
        WHERE cedant_id=$1 AND status='STAGED'`,
      [cedantId],
    );
    const proposedByContract = new Map(
      stagedRows.map(r => [String(r.contract_id), Number(r.proposed_line_pct)]),
    );

    const project = (linePctFor) => {
      let totalPremium = 0;
      let totalTechnical = 0;
      for (const p of portfolio) {
        const linePct = linePctFor(p);
        if (linePct == null) continue;
        const premiumShare = Number(p.premium ?? 0) * linePct;
        const margin = Number(p.margin ?? 0);
        totalPremium   += premiumShare;
        totalTechnical += premiumShare * margin;
      }
      return {
        total_premium:          roundN(totalPremium, 2),
        total_technical_result: roundN(totalTechnical, 2),
        expected_return_pct:    totalPremium > 0 ? roundN(totalTechnical / totalPremium, 4) : null,
      };
    };

    const current = project(p => p.current_line_pct);
    const staged  = project(p => {
      const proposed = proposedByContract.get(String(p.contract_id));
      return proposed != null ? proposed : p.current_line_pct;
    });
    const premiumDelta = (staged.total_premium ?? 0) - (current.total_premium ?? 0);
    const techDelta    = (staged.total_technical_result ?? 0) - (current.total_technical_result ?? 0);
    const uplift = current.total_technical_result && current.total_technical_result !== 0
      ? roundN(techDelta / Math.abs(current.total_technical_result), 4)
      : null;

    res.json({
      current,
      staged,
      delta: {
        premium:           roundN(premiumDelta, 2),
        technical_result:  roundN(techDelta, 2),
        return_uplift_pct: uplift,
      },
    });
  }),
);

export default router;
