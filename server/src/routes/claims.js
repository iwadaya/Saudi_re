// server/src/routes/claims.js
//
// Claims module. Cedant-advised treaty claims booked against SIGNED/BOUND
// contracts. Positions live in the immutable claim_movement ledger — each
// movement restates the CUMULATIVE 100% position (gross_paid_100 /
// gross_os_100); the latest movement IS the current position and
// incurred = paid + OS. Our share applies the share_pct snapshotted per
// movement (contract signed line at booking time).
//
// Authorization: mounted behind the blanket requireAuth (app.js). Claims are
// not assignee edit-locked (classifyMutationPath → null) — any authenticated
// underwriter can book movements; every mutation writes an audit_log row
// (entity_type CLAIM) with the DB-resolved actor.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { validateBody } from '../lib/validate.js';
import { withTransaction } from '../db/withTransaction.js';
import { logAudit, resolveAuditActor } from '../services/audit.js';
import {
  claimCreateSchema, claimUpdateSchema, movementCreateSchema,
  claimCloseSchema, claimReviewSchema, claimNoteSchema, APPROVAL_STATUSES,
} from '../validation/claims.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared SELECT for claim lists/detail: header + contract context + latest position. */
const CLAIM_SELECT = `
  SELECT
    cl.claim_id, cl.claim_ref, cl.contract_id, cl.cedant_claim_ref, cl.insured_name,
    cl.loss_date, cl.reported_date, cl.cause_of_loss, cl.description,
    cl.loss_type, cl.cat_event_ref, cl.status, cl.closed_at, cl.closed_reason,
    cl.approval_status, cl.submitted_at, cl.reviewed_at, cl.review_comment,
    cl.class_of_business_id, cl.currency_id, cl.created_at, cl.updated_at,
    sub.display_name                    AS submitted_by_name,
    rev.display_name                    AS reviewed_by_name,
    ced.company_name                    AS cedant_name,
    co.country_name                     AS country_name,
    tt.treaty_type                      AS treaty_type,
    c.uw_year                           AS uw_year,
    c.signed_line_pct                   AS contract_signed_line_pct,
    cob.class_of_business               AS class_of_business,
    COALESCE(cur.currency_code, ccur.currency_code) AS currency_code,
    mv.movement_no                      AS last_movement_no,
    mv.movement_date                    AS last_movement_date,
    COALESCE(mv.gross_paid_100, 0)      AS gross_paid_100,
    COALESCE(mv.gross_os_100, 0)        AS gross_os_100,
    COALESCE(mv.gross_paid_100, 0) + COALESCE(mv.gross_os_100, 0) AS gross_incurred_100,
    mv.share_pct                        AS share_pct,
    ROUND(COALESCE(mv.gross_paid_100, 0) * COALESCE(mv.share_pct, 0) / 100.0, 2) AS paid_our_share,
    ROUND(COALESCE(mv.gross_os_100, 0)   * COALESCE(mv.share_pct, 0) / 100.0, 2) AS os_our_share,
    ROUND((COALESCE(mv.gross_paid_100, 0) + COALESCE(mv.gross_os_100, 0)) * COALESCE(mv.share_pct, 0) / 100.0, 2) AS incurred_our_share
  FROM public.claim cl
  JOIN public.contract c            ON c.contract_id = cl.contract_id
  LEFT JOIN public.companies ced    ON ced.company_id = c.cedant_id
  LEFT JOIN public.country co       ON co.country_id = c.country_id
  LEFT JOIN public.treaty_type tt   ON tt.treaty_type_id = c.treaty_type_id
  LEFT JOIN public.class_of_business cob ON cob.class_of_business_id = cl.class_of_business_id
  LEFT JOIN public.currency cur     ON cur.currency_id = cl.currency_id
  LEFT JOIN public.currency ccur    ON ccur.currency_id = c.currency_id
  LEFT JOIN public.uw_user sub      ON sub.user_id = cl.submitted_by_user_id
  LEFT JOIN public.uw_user rev      ON rev.user_id = cl.reviewed_by_user_id
  LEFT JOIN LATERAL (
    SELECT m.movement_no, m.movement_date, m.gross_paid_100, m.gross_os_100, m.share_pct
      FROM public.claim_movement m
     WHERE m.claim_id = cl.claim_id
     ORDER BY m.movement_no DESC
     LIMIT 1
  ) mv ON true`;

