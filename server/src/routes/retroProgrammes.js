// server/src/routes/retroProgrammes.js
//
// The outward retro contract, one placement per underwriting year per currency
// (table: retro_programme, migration 140). Admins capture it manually each year;
// the offer modal's retro cover analysis reads it to price a written line
// through the programme.
//
// Reads are open to any authenticated user — every underwriter needs the
// programme to see what their line does to it. Writes are level 2 (Chief
// Executive / Chief Underwriter / Chief Actuary), the same tier that maintains
// users and mandates.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler, toNum } from '../helpers.js';
import { requireAuth, requireMinLevel } from '../middleware/requestContext.js';
import { validateBody } from '../lib/validate.js';
import { logAudit, resolveAuditActor } from '../services/audit.js';
import { retroProgrammeSchema } from '../validation/retroProgramme.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLS = `
  retro_programme_id, uw_year, currency, label, reinsurer,
  inception_date, expiry_date,
  retention_amt, limit_amt, rol_pct, used_limit_amt,
  cession_pct, commission_pct, max_line_pct,
  notes, is_active, created_at, updated_at, created_by, updated_by
`;

/** Postgres hands numerics back as strings; the pricing maths wants numbers. */
function toProgramme(row) {
  if (!row) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    ...row,
    uw_year: num(row.uw_year),
    retention_amt: num(row.retention_amt),
    limit_amt: num(row.limit_amt),
    rol_pct: num(row.rol_pct),
    used_limit_amt: num(row.used_limit_amt),
    cession_pct: num(row.cession_pct),
    commission_pct: num(row.commission_pct),
    max_line_pct: num(row.max_line_pct),
    inception_date: row.inception_date ? String(row.inception_date).slice(0, 10) : null,
    expiry_date: row.expiry_date ? String(row.expiry_date).slice(0, 10) : null,
  };
}

router.use('/retro-programmes', requireAuth);

/** List — newest year first. `?year=` narrows to one underwriting year. */
router.get('/retro-programmes', asyncHandler(async (req, res) => {
  const year = Number.parseInt(req.query.year, 10);
  const hasYear = Number.isFinite(year);
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
       FROM public.retro_programme
      ${hasYear ? 'WHERE uw_year = $1' : ''}
      ORDER BY uw_year DESC, currency ASC`,
    hasYear ? [year] : [],
  );
  res.json({ programmes: rows.map(toProgramme) });
}));

/**
 * The programme a treaty is written against: exact (year, currency) match, or
 * null. No FX conversion — a programme placed in another currency is not this
 * treaty's cover, so we say which currencies that year does have and let the
 * caller show an honest gap.
 */
router.get('/retro-programmes/lookup', asyncHandler(async (req, res) => {
  const year = Number.parseInt(req.query.year, 10);
  const currency = String(req.query.currency || '').trim().toUpperCase();
  if (!Number.isFinite(year) || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({
      error: 'year (integer) and currency (3-letter code) are required.',
      code: 'BAD_REQUEST',
    });
  }
  const { rows } = await pool.query(
    `SELECT ${SELECT_COLS}
       FROM public.retro_programme
      WHERE uw_year = $1 AND is_active = true
      ORDER BY currency ASC`,
    [year],
  );
  const match = rows.find((r) => r.currency === currency) || null;
  res.json({
    programme: toProgramme(match),
    year,
    currency,
    availableCurrencies: rows.map((r) => r.currency),
  });
}));

/**
 * Create or replace the programme for a (year, currency). Upsert rather than
 * POST-then-PUT: there is exactly one retro contract per year per currency, so
 * the admin screen edits the year, not a row id.
 */
router.post('/retro-programmes', requireMinLevel(2), validateBody(retroProgrammeSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const actor = await resolveAuditActor(req);
    const { rows } = await pool.query(
      `INSERT INTO public.retro_programme (
         uw_year, currency, label, reinsurer, inception_date, expiry_date,
         retention_amt, limit_amt, rol_pct, used_limit_amt,
         cession_pct, commission_pct, max_line_pct, notes, is_active,
         created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,
               -- Explicit ::numeric casts: COALESCE against an integer literal
               -- makes Postgres infer the parameter as integer, which rejects
               -- a 9.5% rate on line.
               COALESCE($7::numeric,0), COALESCE($8::numeric,0),
               COALESCE($9::numeric,0), COALESCE($10::numeric,0),
               COALESCE($11::numeric,0), COALESCE($12::numeric,0),
               COALESCE($13::numeric,25), $14, COALESCE($15::boolean,true),
               $16, $16)
       ON CONFLICT (uw_year, currency) DO UPDATE SET
         label          = EXCLUDED.label,
         reinsurer      = EXCLUDED.reinsurer,
         inception_date = EXCLUDED.inception_date,
         expiry_date    = EXCLUDED.expiry_date,
         retention_amt  = EXCLUDED.retention_amt,
         limit_amt      = EXCLUDED.limit_amt,
         rol_pct        = EXCLUDED.rol_pct,
         used_limit_amt = EXCLUDED.used_limit_amt,
         cession_pct    = EXCLUDED.cession_pct,
         commission_pct = EXCLUDED.commission_pct,
         max_line_pct   = EXCLUDED.max_line_pct,
         notes          = EXCLUDED.notes,
         is_active      = EXCLUDED.is_active,
         updated_by     = EXCLUDED.updated_by,
         updated_at     = now()
       RETURNING ${SELECT_COLS}`,
      [
        b.uw_year, b.currency, b.label ?? null, b.reinsurer ?? null,
        b.inception_date ?? null, b.expiry_date ?? null,
        toNum(b.retention_amt), toNum(b.limit_amt), toNum(b.rol_pct), toNum(b.used_limit_amt),
        toNum(b.cession_pct), toNum(b.commission_pct), toNum(b.max_line_pct),
        b.notes ?? null, b.is_active ?? null,
        actor.actorName || actor.actorUserId || null,
      ],
    );
    const programme = toProgramme(rows[0]);
    await logAudit(null, {
      entityType: 'RETRO_PROGRAMME',
      entityId: programme.retro_programme_id,
      eventType: 'RETRO_PROGRAMME_SAVED',
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { uw_year: programme.uw_year, currency: programme.currency },
    });
    res.json({ programme });
  }));

router.delete('/retro-programmes/:id', requireMinLevel(2), asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid programme id.', code: 'BAD_REQUEST' });
  }
  const actor = await resolveAuditActor(req);
  const { rows } = await pool.query(
    'DELETE FROM public.retro_programme WHERE retro_programme_id = $1 RETURNING uw_year, currency',
    [id],
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'Retro programme not found.', code: 'NOT_FOUND' });
  }
  await logAudit(null, {
    entityType: 'RETRO_PROGRAMME',
    entityId: id,
    eventType: 'RETRO_PROGRAMME_DELETED',
    actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
    payload: { uw_year: rows[0].uw_year, currency: rows[0].currency },
  });
  res.json({ ok: true });
}));

export default router;
