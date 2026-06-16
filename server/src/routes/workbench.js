// server/src/routes/workbench.js
// Actuarial Formula Workbench API
//
// Endpoints (all under /api/workbench):
//   GET  /workbench/formulas                       — list formulas + status
//   GET  /workbench/formulas/:module/:name         — one formula's parameters + history + comments
//   POST /workbench/parameters                     — propose a new value (TD+)
//   PUT  /workbench/parameters/:id/approve         — approve a pending change (CU/CE)
//   PUT  /workbench/parameters/:id/reject          — reject a pending change (CU/CE)
//   POST /workbench/comments                       — post a comment on a formula
//
// Role gating uses req.user.{hierarchyLevel,isSupervisor}, set upstream by
// attachRequestContext. Anyone authenticated can read & comment; TD+ (level<=3)
// can submit; CU/CE (isSupervisor) can approve/reject.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logAudit } from '../services/audit.js';
import { actorFromReq } from '../middleware/requestContext.js';

const router = Router();

const ACTUARY_LEVEL = 3;   // TD and above can propose changes

function requireActuary(req, res, next) {
  if (!req.user || req.user.hierarchyLevel > ACTUARY_LEVEL) {
    return res.status(403).json({ error: 'Only Treaty Director or above can edit formulas.' });
  }
  next();
}

function requireApprover(req, res, next) {
  if (!req.user || !req.user.isSupervisor) {
    return res.status(403).json({ error: 'Only Chief Underwriter or Chief Executive can approve formula changes.' });
  }
  next();
}