// ── GET /api/claims ──────────────────────────────────────────────────────────
// List with optional filters:
//   ?status=OPEN&approval_status=WAITING_APPROVAL&contract_id=…&loss_type=…&q=text
router.get('/claims', asyncHandler(async (req, res) => {
  const { status, approval_status: approvalStatus, contract_id: contractId, loss_type: lossType, q } = req.query;
  const where = [];
  const params = [];
  if (status && ['OPEN', 'REOPENED', 'CLOSED', 'DECLINED'].includes(String(status).toUpperCase())) {
    params.push(String(status).toUpperCase());
    where.push(`cl.status = $${params.length}`);
  }
  if (approvalStatus && APPROVAL_STATUSES.includes(String(approvalStatus).toUpperCase())) {
    params.push(String(approvalStatus).toUpperCase());
    where.push(`cl.approval_status = $${params.length}`);
  }
  if (contractId && UUID_RE.test(String(contractId))) {
    params.push(contractId);
    where.push(`cl.contract_id = $${params.length}`);
  }
  if (lossType && ['ATTRITIONAL', 'LARGE', 'CAT'].includes(String(lossType).toUpperCase())) {
    params.push(String(lossType).toUpperCase());
    where.push(`cl.loss_type = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    where.push(`(cl.claim_ref ILIKE $${params.length} OR cl.cedant_claim_ref ILIKE $${params.length}
                 OR cl.insured_name ILIKE $${params.length} OR ced.company_name ILIKE $${params.length})`);
  }
  const sql = `${CLAIM_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY cl.updated_at DESC
    LIMIT 500`;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
}));

// ── GET /api/claims/summary ──────────────────────────────────────────────────
// Headline KPIs for the claims home screen.
router.get('/claims/summary', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT cl.claim_id, cl.status, cl.approval_status, cl.loss_type,
             COALESCE(mv.gross_paid_100, 0) AS paid_100,
             COALESCE(mv.gross_os_100, 0)   AS os_100,
             COALESCE(mv.share_pct, 0)      AS share_pct
        FROM public.claim cl
        LEFT JOIN LATERAL (
          SELECT m.gross_paid_100, m.gross_os_100, m.share_pct
            FROM public.claim_movement m
           WHERE m.claim_id = cl.claim_id
           ORDER BY m.movement_no DESC LIMIT 1
        ) mv ON true
    )
    SELECT
      COUNT(*)::int                                                        AS total_claims,
      COUNT(*) FILTER (WHERE status IN ('OPEN','REOPENED'))::int           AS open_claims,
      COUNT(*) FILTER (WHERE status = 'CLOSED')::int                       AS closed_claims,
      COUNT(*) FILTER (WHERE loss_type = 'CAT')::int                       AS cat_claims,
      COUNT(*) FILTER (WHERE approval_status = 'DRAFT')::int               AS draft_claims,
      COUNT(*) FILTER (WHERE approval_status = 'WAITING_APPROVAL')::int    AS waiting_approval_claims,
      COUNT(*) FILTER (WHERE approval_status = 'REJECTED')::int            AS rejected_claims,
      COUNT(*) FILTER (WHERE approval_status = 'FINALISED')::int           AS finalised_claims,
      COALESCE(SUM((paid_100 + os_100) * share_pct / 100.0)
               FILTER (WHERE status IN ('OPEN','REOPENED')), 0)::numeric(20,2) AS open_incurred_our_share,
      COALESCE(SUM(os_100 * share_pct / 100.0)
               FILTER (WHERE status IN ('OPEN','REOPENED')), 0)::numeric(20,2) AS open_os_our_share,
      -- Paid to date excludes claims the reviewer rejected.
      COALESCE(SUM(paid_100 * share_pct / 100.0)
               FILTER (WHERE approval_status <> 'REJECTED'), 0)::numeric(20,2) AS total_paid_our_share
    FROM latest`);
  res.json(rows[0]);
}));

// ── GET /api/claims/eligible-contracts ───────────────────────────────────────
// SIGNED/BOUND contracts a claim can be booked against (create-claim dropdown).
router.get('/claims/eligible-contracts', asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT c.contract_id, c.uw_year, c.status, c.signed_line_pct, c.inception_date,
           ced.company_name AS cedant_name, co.country_name,
           tt.treaty_type, cur.currency_code
      FROM public.contract c
      LEFT JOIN public.companies ced  ON ced.company_id = c.cedant_id
      LEFT JOIN public.country co     ON co.country_id = c.country_id
      LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      LEFT JOIN public.currency cur   ON cur.currency_id = c.currency_id
     WHERE c.status IN ('SIGNED','BOUND')
     ORDER BY ced.company_name NULLS LAST, c.uw_year DESC
     LIMIT 1000`);
  res.json(rows);
}));

// ── POST /api/claims ─────────────────────────────────────────────────────────
// Create a claim + its opening ADVICE movement in one transaction.
router.post('/claims', validateBody(claimCreateSchema), asyncHandler(async (req, res) => {
  const b = req.body;
  const actor = await resolveAuditActor(req);

  const out = await withTransaction(async (client) => {
    const { rows: cRows } = await client.query(
      `SELECT contract_id, status, signed_line_pct, currency_id, primary_class_of_business_id
         FROM public.contract WHERE contract_id = $1 FOR UPDATE`,
      [b.contract_id],
    );
    if (!cRows.length) {
      const e = new Error('Contract not found'); e.status = 404; throw e;
    }
    const contract = cRows[0];
    if (!['SIGNED', 'BOUND'].includes(String(contract.status).toUpperCase())) {
      const e = new Error(`Claims can only be booked against SIGNED or BOUND treaties (contract is ${contract.status}).`);
      e.status = 422; e.code = 'CONTRACT_NOT_SIGNED'; throw e;
    }

    const { rows: refRows } = await client.query(
      `SELECT 'CLM-' || lpad(nextval('public.claim_ref_seq')::text, 6, '0') AS ref`);
    const claimRef = refRows[0].ref;

    const { rows: clRows } = await client.query(
      `INSERT INTO public.claim
         (claim_ref, contract_id, class_of_business_id, currency_id, cedant_claim_ref,
          insured_name, loss_date, reported_date, cause_of_loss, description,
          loss_type, cat_event_ref, created_by_user_id, assigned_to_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, CURRENT_DATE),$9,$10,$11,$12,$13,$13)
       RETURNING claim_id, claim_ref`,
      [claimRef, b.contract_id,
       b.class_of_business_id ?? contract.primary_class_of_business_id ?? null,
       b.currency_id ?? contract.currency_id ?? null,
       b.cedant_claim_ref ?? null, b.insured_name ?? null,
       b.loss_date, b.reported_date ?? null, b.cause_of_loss ?? null,
       b.description ?? null, b.loss_type, b.cat_event_ref ?? null,
       actor.actorUserId ?? null],
    );
    const claim = clRows[0];

    await client.query(
      `INSERT INTO public.claim_movement
         (claim_id, movement_no, movement_date, movement_type,
          gross_paid_100, gross_os_100, share_pct, comment, created_by_user_id)
       VALUES ($1, 1, COALESCE($2, CURRENT_DATE), 'ADVICE', $3, $4, $5, $6, $7)`,
      [claim.claim_id, b.reported_date ?? null, b.gross_paid_100, b.gross_os_100,
       contract.signed_line_pct ?? null, b.comment ?? 'Initial advice', actor.actorUserId ?? null],
    );

    await logAudit(client, {
      entityType: 'CLAIM', entityId: claim.claim_id, eventType: 'CLAIM_CREATED',
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { claim_ref: claim.claim_ref, contract_id: b.contract_id,
                 gross_paid_100: b.gross_paid_100, gross_os_100: b.gross_os_100 },
    }, { critical: true });

    return claim;
  });

  res.status(201).json({ ok: true, ...out });
}));

// ── GET /api/claims/:id ──────────────────────────────────────────────────────
router.get('/claims/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid claim id' });
  const [{ rows: header }, { rows: movements }, { rows: notes }] = await Promise.all([
    pool.query(`${CLAIM_SELECT} WHERE cl.claim_id = $1`, [id]),
    pool.query(
      `SELECT m.movement_id, m.movement_no, m.movement_date, m.movement_type,
              m.gross_paid_100, m.gross_os_100, m.share_pct, m.comment, m.created_at,
              m.gross_paid_100 + m.gross_os_100 AS gross_incurred_100,
              u.display_name AS created_by_name
         FROM public.claim_movement m
         LEFT JOIN public.uw_user u ON u.user_id = m.created_by_user_id
        WHERE m.claim_id = $1
        ORDER BY m.movement_no ASC`, [id]),
    pool.query(
      `SELECT n.note_id, n.note, n.created_at, u.display_name AS created_by_name
         FROM public.claim_note n
         LEFT JOIN public.uw_user u ON u.user_id = n.created_by_user_id
        WHERE n.claim_id = $1
        ORDER BY n.created_at DESC`, [id]),
  ]);
  if (!header.length) return res.status(404).json({ error: 'Claim not found' });
  res.json({ ...header[0], movements, notes });
}));

// ── PUT /api/claims/:id ──────────────────────────────────────────────────────
router.put('/claims/:id', validateBody(claimUpdateSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const actor = await resolveAuditActor(req);

  const cols = ['loss_date', 'reported_date', 'class_of_business_id', 'currency_id',
    'cedant_claim_ref', 'insured_name', 'cause_of_loss', 'description',
    'loss_type', 'cat_event_ref'];
  const sets = [];
  const params = [id];
  for (const c of cols) {
    if (b[c] !== undefined) { params.push(b[c]); sets.push(`${c} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No updatable fields supplied' });

  const { rows } = await pool.query(
    `UPDATE public.claim SET ${sets.join(', ')}, updated_at = now()
      WHERE claim_id = $1 AND status IN ('OPEN','REOPENED')
        AND approval_status <> 'WAITING_APPROVAL'
      RETURNING claim_id, claim_ref`,
    params,
  );
  if (!rows.length) {
    const { rows: exists } = await pool.query('SELECT status, approval_status FROM public.claim WHERE claim_id=$1', [id]);
    if (!exists.length) return res.status(404).json({ error: 'Claim not found' });
    if (exists[0].approval_status === 'WAITING_APPROVAL') {
      return res.status(422).json({ error: 'Claim is awaiting approval — it is frozen until reviewed.' });
    }
    return res.status(422).json({ error: `Cannot edit a ${exists[0].status} claim — reopen it first.` });
  }
  await logAudit(null, {
    entityType: 'CLAIM', entityId: id, eventType: 'CLAIM_UPDATED',
    actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
    payload: { changed: Object.keys(b) },
  });
  res.json({ ok: true, ...rows[0] });
}));

