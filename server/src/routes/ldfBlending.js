// server/src/routes/ldfBlending.js
// LDF blend endpoints — fetch the saved blend (or compute a fresh one
// from benchmarks if none has been saved), preview an alternative with
// override weights, and persist a chosen blend.
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import {
  computeBlendedLdfCurve,
  saveContractLdfBlend,
  loadContractLdfBlend,
} from '../services/ldf/blending.js';
import {
  ldfTriangleTypeSchema,
  ldfBlendPreviewSchema,
  ldfBlendSaveSchema,
} from '../validation/ldfBlend.js';

const router = Router();

// Shared path-param validation — resolves the contract's country/region
// and EPI split so handlers don't repeat the same three queries.
async function loadContractContext(contractId) {
  const { rows } = await pool.query(
    `SELECT c.contract_id, c.country_id, co.region
       FROM public.contract c
       LEFT JOIN public.country co ON co.country_id = c.country_id
      WHERE c.contract_id = $1`,
    [contractId],
  );
  if (!rows.length) return null;
  const { rows: epi } = await pool.query(
    `SELECT class_of_business_id, premium
       FROM public.contract_epi_split
      WHERE contract_id = $1`,
    [contractId],
  );
  return {
    countryId: rows[0].country_id,
    region: rows[0].region,
    epiSplit: epi.map((r) => ({
      classOfBusinessId: r.class_of_business_id,
      premium: r.premium,
    })),
  };
}

function parseTriangleType(rawType, res) {
  const parsed = ldfTriangleTypeSchema.safeParse(String(rawType || '').toUpperCase());
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid triangle type', code: 'VALIDATION_FAILED' });
    return null;
  }
  return parsed.data;
}

// ── GET /api/contracts/:contractId/ldf-blend/:triangleType ───────────────
// Load saved blend; if none saved, compute fresh using default EPI-share
// weights so the modal can render immediately.
router.get('/contracts/:contractId/ldf-blend/:triangleType', asyncHandler(async (req, res) => {
  const triangleType = parseTriangleType(req.params.triangleType, res);
  if (!triangleType) return;

  const ctx = await loadContractContext(req.params.contractId);
  if (!ctx) return res.status(404).json({ error: 'Contract not found' });

  const saved = await loadContractLdfBlend(pool, req.params.contractId, triangleType);
  if (saved) {
    return res.json({ saved: true, ...saved });
  }

  // No saved blend — compute fresh against benchmarks.
  const fresh = await computeBlendedLdfCurve(pool, {
    epiSplit: ctx.epiSplit,
    countryId: ctx.countryId,
    region: ctx.region,
    triangleType,
  });
  return res.json({ saved: false, overridden: false, ...fresh });
}));

// ── POST /api/contracts/:contractId/ldf-blend/:triangleType ──────────────
// Preview a blend with overrideWeights — does NOT persist.
router.post(
  '/contracts/:contractId/ldf-blend/:triangleType',
  validateBody(ldfBlendPreviewSchema),
  asyncHandler(async (req, res) => {
    const triangleType = parseTriangleType(req.params.triangleType, res);
    if (!triangleType) return;

    const ctx = await loadContractContext(req.params.contractId);
    if (!ctx) return res.status(404).json({ error: 'Contract not found' });

    const result = await computeBlendedLdfCurve(pool, {
      epiSplit: ctx.epiSplit,
      countryId: ctx.countryId,
      region: ctx.region,
      triangleType,
      overrideWeights: req.body.overrideWeights || null,
    });
    return res.json(result);
  }),
);

// ── PUT /api/contracts/:contractId/ldf-blend/:triangleType ───────────────
// Persist the chosen blend. Wipes the prior blend (header is updated,
// child rows replaced) inside one transaction.
router.put(
  '/contracts/:contractId/ldf-blend/:triangleType',
  validateBody(ldfBlendSaveSchema),
  asyncHandler(async (req, res) => {
    const triangleType = parseTriangleType(req.params.triangleType, res);
    if (!triangleType) return;

    const ctx = await loadContractContext(req.params.contractId);
    if (!ctx) return res.status(404).json({ error: 'Contract not found' });

    const blendId = await saveContractLdfBlend(pool, {
      contractId: req.params.contractId,
      triangleType,
      overridden: req.body.overridden,
      classes: req.body.classes,
      blended: req.body.blended,
    });
    return res.status(200).json({ blendId, saved: true });
  }),
);

export default router;
