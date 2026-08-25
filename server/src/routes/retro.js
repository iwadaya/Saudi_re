// server/src/routes/retro.js
//
// Retro module. Outwards retrocession programmes managed per underwriting
// year by the Retro Manager — programme CRUD + scope (classes of business /
// countries), retro-pack documents, and the coverage analysis that shows
// underwriters their inwards limits by country × class and whether a retro
// programme sits behind each cell.
//
// Access model:
//   • READ  — any authenticated user (underwriters consume the analysis).
//   • WRITE — the Retro Manager (RM) or executive tier (hierarchy ≤ 2:
//     CE / CU / CA). Enforced here via requireRetroManager, mirrored in the
//     client via GET /retro/permissions so the UI only renders the editor
//     for users the server will accept.

import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import multer from 'multer';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { withTransaction } from '../db/withTransaction.js';
import { validateBody } from '../lib/validate.js';
import { logAudit, resolveAuditActor } from '../services/audit.js';
import { logger } from '../lib/logger.js';
import {
  storeUploadedFile, deleteUploadedFile,
  isRemoteStoragePath, getSignedReadUrl, resolveLocalStoragePath,
} from '../lib/uploadStorage.js';
import { assertUploadSafe, ALLOWED_TYPES, UploadValidationError } from '../lib/uploadValidation.js';
import {
  retroProgrammeCreateSchema, retroProgrammeUpdateSchema, RETRO_STATUSES,
} from '../validation/retro.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the verified user may WRITE retro programmes. */
export function canManageRetro(user) {
  if (!user) return false;
  if (String(user.roleCode || '').toUpperCase() === 'RM') return true;
  return Number(user.hierarchyLevel) <= 2; // CE / CU / CA tier
}

function requireRetroManager(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
  if (canManageRetro(req.user)) return next();
  return res.status(403).json({
    error: 'Only the Retro Manager (or executive tier) can modify retro programmes.',
    code: 'RETRO_FORBIDDEN',
  });
}

// ── GET /api/retro/permissions ───────────────────────────────────────────────
// The client's UI gate — same predicate the write routes enforce.
router.get('/retro/permissions', asyncHandler(async (req, res) => {
  res.json({ can_manage: canManageRetro(req.user) });
}));

// ── Programme select (list + detail share this shape) ───────────────────────
const PROGRAMME_SELECT = `
  SELECT
    p.retro_programme_id, p.uw_year, p.programme_name, p.programme_type,
    p.status, p.reinsurer, p.currency_code,
    p.cession_pct, p.commission_pct,
    p.attachment, p.occurrence_limit, p.aggregate_limit,
    p.reinstatements, p.rol_pct, p.premium,
    p.inception_date, p.expiry_date,
    p.covers_all_classes, p.covers_all_countries,
    p.notes, p.created_at, p.updated_at,
    creator.display_name AS created_by_name,
    COALESCE(cls.classes, '[]'::json)     AS classes,
    COALESCE(ctry.countries, '[]'::json)  AS countries,
    COALESCE(pk.packs_count, 0)::int      AS packs_count
  FROM public.retro_programme p
  LEFT JOIN public.uw_user creator ON creator.user_id = p.created_by_user_id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'class_of_business_id', cob.class_of_business_id,
             'name', cob.class_of_business
           ) ORDER BY cob.class_of_business) AS classes
      FROM public.retro_programme_class pc
      JOIN public.class_of_business cob ON cob.class_of_business_id = pc.class_of_business_id
     WHERE pc.retro_programme_id = p.retro_programme_id
  ) cls ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'country_id', co.country_id,
             'name', co.country_name
           ) ORDER BY co.country_name) AS countries
      FROM public.retro_programme_country pcy
      JOIN public.country co ON co.country_id = pcy.country_id
     WHERE pcy.retro_programme_id = p.retro_programme_id
  ) ctry ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS packs_count
      FROM public.retro_pack_document d
     WHERE d.retro_programme_id = p.retro_programme_id
  ) pk ON true`;