// ── POST /api/claims/:id/movements ───────────────────────────────────────────
// Book a movement (cumulative restatement). Serialised per claim via FOR UPDATE.
router.post('/claims/:id/movements', validateBody(movementCreateSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const actor = await resolveAuditActor(req);

  const out = await withTransaction(async (client) => {
    const { rows: clRows } = await client.query(
      `SELECT cl.claim_id, cl.status, cl.approval_status, c.signed_line_pct
         FROM public.claim cl JOIN public.contract c ON c.contract_id = cl.contract_id
        WHERE cl.claim_id = $1 FOR UPDATE OF cl`,
      [id],
    );
    if (!clRows.length) { const e = new Error('Claim not found'); e.status = 404; throw e; }
    const claim = clRows[0];
    if (!['OPEN', 'REOPENED'].includes(claim.status)) {
      const e = new Error(`Cannot book a movement on a ${claim.status} claim — reopen it first.`);
      e.status = 422; e.code = 'CLAIM_NOT_OPEN'; throw e;
    }
    if (claim.approval_status === 'WAITING_APPROVAL') {
      const e = new Error('Claim is awaiting approval — the ledger is frozen until reviewed.');
      e.status = 422; e.code = 'CLAIM_UNDER_REVIEW'; throw e;
    }

    const { rows: nextRows } = await client.query(
      `SELECT COALESCE(MAX(movement_no), 0) + 1 AS next_no
         FROM public.claim_movement WHERE claim_id = $1`, [id]);
    const nextNo = nextRows[0].next_no;

    const { rows: mvRows } = await client.query(
      `INSERT INTO public.claim_movement
         (claim_id, movement_no, movement_date, movement_type,
          gross_paid_100, gross_os_100, share_pct, comment, created_by_user_id)
       VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4,$5,$6,$7,$8,$9)
       RETURNING movement_id, movement_no`,
      [id, nextNo, b.movement_date ?? null, b.movement_type,
       b.gross_paid_100, b.gross_os_100, claim.signed_line_pct ?? null,
       b.comment ?? null, actor.actorUserId ?? null],
    );

    await logAudit(client, {
      entityType: 'CLAIM', entityId: id, eventType: 'MOVEMENT_BOOKED',
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { movement_no: nextNo, movement_type: b.movement_type,
                 gross_paid_100: b.gross_paid_100, gross_os_100: b.gross_os_100 },
    }, { critical: true });

    return mvRows[0];
  });

  res.status(201).json({ ok: true, ...out });
}));

