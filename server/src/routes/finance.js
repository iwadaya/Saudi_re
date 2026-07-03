// server/src/routes/finance.js
//
// Finance module. Read + acknowledge surface over the finance_treaty_entry
// ledger — the entries themselves are WRITTEN by services/financePush.js in
// the same transaction as a contract SIGN / quote BIND (never by these
// routes), so "signed ⟹ in finance" is guaranteed upstream.
//
// Each entry is enriched with the contract context plus a claims rollup
// (our-share paid / OS across the contract's claims) so Finance sees premium
// AND claims cashflow exposure per treaty in one ledger row.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import { logAudit, resolveAuditActor } from '../services/audit.js';
import { financeStatusSchema, FINANCE_STATUSES } from '../validation/claims.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTRY_SELECT = `
  SELECT
    fe.entry_id, fe.contract_id, fe.source, fe.status, fe.signed_line_pct,
    fe.epi_100, fe.epi_our_share, fe.currency_code, fe.notes, fe.pushed_at,
    fe.acknowledged_at, fe.created_at, fe.updated_at,
    ack.display_name                 AS acknowledged_by_name,
    ced.company_name                 AS cedant_name,
    co.country_name                  AS country_name,
    tt.treaty_type                   AS treaty_type,
    c.uw_year, c.inception_date, c.status AS contract_status,
    cls.claims_count, cls.paid_our_share, cls.os_our_share
  FROM public.finance_treaty_entry fe
  JOIN public.contract c            ON c.contract_id = fe.contract_id
  LEFT JOIN public.uw_user ack      ON ack.user_id = fe.acknowledged_by_user_id
  LEFT JOIN public.companies ced    ON ced.company_id = c.cedant_id
  LEFT JOIN public.country co       ON co.country_id = c.country_id
  LEFT JOIN public.treaty_type tt   ON tt.treaty_type_id = c.treaty_type_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS claims_count,
           COALESCE(SUM(ROUND(mv.gross_paid_100 * COALESCE(mv.share_pct,0) / 100.0, 2)), 0) AS paid_our_share,
           COALESCE(SUM(ROUND(mv.gross_os_100   * COALESCE(mv.share_pct,0) / 100.0, 2)), 0) AS os_our_share
      FROM public.claim cl2
      LEFT JOIN LATERAL (
        SELECT m.gross_paid_100, m.gross_os_100, m.share_pct
          FROM public.claim_movement m
         WHERE m.claim_id = cl2.claim_id
         ORDER BY m.movement_no DESC LIMIT 1
      ) mv ON true
     WHERE cl2.contract_id = fe.contract_id
  ) cls ON true`;

// ── GET /api/finance/treaties ────────────────────────────────────────────────
// The signed-treaty ledger. Optional ?status=PENDING_SETUP filter.
router.get('/finance/treaties', asyncHandler(async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status && FINANCE_STATUSES.includes(String(status).toUpperCase())) {
    params.push(String(status).toUpperCase());
    where = `WHERE fe.status = $1`;
  }
  const { rows } = await pool.query(
    `${ENTRY_SELECT} ${where} ORDER BY fe.pushed_at DESC LIMIT 1000`, params);
  res.json(rows);
}));

// ── GET /api/finance/summary ─────────────────────────────────────────────────
router.get('/finance/summary', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                                   AS total_entries,
      COUNT(*) FILTER (WHERE status = 'PENDING_SETUP')::int           AS pending_setup,
      COUNT(*) FILTER (WHERE status = 'ACTIVE')::int                  AS active,
      COALESCE(SUM(epi_our_share) FILTER (WHERE status IN ('PENDING_SETUP','ACTIVE')), 0)::numeric(20,2)
                                                                      AS epi_our_share_total
    FROM public.finance_treaty_entry`);
  res.json(rows[0]);
}));

// ── GET /api/finance/entries/:id ─────────────────────────────────────────────
router.get('/finance/entries/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid entry id' });
  const { rows } = await pool.query(`${ENTRY_SELECT} WHERE fe.entry_id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Finance entry not found' });
  res.json(rows[0]);
}));

// ── POST /api/finance/entries/:id/acknowledge ────────────────────────────────
// Finance books the treaty in the GL: PENDING_SETUP → ACTIVE.
router.post('/finance/entries/:id/acknowledge', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid entry id' });
  const actor = await resolveAuditActor(req);
  const { rows } = await pool.query(
    `UPDATE public.finance_treaty_entry
        SET status = 'ACTIVE', acknowledged_by_user_id = $2, acknowledged_at = now(), updated_at = now()
      WHERE entry_id = $1 AND status = 'PENDING_SETUP'
      RETURNING entry_id, contract_id, status`,
    [id, actor.actorUserId ?? null],
  );
  if (!rows.length) {
    const { rows: exists } = await pool.query(
      'SELECT status FROM public.finance_treaty_entry WHERE entry_id=$1', [id]);
    if (!exists.length) return res.status(404).json({ error: 'Finance entry not found' });
    return res.status(422).json({ error: `Only PENDING_SETUP entries can be acknowledged (entry is ${exists[0].status}).` });
  }
  await logAudit(null, {
    entityType: 'FINANCE_ENTRY', entityId: id, eventType: 'FINANCE_ACKNOWLEDGED',
    actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
    payload: { contract_id: rows[0].contract_id },
  });
  res.json({ ok: true, ...rows[0] });
}));

// ── POST /api/finance/entries/:id/status ─────────────────────────────────────
// Explicit status set (SUSPENDED / CLOSED / back to ACTIVE), audited.
router.post('/finance/entries/:id/status', validateBody(financeStatusSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid entry id' });
  const { status, notes } = req.body;
  const actor = await resolveAuditActor(req);
  const { rows } = await pool.query(
    `UPDATE public.finance_treaty_entry
        SET status = $2, notes = COALESCE($3, notes), updated_at = now()
      WHERE entry_id = $1
      RETURNING entry_id, contract_id, status`,
    [id, status, notes ?? null],
  );
  if (!rows.length) return res.status(404).json({ error: 'Finance entry not found' });
  await logAudit(null, {
    entityType: 'FINANCE_ENTRY', entityId: id, eventType: 'FINANCE_STATUS_CHANGED',
    actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
    payload: { to: status, notes: notes ?? null },
  });
  res.json({ ok: true, ...rows[0] });
}));

export default router;