// ── GET /api/retro/programmes?year=&status= ──────────────────────────────────
router.get('/retro/programmes', asyncHandler(async (req, res) => {
  const params = [];
  const where = [];
  const year = Number(req.query.year);
  if (Number.isInteger(year) && year >= 1990 && year <= 2100) {
    params.push(year);
    where.push(`p.uw_year = $${params.length}`);
  }
  const status = String(req.query.status || '').toUpperCase();
  if (RETRO_STATUSES.includes(status)) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  const { rows } = await pool.query(
    `${PROGRAMME_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.uw_year DESC, p.programme_name ASC
     LIMIT 500`, params);
  res.json(rows);
}));

// ── GET /api/retro/programmes/:id ────────────────────────────────────────────
router.get('/retro/programmes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Programme not found' });
  const [{ rows }, { rows: packs }] = await Promise.all([
    pool.query(`${PROGRAMME_SELECT} WHERE p.retro_programme_id = $1`, [id]),
    pool.query(
      `SELECT d.document_id, d.file_name, d.mime_type, d.size_bytes, d.title,
              d.description, d.uploaded_at, u.display_name AS uploaded_by_name
         FROM public.retro_pack_document d
         LEFT JOIN public.uw_user u ON u.user_id = d.uploaded_by_user_id
        WHERE d.retro_programme_id = $1
        ORDER BY d.uploaded_at DESC`, [id]),
  ]);
  if (!rows.length) return res.status(404).json({ error: 'Programme not found' });
  res.json({ ...rows[0], packs });
}));

/** Replace a programme's scope rows inside the caller's transaction. */
async function writeScope(client, programmeId, { classIds, countryIds }) {
  if (classIds) {
    await client.query('DELETE FROM public.retro_programme_class WHERE retro_programme_id=$1', [programmeId]);
    for (const cid of classIds) {
      await client.query(
        `INSERT INTO public.retro_programme_class (retro_programme_id, class_of_business_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`, [programmeId, cid]);
    }
  }
  if (countryIds) {
    await client.query('DELETE FROM public.retro_programme_country WHERE retro_programme_id=$1', [programmeId]);
    for (const cid of countryIds) {
      await client.query(
        `INSERT INTO public.retro_programme_country (retro_programme_id, country_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`, [programmeId, cid]);
    }
  }
}

const PROGRAMME_COLS = [
  'uw_year', 'programme_name', 'programme_type', 'status', 'reinsurer',
  'currency_code', 'cession_pct', 'commission_pct', 'attachment',
  'occurrence_limit', 'aggregate_limit', 'reinstatements', 'rol_pct',
  'premium', 'inception_date', 'expiry_date',
  'covers_all_classes', 'covers_all_countries', 'notes',
];

// ── POST /api/retro/programmes ───────────────────────────────────────────────
router.post('/retro/programmes',
  requireRetroManager,
  validateBody(retroProgrammeCreateSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const actor = await resolveAuditActor(req);
    try {
      const out = await withTransaction(async (client) => {
        const cols = PROGRAMME_COLS.filter((c) => b[c] !== undefined);
        const params = cols.map((c) => b[c]);
        params.push(actor.actorUserId ?? null);
        const { rows } = await client.query(
          `INSERT INTO public.retro_programme (${cols.join(',')}, created_by_user_id)
           VALUES (${params.map((_, i) => `$${i + 1}`).join(',')})
           RETURNING retro_programme_id, uw_year, programme_name`, params);
        const prog = rows[0];
        await writeScope(client, prog.retro_programme_id, {
          classIds: b.class_of_business_ids, countryIds: b.country_ids,
        });
        await logAudit(client, {
          entityType: 'RETRO_PROGRAMME', entityId: prog.retro_programme_id,
          eventType: 'RETRO_PROGRAMME_CREATED',
          actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
          payload: { uw_year: prog.uw_year, programme_name: prog.programme_name },
        });
        return prog;
      });
      res.status(201).json({ ok: true, ...out });
    } catch (e) {
      if (e?.code === '23505') {
        return res.status(409).json({
          error: `A programme named "${b.programme_name}" already exists for ${b.uw_year}.`,
          code: 'DUPLICATE_PROGRAMME',
        });
      }
      throw e;
    }
  }));