/** Shared close/decline/reopen transition. */
async function transitionClaim(req, res, { toStatus, movementType, eventType }) {
  const { id } = req.params;
  const reason = req.body?.reason ?? null;
  const actor = await resolveAuditActor(req);

  const out = await withTransaction(async (client) => {
    const { rows: clRows } = await client.query(
      `SELECT cl.claim_id, cl.status, cl.approval_status, c.signed_line_pct
         FROM public.claim cl JOIN public.contract c ON c.contract_id = cl.contract_id
        WHERE cl.claim_id = $1 FOR UPDATE OF cl`, [id]);
    if (!clRows.length) { const e = new Error('Claim not found'); e.status = 404; throw e; }
    const claim = clRows[0];

    const legal = toStatus === 'REOPENED'
      ? ['CLOSED', 'DECLINED'].includes(claim.status)
      : ['OPEN', 'REOPENED'].includes(claim.status);
    if (!legal) {
      const e = new Error(`Cannot move a ${claim.status} claim to ${toStatus}.`);
      e.status = 422; e.code = 'ILLEGAL_CLAIM_TRANSITION'; throw e;
    }
    if (claim.approval_status === 'WAITING_APPROVAL') {
      const e = new Error('Claim is awaiting approval — it is frozen until reviewed.');
      e.status = 422; e.code = 'CLAIM_UNDER_REVIEW'; throw e;
    }

    const { rows: lastRows } = await client.query(
      `SELECT movement_no, gross_paid_100, gross_os_100 FROM public.claim_movement
        WHERE claim_id = $1 ORDER BY movement_no DESC LIMIT 1`, [id]);
    const last = lastRows[0] || { movement_no: 0, gross_paid_100: 0, gross_os_100: 0 };

    // CLOSURE/DECLINE zeroes the outstanding reserve; REOPEN restates the last position.
    const os = toStatus === 'REOPENED' ? last.gross_os_100 : 0;
    await client.query(
      `INSERT INTO public.claim_movement
         (claim_id, movement_no, movement_type, gross_paid_100, gross_os_100,
          share_pct, comment, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, Number(last.movement_no) + 1, movementType, last.gross_paid_100, os,
       claim.signed_line_pct ?? null, reason, actor.actorUserId ?? null],
    );

    await client.query(
      `UPDATE public.claim
          SET status = $2,
              closed_at = CASE WHEN $2 IN ('CLOSED','DECLINED') THEN now() ELSE NULL END,
              closed_reason = CASE WHEN $2 IN ('CLOSED','DECLINED') THEN $3 ELSE NULL END,
              updated_at = now()
        WHERE claim_id = $1`,
      [id, toStatus, reason],
    );

    await logAudit(client, {
      entityType: 'CLAIM', entityId: id, eventType,
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { from: claim.status, to: toStatus, reason },
    }, { critical: true });

    return { claim_id: id, status: toStatus };
  });

  res.json({ ok: true, ...out });
}

router.post('/claims/:id/close', validateBody(claimCloseSchema), asyncHandler(
  (req, res) => transitionClaim(req, res, { toStatus: 'CLOSED', movementType: 'CLOSURE', eventType: 'CLAIM_CLOSED' })));

router.post('/claims/:id/decline', validateBody(claimCloseSchema), asyncHandler(
  (req, res) => transitionClaim(req, res, { toStatus: 'DECLINED', movementType: 'CLOSURE', eventType: 'CLAIM_DECLINED' })));

router.post('/claims/:id/reopen', validateBody(claimCloseSchema), asyncHandler(
  (req, res) => transitionClaim(req, res, { toStatus: 'REOPENED', movementType: 'REOPEN', eventType: 'CLAIM_REOPENED' })));

/**
 * Shared approval-workflow transition (submit / approve / reject).
 * DRAFT|REJECTED → WAITING_APPROVAL → FINALISED | REJECTED. While a claim is
 * WAITING_APPROVAL every other mutation (edits, movements, close/reopen) is
 * frozen, so the reviewer decides on exactly what was submitted.
 */
async function transitionApproval(req, res, { toStatus, from, eventType }) {
  const { id } = req.params;
  const reason = req.body?.reason ?? null;
  const actor = await resolveAuditActor(req);

  const out = await withTransaction(async (client) => {
    const { rows: clRows } = await client.query(
      `SELECT claim_id, claim_ref, approval_status FROM public.claim
        WHERE claim_id = $1 FOR UPDATE`, [id]);
    if (!clRows.length) { const e = new Error('Claim not found'); e.status = 404; throw e; }
    const claim = clRows[0];
    if (!from.includes(claim.approval_status)) {
      const e = new Error(`Cannot move a ${claim.approval_status} claim to ${toStatus}.`);
      e.status = 422; e.code = 'ILLEGAL_APPROVAL_TRANSITION'; throw e;
    }

    if (toStatus === 'WAITING_APPROVAL') {
      await client.query(
        `UPDATE public.claim
            SET approval_status = 'WAITING_APPROVAL',
                submitted_at = now(), submitted_by_user_id = $2,
                reviewed_at = NULL, reviewed_by_user_id = NULL, review_comment = NULL,
                updated_at = now()
          WHERE claim_id = $1`,
        [id, actor.actorUserId ?? null],
      );
    } else {
      await client.query(
        `UPDATE public.claim
            SET approval_status = $2,
                reviewed_at = now(), reviewed_by_user_id = $3, review_comment = $4,
                updated_at = now()
          WHERE claim_id = $1`,
        [id, toStatus, actor.actorUserId ?? null, reason],
      );
    }

    await logAudit(client, {
      entityType: 'CLAIM', entityId: id, eventType,
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { claim_ref: claim.claim_ref, from: claim.approval_status, to: toStatus, reason },
    }, { critical: true });

    return { claim_id: id, approval_status: toStatus };
  });

  res.json({ ok: true, ...out });
}

// ── POST /api/claims/:id/submit · /approve · /reject ────────────────────────
router.post('/claims/:id/submit', validateBody(claimReviewSchema), asyncHandler(
  (req, res) => transitionApproval(req, res, { toStatus: 'WAITING_APPROVAL', from: ['DRAFT', 'REJECTED'], eventType: 'CLAIM_SUBMITTED' })));

router.post('/claims/:id/approve', validateBody(claimReviewSchema), asyncHandler(
  (req, res) => transitionApproval(req, res, { toStatus: 'FINALISED', from: ['WAITING_APPROVAL'], eventType: 'CLAIM_APPROVED' })));

router.post('/claims/:id/reject', validateBody(claimReviewSchema), asyncHandler(
  (req, res) => transitionApproval(req, res, { toStatus: 'REJECTED', from: ['WAITING_APPROVAL'], eventType: 'CLAIM_REJECTED' })));

// ── POST /api/claims/:id/notes ───────────────────────────────────────────────
router.post('/claims/:id/notes', validateBody(claimNoteSchema), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const actor = await resolveAuditActor(req);
  const { rows: exists } = await pool.query('SELECT 1 FROM public.claim WHERE claim_id=$1', [id]);
  if (!exists.length) return res.status(404).json({ error: 'Claim not found' });
  const { rows } = await pool.query(
    `INSERT INTO public.claim_note (claim_id, note, created_by_user_id)
     VALUES ($1,$2,$3) RETURNING note_id, created_at`,
    [id, req.body.note, actor.actorUserId ?? null],
  );
  res.status(201).json({ ok: true, ...rows[0] });
}));

export default router;