// ─── GET /workbench/formulas ─────────────────────────────────────────────────
// Returns a flat list of formulas (module + name + parameter count + pending
// count) so the index page can show cards with a "needs review" badge.
router.get('/workbench/formulas', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT
       module,
       formula_name,
       COUNT(*)::int                                         AS parameter_count,
       COUNT(*) FILTER (WHERE status = 'PENDING')::int       AS pending_count,
       MAX(updated_at)                                       AS last_updated_at
     FROM public.formula_parameters
     GROUP BY module, formula_name
     ORDER BY module, formula_name`
  );
  res.json(rows);
}));

// ─── GET /workbench/formulas/:module/:name ───────────────────────────────────
// Returns the parameters, last 50 history rows, and last 100 comments for one
// formula. The client uses this for the detail view.
router.get('/workbench/formulas/:module/:name', asyncHandler(async (req, res) => {
  const { module: mod, name } = req.params;

  const [{ rows: params }, { rows: history }, { rows: comments }] = await Promise.all([
    pool.query(
      `SELECT id, module, formula_name, parameter_key,
              current_value, pending_value, status,
              updated_by, updated_by_name, updated_at, created_at
         FROM public.formula_parameters
        WHERE module = $1 AND formula_name = $2
        ORDER BY parameter_key`,
      [mod, name]
    ),
    pool.query(
      `SELECT l.id, l.formula_parameter_id, p.parameter_key,
              l.action, l.old_value, l.new_value,
              l.changed_by, l.changed_by_name, l.changed_at,
              l.comment, l.approved_by, l.approved_by_name, l.approved_at
         FROM public.formula_change_log l
         JOIN public.formula_parameters p ON p.id = l.formula_parameter_id
        WHERE p.module = $1 AND p.formula_name = $2
        ORDER BY l.changed_at DESC
        LIMIT 50`,
      [mod, name]
    ),
    pool.query(
      `SELECT id, comment_text, author_id, author_name, author_role,
              parent_comment_id, created_at
         FROM public.formula_comments
        WHERE module = $1 AND formula_name = $2
        ORDER BY created_at DESC
        LIMIT 100`,
      [mod, name]
    ),
  ]);

  res.json({ module: mod, formula_name: name, parameters: params, history, comments });
}));

// ─── POST /workbench/parameters ──────────────────────────────────────────────
// Submit a proposed value. Body: { module, formula_name, parameter_key,
// proposed_value, comment }. If no row exists yet, one is upserted with
// current_value=null. Sets status=PENDING and writes a SUBMIT log row.
router.post('/workbench/parameters', requireActuary, asyncHandler(async (req, res) => {
  const { module: mod, formula_name, parameter_key, proposed_value, comment } = req.body || {};
  if (!mod || !formula_name || !parameter_key) {
    return res.status(400).json({ error: 'module, formula_name, parameter_key are required.' });
  }
  if (proposed_value === undefined) {
    return res.status(400).json({ error: 'proposed_value is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert: insert new row OR update existing one with the proposal.
    const { rows: upsertRows } = await client.query(
      `INSERT INTO public.formula_parameters
         (module, formula_name, parameter_key, current_value, pending_value, status,
          updated_by, updated_by_name, updated_at)
       VALUES ($1, $2, $3, NULL, $4::jsonb, 'PENDING', $5, $6, now())
       ON CONFLICT (module, formula_name, parameter_key) DO UPDATE
         SET pending_value = EXCLUDED.pending_value,
             status        = 'PENDING',
             updated_by    = EXCLUDED.updated_by,
             updated_by_name = EXCLUDED.updated_by_name,
             updated_at    = now()
       RETURNING id, current_value, pending_value`,
      [mod, formula_name, parameter_key, JSON.stringify(proposed_value),
       req.user.userId, req.user.displayName]
    );
    const param = upsertRows[0];

    await client.query(
      `INSERT INTO public.formula_change_log
         (formula_parameter_id, action, old_value, new_value, changed_by, changed_by_name, comment)
       VALUES ($1, 'SUBMIT', $2::jsonb, $3::jsonb, $4, $5, $6)`,
      [param.id, JSON.stringify(param.current_value), JSON.stringify(proposed_value),
       req.user.userId, req.user.displayName, comment || null]
    );

    await logAudit(client, {
      entityType: 'FORMULA_PARAMETER', entityId: param.id,
      eventType: 'SUBMIT', actor: actorFromReq(req),
      payload: { module: mod, formula_name, parameter_key, proposed_value },
    }, { critical: true });
    await client.query('COMMIT');

    res.status(201).json({ id: param.id, status: 'PENDING' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// ─── PUT /workbench/parameters/:id/approve ───────────────────────────────────
// Move pending_value into current_value, clear pending, set APPROVED.
router.put('/workbench/parameters/:id/approve', requireApprover, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      `SELECT id, current_value, pending_value, status
         FROM public.formula_parameters
        WHERE id = $1
        FOR UPDATE`,
      [id]
    );
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parameter not found.' });
    }
    const existing = existingRows[0];
    if (existing.status !== 'PENDING' || existing.pending_value === null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No pending change to approve.' });
    }

    const { rows: updRows } = await client.query(
      `UPDATE public.formula_parameters
          SET current_value = pending_value,
              pending_value = NULL,
              status        = 'APPROVED',
              updated_at    = now()
        WHERE id = $1
        RETURNING id, current_value`,
      [id]
    );

    await client.query(
      `INSERT INTO public.formula_change_log
         (formula_parameter_id, action, old_value, new_value,
          changed_by, changed_by_name, comment,
          approved_by, approved_by_name, approved_at)
       VALUES ($1, 'APPROVE', $2::jsonb, $3::jsonb, $4, $5, $6, $4, $5, now())`,
      [id, JSON.stringify(existing.current_value),
       JSON.stringify(existing.pending_value),
       req.user.userId, req.user.displayName, comment || null]
    );

    await logAudit(client, {
      entityType: 'FORMULA_PARAMETER', entityId: id,
      eventType: 'APPROVE', actor: actorFromReq(req),
      payload: { new_value: existing.pending_value },
    }, { critical: true });
    await client.query('COMMIT');

    res.json(updRows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// ─── PUT /workbench/parameters/:id/reject ────────────────────────────────────
router.put('/workbench/parameters/:id/reject', requireApprover, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { comment } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query(
      `SELECT id, current_value, pending_value, status
         FROM public.formula_parameters
        WHERE id = $1
        FOR UPDATE`,
      [id]
    );
    if (!existingRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parameter not found.' });
    }
    const existing = existingRows[0];
    if (existing.status !== 'PENDING' || existing.pending_value === null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No pending change to reject.' });
    }

    // current_value becomes APPROVED again if it had one; otherwise the row
    // goes to REJECTED so the UI can show the rejection without resurrecting
    // an empty current_value.
    const newStatus = existing.current_value === null ? 'REJECTED' : 'APPROVED';

    await client.query(
      `UPDATE public.formula_parameters
          SET pending_value = NULL,
              status        = $2,
              updated_at    = now()
        WHERE id = $1`,
      [id, newStatus]
    );

    await client.query(
      `INSERT INTO public.formula_change_log
         (formula_parameter_id, action, old_value, new_value,
          changed_by, changed_by_name, comment,
          approved_by, approved_by_name, approved_at)
       VALUES ($1, 'REJECT', $2::jsonb, $3::jsonb, $4, $5, $6, $4, $5, now())`,
      [id, JSON.stringify(existing.current_value),
       JSON.stringify(existing.pending_value),
       req.user.userId, req.user.displayName, comment || null]
    );

    await logAudit(client, {
      entityType: 'FORMULA_PARAMETER', entityId: id,
      eventType: 'REJECT', actor: actorFromReq(req),
      payload: { rejected_value: existing.pending_value },
    }, { critical: true });
    await client.query('COMMIT');

    res.json({ id, status: newStatus });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// ─── POST /workbench/comments ────────────────────────────────────────────────
// Body: { module, formula_name, comment_text, parent_comment_id? }
router.post('/workbench/comments', asyncHandler(async (req, res) => {
  const { module: mod, formula_name, comment_text, parent_comment_id } = req.body || {};
  if (!mod || !formula_name || !comment_text || !comment_text.trim()) {
    return res.status(400).json({ error: 'module, formula_name and comment_text are required.' });
  }

  const { rows } = await pool.query(
    `INSERT INTO public.formula_comments
       (module, formula_name, comment_text, author_id, author_name, author_role, parent_comment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [mod, formula_name, comment_text.trim(),
     req.user.userId, req.user.displayName, req.user.role,
     parent_comment_id || null]
  );

  res.status(201).json(rows[0]);
}));

export default router;