// ── PUT /api/retro/programmes/:id ────────────────────────────────────────────
router.put('/retro/programmes/:id',
  requireRetroManager,
  validateBody(retroProgrammeUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Programme not found' });
    const b = req.body;
    const actor = await resolveAuditActor(req);
    try {
      const out = await withTransaction(async (client) => {
        const sets = [];
        const params = [id];
        for (const c of PROGRAMME_COLS) {
          if (b[c] !== undefined) { params.push(b[c]); sets.push(`${c} = $${params.length}`); }
        }
        const touchingScope = b.class_of_business_ids !== undefined || b.country_ids !== undefined;
        if (!sets.length && !touchingScope) {
          const e = new Error('No updatable fields supplied'); e.status = 400; throw e;
        }
        const { rows } = await client.query(
          `UPDATE public.retro_programme
              SET ${[...sets, 'updated_at = now()'].join(', ')}
            WHERE retro_programme_id = $1
            RETURNING retro_programme_id, uw_year, programme_name`, params);
        if (!rows.length) { const e = new Error('Programme not found'); e.status = 404; throw e; }
        await writeScope(client, id, {
          classIds: b.class_of_business_ids, countryIds: b.country_ids,
        });
        await logAudit(client, {
          entityType: 'RETRO_PROGRAMME', entityId: id, eventType: 'RETRO_PROGRAMME_UPDATED',
          actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
          payload: { changed: Object.keys(b) },
        });
        return rows[0];
      });
      res.json({ ok: true, ...out });
    } catch (e) {
      if (e?.code === '23505') {
        return res.status(409).json({
          error: `A programme with that name already exists for that year.`,
          code: 'DUPLICATE_PROGRAMME',
        });
      }
      throw e;
    }
  }));

// ── DELETE /api/retro/programmes/:id ─────────────────────────────────────────
router.delete('/retro/programmes/:id', requireRetroManager, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Programme not found' });
  const actor = await resolveAuditActor(req);
  const { docs } = await withTransaction(async (client) => {
    const { rows: docRows } = await client.query(
      'SELECT storage_path FROM public.retro_pack_document WHERE retro_programme_id=$1', [id]);
    const { rows } = await client.query(
      `DELETE FROM public.retro_programme WHERE retro_programme_id=$1
       RETURNING retro_programme_id, uw_year, programme_name`, [id]);
    if (!rows.length) { const e = new Error('Programme not found'); e.status = 404; throw e; }
    await logAudit(client, {
      entityType: 'RETRO_PROGRAMME', entityId: id, eventType: 'RETRO_PROGRAMME_DELETED',
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { uw_year: rows[0].uw_year, programme_name: rows[0].programme_name },
    }, { critical: true });
    return { docs: docRows };
  });
  // Best-effort storage cleanup AFTER commit — a failure is a logged leak, not a 500.
  for (const d of docs) {
    deleteUploadedFile(d.storage_path || '').catch((err) => {
      logger.warn('[retro-pack] storage cleanup failed', { storagePath: d.storage_path, error: err?.message });
    });
  }
  res.json({ ok: true });
}));

// ── Retro packs (documents) ─────────────────────────────────────────────────
// Same upload pipeline as treaty/claim documents: extension pre-filter →
// memory buffer → content sniff + malware scan → shared storage sink.

function uploadFileFilter(_req, file, cb) {
  const ext = String(file?.originalname || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (!ALLOWED_TYPES[ext]) {
    cb(new UploadValidationError(
      415, 'UNSUPPORTED_FILE_TYPE',
      `File type ".${ext}" is not allowed. Accepted: ${Object.keys(ALLOWED_TYPES).join(', ')}.`,
    ));
    return;
  }
  cb(null, true);
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 50 * 1024 * 1024 },
  fileFilter: uploadFileFilter,
});

// POST /api/retro/programmes/:id/packs — attach a file to a programme.
router.post('/retro/programmes/:id/packs', requireRetroManager, upload.single('file'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Programme not found' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  const { rows: prog } = await pool.query(
    'SELECT retro_programme_id FROM public.retro_programme WHERE retro_programme_id=$1', [id]);
  if (!prog.length) return res.status(404).json({ error: 'Programme not found' });

  const safe = await assertUploadSafe(file);
  let storagePath;
  try {
    storagePath = await storeUploadedFile({ folder: `universe3/retro/${id}`, file });
  } catch (e) {
    if (e?.code === 'STORAGE_NOT_DURABLE') throw e;
    return res.status(502).json({ error: `Upload storage failed: ${e?.message || e}` });
  }
  const actor = await resolveAuditActor(req);
  const b = req.body || {};
  const { rows } = await pool.query(
    `INSERT INTO public.retro_pack_document
       (retro_programme_id, file_name, mime_type, size_bytes, storage_path, title, description, uploaded_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING document_id, file_name, mime_type, size_bytes, title, description, uploaded_at`,
    [id, file.originalname, safe.mime, file.size, storagePath,
      b.title || null, b.description || null, actor.actorUserId ?? null]);
  await logAudit(null, {
    entityType: 'RETRO_PROGRAMME', entityId: id, eventType: 'RETRO_PACK_UPLOADED',
    actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
    payload: { documentId: rows[0].document_id, fileName: file.originalname, sizeBytes: file.size },
  });
  res.status(201).json({ ok: true, ...rows[0] });
}));

async function loadRetroPack(docId) {
  if (!UUID_RE.test(docId)) return null;
  const { rows } = await pool.query(
    `SELECT document_id, retro_programme_id, file_name, mime_type, size_bytes, storage_path
       FROM public.retro_pack_document WHERE document_id=$1`, [docId]);
  return rows[0] || null;
}

async function serveRetroPack(req, res) {
  const doc = await loadRetroPack(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const sp = doc.storage_path || '';
  if (isRemoteStoragePath(sp)) {
    const signedUrl = await getSignedReadUrl(sp);
    if (!signedUrl) return res.status(502).json({ error: 'Document storage temporarily unavailable' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.redirect(signedUrl);
  }
  const fp = resolveLocalStoragePath(sp);
  let stat;
  try {
    stat = await fsp.stat(fp);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found on disk' });
    throw err;
  }
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.file_name)}"`);
  res.setHeader('Content-Length', doc.size_bytes || stat.size);
  fs.createReadStream(fp).pipe(res);
}

router.get('/retro/packs/:docId/download', asyncHandler(serveRetroPack));
router.get('/retro/packs/:docId/view', asyncHandler(serveRetroPack));

// DELETE /api/retro/packs/:docId
router.delete('/retro/packs/:docId', requireRetroManager, asyncHandler(async (req, res) => {
  const doc = await loadRetroPack(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const actor = await resolveAuditActor(req);
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM public.retro_pack_document WHERE document_id=$1', [doc.document_id]);
    if (!rowCount) { const e = new Error('Document not found'); e.status = 404; throw e; }
    await logAudit(client, {
      entityType: 'RETRO_PROGRAMME', entityId: doc.retro_programme_id, eventType: 'RETRO_PACK_DELETED',
      actor: { id: actor.actorUserId, name: actor.actorName, role: actor.actorRole },
      payload: { documentId: doc.document_id, fileName: doc.file_name },
    }, { critical: true });
  });
  deleteUploadedFile(doc.storage_path || '').catch((err) => {
    logger.warn('[retro-pack/delete] storage cleanup failed', { storagePath: doc.storage_path, error: err?.message });
  });
  res.json({ ok: true });
}));

// ── GET /api/retro/coverage?year= ────────────────────────────────────────────
// The analysis grid: for each (country × class of business) cell of the
// inwards book in that UW year — contract count, 100% limit, our signed
// exposure — with the retro programmes protecting the cell and their
// aggregate outwards limit. `has_retro` is the underwriter's one-glance
// answer. A programme protects a cell when (covers_all_classes OR the class
// is in its scope) AND (covers_all_countries OR the country is in its scope);
// only DRAFT/EXPIRED/CANCELLED programmes are excluded (status = 'ACTIVE').
router.get('/retro/coverage', asyncHandler(async (req, res) => {
  const yearRaw = Number(req.query.year);
  const year = Number.isInteger(yearRaw) && yearRaw >= 1990 && yearRaw <= 2100
    ? yearRaw : new Date().getFullYear();

  const [{ rows: cells }, { rows: programmes }] = await Promise.all([
    // Inwards exposure per (country, class). Multi-class treaties contribute
    // their full limit to each of their classes — the grid answers "where do
    // we write and how much", not an additive allocation.
    pool.query(`
      WITH inward AS (
        SELECT
          c.contract_id,
          c.country_id,
          COALESCE(ccb.class_of_business_id, c.primary_class_of_business_id) AS class_of_business_id,
          COALESCE(c.signed_line_pct, 0) AS signed_line_pct,
          COALESCE(pd.total_capacity, np.total_limit, 0) AS limit_100
        FROM public.contract c
        LEFT JOIN public.contract_class_of_business ccb ON ccb.contract_id = c.contract_id
        LEFT JOIN LATERAL (
          SELECT d.total_capacity
            FROM public.contract_prop_details d
           WHERE d.contract_id = c.contract_id
           ORDER BY d.updated_at DESC NULLS LAST
           LIMIT 1
        ) pd ON true
        LEFT JOIN LATERAL (
          SELECT SUM(l.layer_limit) AS total_limit
            FROM public.contract_np_layers l
           WHERE l.contract_id = c.contract_id
        ) np ON true
        WHERE c.uw_year = $1
          AND c.status NOT IN ('DECLINED','NTU','CANCELLED')
      )
      SELECT
        i.country_id,
        co.country_name,
        i.class_of_business_id,
        cob.class_of_business AS class_name,
        COUNT(DISTINCT i.contract_id)::int AS contract_count,
        COALESCE(SUM(i.limit_100), 0)::numeric(20,2) AS gross_limit_100,
        COALESCE(SUM(i.limit_100 * i.signed_line_pct / 100.0), 0)::numeric(20,2) AS signed_exposure
      FROM inward i
      LEFT JOIN public.country co            ON co.country_id = i.country_id
      LEFT JOIN public.class_of_business cob ON cob.class_of_business_id = i.class_of_business_id
      GROUP BY i.country_id, co.country_name, i.class_of_business_id, cob.class_of_business
      ORDER BY co.country_name NULLS LAST, cob.class_of_business NULLS LAST`, [year]),
    // Active programmes for the year with their scope sets.
    pool.query(`
      SELECT
        p.retro_programme_id, p.programme_name, p.programme_type, p.status,
        p.currency_code, p.cession_pct, p.attachment, p.occurrence_limit,
        p.aggregate_limit, p.covers_all_classes, p.covers_all_countries,
        COALESCE(ARRAY(
          SELECT pc.class_of_business_id FROM public.retro_programme_class pc
           WHERE pc.retro_programme_id = p.retro_programme_id), '{}') AS class_ids,
        COALESCE(ARRAY(
          SELECT pcy.country_id FROM public.retro_programme_country pcy
           WHERE pcy.retro_programme_id = p.retro_programme_id), '{}') AS country_ids
      FROM public.retro_programme p
      WHERE p.uw_year = $1 AND p.status = 'ACTIVE'
      ORDER BY p.programme_name`, [year]),
  ]);

  const covers = (prog, cell) => {
    const classOk = prog.covers_all_classes
      || (cell.class_of_business_id && prog.class_ids.includes(cell.class_of_business_id));
    const countryOk = prog.covers_all_countries
      || (cell.country_id && prog.country_ids.includes(cell.country_id));
    return classOk && countryOk;
  };

  const out = cells.map((cell) => {
    const matching = programmes.filter((p) => covers(p, cell));
    const retroLimit = matching.reduce(
      (s, p) => s + Number(p.occurrence_limit || 0), 0);
    return {
      ...cell,
      gross_limit_100: Number(cell.gross_limit_100),
      signed_exposure: Number(cell.signed_exposure),
      has_retro: matching.length > 0,
      retro_limit: retroLimit,
      programmes: matching.map((p) => ({
        retro_programme_id: p.retro_programme_id,
        programme_name: p.programme_name,
        programme_type: p.programme_type,
        occurrence_limit: p.occurrence_limit == null ? null : Number(p.occurrence_limit),
        cession_pct: p.cession_pct == null ? null : Number(p.cession_pct),
      })),
    };
  });

  res.json({
    year,
    cells: out,
    programme_count: programmes.length,
  });
}));

// ── GET /api/retro/summary?year= ─────────────────────────────────────────────
router.get('/retro/summary', asyncHandler(async (req, res) => {
  const yearRaw = Number(req.query.year);
  const year = Number.isInteger(yearRaw) && yearRaw >= 1990 && yearRaw <= 2100
    ? yearRaw : new Date().getFullYear();
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int                                                  AS total_programmes,
      COUNT(*) FILTER (WHERE status = 'ACTIVE')::int                 AS active,
      COUNT(*) FILTER (WHERE status = 'DRAFT')::int                  AS draft,
      COALESCE(SUM(occurrence_limit) FILTER (WHERE status = 'ACTIVE'), 0)::numeric(20,2) AS active_occurrence_limit,
      COALESCE(SUM(premium)          FILTER (WHERE status = 'ACTIVE'), 0)::numeric(20,2) AS active_premium
    FROM public.retro_programme
    WHERE uw_year = $1`, [year]);
  res.json({ year, ...rows[0] });
}));

// ── GET /api/retro/applicable?contract_id=|quote_id= ─────────────────────────
// The stored programmes that actually protect one inwards treaty (or quote):
// ACTIVE programmes for the entity's UW year whose scope covers its country
// and at least one of its classes of business (covers_all_* short-circuits).
// This is what seeds the offer modals' Retro Impact view, so the same
// matching rule as /retro/coverage applies — an entity with no recorded
// class/country only matches covers-all programmes.
router.get('/retro/applicable', asyncHandler(async (req, res) => {
  const contractId = String(req.query.contract_id || '');
  const quoteId = String(req.query.quote_id || '');
  let subject = null;
  if (UUID_RE.test(contractId)) {
    const { rows } = await pool.query(`
      SELECT c.uw_year, c.country_id,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT ccb.class_of_business_id)
                          || c.primary_class_of_business_id, NULL) AS class_ids
        FROM public.contract c
        LEFT JOIN public.contract_class_of_business ccb ON ccb.contract_id = c.contract_id
       WHERE c.contract_id = $1
       GROUP BY c.contract_id`, [contractId]);
    subject = rows[0] || null;
  } else if (UUID_RE.test(quoteId)) {
    const { rows } = await pool.query(`
      SELECT q.uw_year, q.country_id,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT qcb.class_of_business_id)
                          || q.primary_class_of_business_id, NULL) AS class_ids
        FROM public.quote q
        LEFT JOIN public.quote_class_of_business qcb ON qcb.quote_id = q.quote_id
       WHERE q.quote_id = $1
       GROUP BY q.quote_id`, [quoteId]);
    subject = rows[0] || null;
  } else {
    return res.status(400).json({ error: 'Pass contract_id or quote_id.', code: 'BAD_REQUEST' });
  }
  if (!subject) return res.status(404).json({ error: 'Treaty not found' });

  const { rows: programmes } = await pool.query(`
    SELECT p.retro_programme_id, p.programme_name, p.programme_type, p.status,
           p.reinsurer, p.currency_code, p.cession_pct, p.commission_pct,
           p.attachment, p.occurrence_limit, p.aggregate_limit,
           p.reinstatements, p.rol_pct, p.premium,
           p.covers_all_classes, p.covers_all_countries
      FROM public.retro_programme p
     WHERE p.uw_year = $1 AND p.status = 'ACTIVE'
       AND (p.covers_all_classes OR EXISTS (
              SELECT 1 FROM public.retro_programme_class pc
               WHERE pc.retro_programme_id = p.retro_programme_id
                 AND pc.class_of_business_id = ANY($2::uuid[])))
       AND (p.covers_all_countries OR ($3::uuid IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.retro_programme_country pcy
               WHERE pcy.retro_programme_id = p.retro_programme_id
                 AND pcy.country_id = $3)))
     ORDER BY p.programme_type, p.programme_name`,
  [subject.uw_year, subject.class_ids || [], subject.country_id]);

  res.json({ uw_year: subject.uw_year, programmes });
}));

export default router;
